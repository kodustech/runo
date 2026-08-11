import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGENT_ENV_PATH, RUNO_HOME, REMOTE_RUNO_DIR, TMP_DIR, remoteRepoDir } from "./config";
import { requireAgentEnv } from "./agentAuth";
import { RunoError } from "./errors";
import { fmtDuration, log } from "./log";
import { getProvider } from "./provider";
import type { Runtime } from "./provider/types";
import { registry, urlsFor, type EnvRecord } from "./registry";
import { parseRecipe } from "./recipe";
import { shq } from "./ssh";
import {
  buildContext,
  contextFromEnv,
  currentBranch,
  repoTop,
  resolveEnv,
  worktreePathFor,
  type EnvContext,
} from "./engine/context";
import { inferRecipe } from "./engine/infer";
import { composePrefix } from "./engine/services";
import { resumeEnv, upEnv } from "./engine/up";
import { validateEnv } from "./engine/validate";
import { ensureWorktree, removeWorktree } from "./engine/worktree";
import { slugify } from "./config";

const USAGE = `runo — ambiente remoto por branch (AWS EC2)

Uso: runo <comando> [args]

  init [--force]              gera .kodus/workspace.yaml proposto para o repo
  new <nome>                  cria branch task/<nome> + ambiente remoto (runo up)
  up [--branch B]             materializa/retoma o ambiente da branch (idempotente)
  agent <claude|codex> [...]  sessão do agente NA VM (auth injetada, cwd no repo)
  validate [step]             roda validate: na VM e baixa evidência JSON+MD
  pull                        traz mudanças da VM para o worktree local (rsync)
  push [--restart]            sobe mudanças do worktree local para a VM (rsync);
                              --restart religa os serviços run: (hot-reload dos
                              compose dev com watch não precisa)
  url [--open]                imprime/abre a URL pública do serviço public
  logs [serviço] [-f]         logs remotos por serviço
  exec -- <cmd...>            comando arbitrário na VM (cwd no repo)
  ls                          lista os ambientes (estado, URL, uptime, instância)
  suspend | resume            para/retoma a instância (parada não cobra compute)
  bake [--rm]                 assa uma imagem base com o provisionamento pronto —
                              runo up seguintes bootam em ~1-2min (--rm remove)
  pool [n]                    warm pool: n instâncias provisionadas e PARADAS
                              (custam só EBS); runo new reivindica delas (~40s).
                              Sem argumento mostra o estado; 0 drena o pool
  destroy [--all]             termina a instância, remove worktree e registry

RUNO_HOME=${RUNO_HOME}`;

interface Flags {
  branch?: string;
  force: boolean;
  all: boolean;
  open: boolean;
  follow: boolean;
  restart: boolean;
  rm: boolean;
  positional: string[];
  passthrough: string[]; // depois de --
}

function parseFlags(args: string[]): Flags {
  const f: Flags = {
    force: false,
    all: false,
    open: false,
    follow: false,
    restart: false,
    rm: false,
    positional: [],
    passthrough: [],
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "--") {
      f.passthrough = args.slice(i + 1);
      break;
    } else if (a === "--branch" || a === "-b") {
      f.branch = args[++i];
      if (!f.branch) throw new RunoError("--branch exige um valor");
    } else if (a === "--force") f.force = true;
    else if (a === "--restart") f.restart = true;
    else if (a === "--rm") f.rm = true;
    else if (a === "--all") f.all = true;
    else if (a === "--open") f.open = true;
    else if (a === "-f" || a === "--follow") f.follow = true;
    else f.positional.push(a);
    i++;
  }
  return f;
}

function requireRepo(): string {
  const top = repoTop(process.cwd());
  if (!top)
    throw new RunoError("Este comando precisa rodar dentro de um repositório git");
  return top;
}

async function runningRuntime(env: EnvRecord): Promise<Runtime> {
  const provider = getProvider(env.provider);
  const rt = await provider.status(env.runtime as unknown as Runtime);
  if (rt.state !== "running" || !rt.ip)
    throw new RunoError(
      `Ambiente ${env.name} não está rodando (estado: ${rt.state})`,
      rt.state === "stopped" ? "Rode `runo resume`" : "Rode `runo up`",
    );
  registry.patch(env.name, { runtime: rt as unknown as Record<string, unknown>, state: "running" });
  return rt;
}

// ---------------- comandos ----------------

async function cmdInit(flags: Flags): Promise<void> {
  const repo = requireRepo();
  const dest = path.join(repo, ".kodus", "workspace.yaml");
  if (existsSync(dest) && !flags.force)
    throw new RunoError(`${dest} já existe`, "Use `runo init --force` para sobrescrever");
  const { yaml, notes } = inferRecipe(repo);
  parseRecipe(yaml, "proposta do runo init"); // garante que a proposta é uma recipe válida
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, yaml);
  log.ok(`recipe proposta em ${dest}`);
  for (const n of notes) log.warn(n);
  log.info("Revise a recipe e rode `runo new <nome>` para materializar um ambiente.");
}

async function cmdNew(flags: Flags): Promise<void> {
  const name = flags.positional[0];
  if (!name) throw new RunoError("Uso: runo new <nome>", "Ex.: runo new checkout-fix");
  const repo = requireRepo();
  const branch = `task/${name}`;
  const slug = slugify(branch);
  const worktree = worktreePathFor(path.basename(repo), slug);
  log.step(`criando branch ${branch} + worktree ${worktree}`);
  ensureWorktree(repo, branch, worktree, { createBranch: true });
  const ctx = buildContext(repo, branch);
  await upEnv(ctx);
  log.info(`worktree local: ${ctx.worktree}`);
}

async function cmdUp(flags: Flags): Promise<void> {
  const byCwd = registry.findByCwd(process.cwd());
  let ctx: EnvContext;
  if (byCwd && !flags.branch) {
    ctx = contextFromEnv(byCwd);
  } else {
    const repo = requireRepo();
    const branch = flags.branch ?? currentBranch(repo);
    const existing = registry.findByRepoBranch(repo, branch);
    if (existing) ctx = contextFromEnv(existing);
    else {
      ensureWorktree(repo, branch, worktreePathFor(path.basename(repo), slugify(branch)));
      ctx = buildContext(repo, branch);
    }
  }
  await upEnv(ctx);
}

async function cmdAgent(flags: Flags): Promise<void> {
  const agent = flags.positional[0];
  if (agent !== "claude" && agent !== "codex")
    throw new RunoError("Uso: runo agent <claude|codex> [args...]");
  const env = resolveEnv({ branch: flags.branch });
  const rt = await runningRuntime(env);
  const provider = getProvider(env.provider);
  const keys = requireAgentEnv(agent);

  // chaves viajam por arquivo 600 (nunca por argv/log — decisão 10)
  mkdirSync(TMP_DIR, { recursive: true });
  const tmpEnv = path.join(TMP_DIR, `agent-${Date.now()}.env`);
  writeFileSync(tmpEnv, Object.entries(keys).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", {
    mode: 0o600,
  });
  try {
    await provider.upload(rt, tmpEnv, `${REMOTE_RUNO_DIR}/agent.env`);
    await provider.exec(rt, `chmod 600 ${REMOTE_RUNO_DIR}/agent.env`);
  } finally {
    rmSync(tmpEnv, { force: true });
  }

  const extra = [...flags.positional.slice(1), ...flags.passthrough].map(shq).join(" ");
  const remoteDir = remoteRepoDir(env.repo);
  const inner = `set -a; . ${REMOTE_RUNO_DIR}/agent.env; set +a; cd ${shq(remoteDir)} && exec ${agent} ${extra}`.trim();

  let code: number;
  if (process.stdin.isTTY) {
    // Sessão tmux na VM: detach (Ctrl+B D / laptop fechado) NÃO mata o agente;
    // `runo agent` de novo reatacha na mesma sessão, com scrollback.
    const session = `runo-agent-${agent}`;
    log.step(`abrindo ${agent} na VM (${rt.ip}) em tmux "${session}" — Ctrl+B D solta a sessão sem matar o agente; \`runo agent ${agent}\` reatacha`);
    code = await provider.execInteractive(
      rt,
      `tmux new-session -A -s ${session} ${shq(`bash -lc ${shq(inner)}`)}`,
    );
  } else {
    // Sem TTY local (uso headless, ex.: `runo agent claude -- -p "..."`): exec direto.
    log.step(`abrindo ${agent} na VM (${rt.ip}) — cwd ${remoteDir}`);
    code = await provider.execInteractive(rt, inner);
  }
  process.exit(code);
}

async function cmdValidate(flags: Flags): Promise<void> {
  const env = resolveEnv({ branch: flags.branch });
  const ctx = contextFromEnv(env);
  const evidence = await validateEnv(ctx, flags.positional[0]);
  if (evidence.status !== "passed") {
    log.error(`validação FALHOU (${evidence.steps.filter((s) => s.status === "failed").length} step(s))`);
    process.exit(1);
  }
  log.ok("validação passou");
}

async function cmdPull(flags: Flags): Promise<void> {
  const env = resolveEnv({ branch: flags.branch });
  const rt = await runningRuntime(env);
  const provider = getProvider(env.provider);
  log.step(`rsync VM → worktree (${env.worktree})`);
  await provider.download(rt, `${remoteRepoDir(env.repo)}/`, `${env.worktree}/`, [
    ".git",
    "node_modules",
    "dist",
    ".kodus",
  ]);
  const st = Bun.spawnSync(["git", "-C", env.worktree, "status", "--short"], { stdout: "pipe" });
  const out = st.stdout.toString().trim();
  log.ok("pull concluído — mudanças no worktree local:");
  console.log(out || "  (nenhuma diferença)");
  log.info("Commit/push acontecem DAQUI — zero credencial Git na nuvem.");
}

async function cmdPush(flags: Flags): Promise<void> {
  const env = resolveEnv({ branch: flags.branch });
  const rt = await runningRuntime(env);
  const provider = getProvider(env.provider);
  log.step(`rsync worktree → VM (${remoteRepoDir(env.repo)})`);
  await provider.uploadDir(rt, `${env.worktree}/`, `${remoteRepoDir(env.repo)}/`, [
    ".git",
    "node_modules",
    "dist",
    ".kodus",
  ]);
  if (flags.restart) {
    const ctx = contextFromEnv(env);
    log.step("religando serviços…");
    const { startServices } = await import("./engine/services");
    await startServices(provider, rt, ctx.recipe, remoteRepoDir(env.repo));
  }
  log.ok(
    `push concluído${flags.restart ? " (serviços religados)" : " — compose dev com watch recarrega sozinho; use --restart para serviços run:"}`,
  );
}

async function cmdUrl(flags: Flags): Promise<void> {
  const env = resolveEnv({ branch: flags.branch });
  const provider = getProvider(env.provider);
  const rt = await provider.status(env.runtime as unknown as Runtime);
  if (!rt.ip)
    throw new RunoError(`Ambiente ${env.name} sem IP (estado: ${rt.state})`, "Rode `runo resume`");
  registry.patch(env.name, { runtime: rt as unknown as Record<string, unknown> });
  const urls = Object.values(urlsFor(env, rt.ip));
  if (urls.length === 0)
    throw new RunoError("Nenhum serviço public neste env", "Marque `public: true` (ou `public: <serviço>`) na recipe e rode `runo up`");
  for (const u of urls) console.log(u);
  if (flags.open && urls[0]) Bun.spawn(["open", urls[0]]);
}

async function cmdLogs(flags: Flags): Promise<void> {
  const env = resolveEnv({ branch: flags.branch });
  const ctx = contextFromEnv(env);
  const rt = await runningRuntime(env);
  const provider = getProvider(env.provider);
  const svc = flags.positional[0];
  const follow = flags.follow;
  const remoteDir = remoteRepoDir(env.repo);

  let cmd: string;
  if (ctx.recipe.mode === "compose") {
    cmd = `${composePrefix(ctx.recipe)} logs --tail=200 ${follow ? "-f " : ""}${svc ? shq(svc) : ""}`;
  } else if (svc) {
    const def = ctx.recipe.services[svc];
    if (!def)
      throw new RunoError(`Serviço "${svc}" não existe na recipe`, `Serviços: ${Object.keys(ctx.recipe.services).join(", ")}`);
    cmd = def.run
      ? `tail -n 200 ${follow ? "-f " : ""}${REMOTE_RUNO_DIR}/logs/${svc}.log`
      : `docker logs --tail 200 ${follow ? "-f " : ""}runo-${svc}`;
  } else {
    const runLogs = Object.entries(ctx.recipe.services).filter(([, s]) => s.run);
    const imageSvcs = Object.entries(ctx.recipe.services).filter(([, s]) => s.image);
    const parts: string[] = [];
    if (imageSvcs.length)
      parts.push(`docker compose -p runo -f ${REMOTE_RUNO_DIR}/compose.yaml logs --tail=100`);
    if (runLogs.length) parts.push(`tail -n 100 ${follow ? "-f " : ""}${REMOTE_RUNO_DIR}/logs/*.log`);
    cmd = parts.join(" ; ") || "echo 'nenhum serviço na recipe'";
  }
  const code = await provider.logs(rt, cmd, { cwd: remoteDir });
  process.exit(code);
}

async function cmdExec(flags: Flags): Promise<void> {
  if (flags.passthrough.length === 0)
    throw new RunoError("Uso: runo exec -- <comando...>", "Ex.: runo exec -- docker ps");
  const env = resolveEnv({ branch: flags.branch });
  const rt = await runningRuntime(env);
  const provider = getProvider(env.provider);
  const code = await provider.execInteractive(rt, flags.passthrough.join(" "), {
    cwd: remoteRepoDir(env.repo),
  });
  process.exit(code);
}

function fmtUptime(launchedAt?: string): string {
  if (!launchedAt) return "-";
  const ms = Date.now() - new Date(launchedAt).getTime();
  return fmtDuration(ms);
}

async function cmdLs(): Promise<void> {
  const envs = registry.list();
  if (envs.length === 0) {
    log.info("nenhum ambiente — crie um com `runo new <nome>`");
    return;
  }
  const provider = getProvider("aws");
  const rows: string[][] = [["ENV", "BRANCH", "ESTADO", "URL", "UPTIME", "INSTÂNCIA"]];
  const statuses = await Promise.all(
    envs.map(async (e) => {
      if (!(e.runtime as any)?.id) return { e, rt: null as Runtime | null };
      try {
        return { e, rt: await provider.status(e.runtime as unknown as Runtime) };
      } catch {
        return { e, rt: null as Runtime | null };
      }
    }),
  );
  for (const { e, rt } of statuses) {
    if (rt) {
      registry.patch(e.name, {
        runtime: rt as unknown as Record<string, unknown>,
        state: rt.state === "running" ? "running" : rt.state === "stopped" ? "stopped" : e.state,
      });
    }
    const url = rt?.ip ? Object.values(urlsFor(e, rt.ip))[0] ?? "-" : "-";
    rows.push([
      e.name,
      e.branch,
      rt?.state ?? e.state,
      url,
      rt?.state === "running" ? fmtUptime(rt.launchedAt) : "-",
      (rt?.instanceType ?? "-") + (rt?.lifecycle === "spot" ? " (spot)" : ""),
    ]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const r of rows) console.log(r.map((cell, i) => cell.padEnd(widths[i]!)).join("  "));
}

async function cmdSuspend(flags: Flags): Promise<void> {
  const env = resolveEnv({ branch: flags.branch });
  const provider = getProvider(env.provider);
  log.step(`parando instância de ${env.name} (parada = paga só EBS)…`);
  const rt = await provider.suspend(env.runtime as unknown as Runtime);
  registry.patch(env.name, { runtime: rt as unknown as Record<string, unknown>, state: "stopped" });
  log.ok(`${env.name} suspenso — retome com \`runo resume\` (o IP público vai mudar)`);
}

async function cmdResume(flags: Flags): Promise<void> {
  const env = resolveEnv({ branch: flags.branch });
  await resumeEnv(contextFromEnv(env));
}

async function destroyOne(env: EnvRecord): Promise<void> {
  const provider = getProvider(env.provider);
  if ((env.runtime as any)?.id) {
    log.step(`terminando instância de ${env.name}…`);
    await provider.destroy(env.runtime as unknown as Runtime);
  }
  removeWorktree(env.repoPath, env.worktree);
  registry.remove(env.name);
  log.ok(`${env.name} destruído (instância + worktree + registry)`);
}

async function cmdBake(flags: Flags): Promise<void> {
  const provider = getProvider("aws");
  await provider.preflight();
  if (flags.rm) {
    await provider.removeBootImage();
    return;
  }
  log.step("assando imagem base (~10-12min; uma vez só — vale por todos os envs desta instalação)…");
  const imageId = await provider.prepareBootImage();
  log.ok(`imagem base pronta: ${imageId} — próximos runo up bootam em ~1-2min`);
}

async function cmdPool(flags: Flags): Promise<void> {
  const provider = getProvider("aws");
  await provider.preflight();
  const arg = flags.positional[0];
  if (arg === undefined) {
    const pool = await provider.poolStatus();
    if (pool.length === 0) {
      log.info("warm pool vazio — crie com `runo pool <n>` (instância parada custa só EBS, ~US$3/mês)");
      return;
    }
    for (const p of pool) console.log(`${p.id}  ${p.state}  ${p.instanceType ?? "-"}`);
    return;
  }
  const target = Number(arg);
  if (!Number.isInteger(target)) throw new RunoError("Uso: runo pool [n]", "Ex.: runo pool 2 (ou 0 para drenar)");
  await provider.poolScale(target);
  log.ok(`warm pool ajustado para ${target} instância(s)`);
}

async function cmdDestroy(flags: Flags): Promise<void> {
  if (flags.all) {
    const envs = registry.list();
    for (const env of envs) await destroyOne(env);
    const provider = getProvider("aws");
    await provider.preflight();
    const leftover = await provider.listManaged();
    for (const rt of leftover) {
      log.warn(`instância runo fora do registry: ${rt.name ?? rt.id} — terminando`);
      await provider.destroy(rt);
    }
    await provider.cleanupShared();
    log.ok("runo destroy --all: instâncias, keypair e security group removidos");
    return;
  }
  const env = resolveEnv({ branch: flags.branch });
  await destroyOne(env);
}

// ---------------- dispatch ----------------

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  try {
    const flags = parseFlags(rest);
    switch (cmd) {
      case "init": return await cmdInit(flags);
      case "new": return await cmdNew(flags);
      case "up": return await cmdUp(flags);
      case "agent": return await cmdAgent(flags);
      case "validate": return await cmdValidate(flags);
      case "pull": return await cmdPull(flags);
      case "push": return await cmdPush(flags);
      case "url": return await cmdUrl(flags);
      case "logs": return await cmdLogs(flags);
      case "exec": return await cmdExec(flags);
      case "ls": return await cmdLs();
      case "suspend": return await cmdSuspend(flags);
      case "resume": return await cmdResume(flags);
      case "bake": return await cmdBake(flags);
      case "pool": return await cmdPool(flags);
      case "destroy": return await cmdDestroy(flags);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        console.log(USAGE);
        return;
      default:
        throw new RunoError(`Comando desconhecido: ${cmd}`, "Veja `runo help`");
    }
  } catch (e) {
    if (e instanceof RunoError) {
      log.error(e.message);
      if (e.hint) log.info(`→ ${e.hint}`);
      process.exit(1);
    }
    log.error((e as Error)?.message ?? String(e));
    if (process.env.RUNO_DEBUG) console.error(e);
    else log.dim("(rode com RUNO_DEBUG=1 para ver o stack trace)");
    process.exit(1);
  }
}

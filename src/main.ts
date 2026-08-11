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
  buildContextHere,
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

const USAGE = `runo — one remote environment per branch (AWS EC2)

Usage: runo <command> [args]

  init [--force]              inspects the repo and proposes .kodus/workspace.yaml
  new <name>                  creates branch task/<name> + remote env (runo up)
  up [--branch B] [--here]    materializes/resumes the branch's env (idempotent);
                              --here uses the CURRENT working tree as the sync
                              anchor (for Orca/worktree tools — runo won't
                              create nor ever remove it)
  agent <claude|codex> [...]  agent session ON the VM (auth injected, cwd in repo)
  validate [step]             runs validate: on the VM, downloads JSON+MD evidence
  pull                        brings VM changes back to the local worktree (rsync)
  push [--restart]            pushes local worktree changes to the VM (rsync);
                              --restart restarts run: services (compose dev with
                              watch reloads by itself)
  url [--open]                prints/opens the public URL of the public service
  logs [service] [-f]         remote logs per service
  exec -- <cmd...>            arbitrary command on the VM (cwd in repo)
  ls                          lists environments (state, URL, uptime, instance)
  suspend | resume            stop/start the instance (stopped costs no compute)
  bake [--rm]                 bakes a base image with provisioning done —
                              subsequent runo up boot in ~1-2min (--rm removes)
  pool [n]                    warm pool: n provisioned, STOPPED instances
                              (EBS-only cost); runo new claims from it (~40s).
                              No argument shows status; 0 drains the pool
  destroy [--all]             terminates the instance, removes worktree and registry

RUNO_HOME=${RUNO_HOME}`;

interface Flags {
  branch?: string;
  force: boolean;
  all: boolean;
  open: boolean;
  follow: boolean;
  restart: boolean;
  rm: boolean;
  here: boolean;
  positional: string[];
  passthrough: string[]; // after --
}

function parseFlags(args: string[]): Flags {
  const f: Flags = {
    force: false,
    all: false,
    open: false,
    follow: false,
    restart: false,
    rm: false,
    here: false,
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
      if (!f.branch) throw new RunoError("--branch requires a value");
    } else if (a === "--force") f.force = true;
    else if (a === "--restart") f.restart = true;
    else if (a === "--rm") f.rm = true;
    else if (a === "--here") f.here = true;
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
    throw new RunoError("This command must run inside a git repository");
  return top;
}

async function runningRuntime(env: EnvRecord): Promise<Runtime> {
  const provider = getProvider(env.provider);
  const rt = await provider.status(env.runtime as unknown as Runtime);
  if (rt.state !== "running" || !rt.ip)
    throw new RunoError(
      `Environment ${env.name} is not running (state: ${rt.state})`,
      rt.state === "stopped" ? "Run `runo resume`" : "Run `runo up`",
    );
  registry.patch(env.name, { runtime: rt as unknown as Record<string, unknown>, state: "running" });
  return rt;
}

// ---------------- commands ----------------

async function cmdInit(flags: Flags): Promise<void> {
  const repo = requireRepo();
  const dest = path.join(repo, ".kodus", "workspace.yaml");
  if (existsSync(dest) && !flags.force)
    throw new RunoError(`${dest} already exists`, "Use `runo init --force` to overwrite");
  const { yaml, notes } = inferRecipe(repo);
  parseRecipe(yaml, "runo init proposal"); // guarantees the proposal is a valid recipe
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, yaml);
  log.ok(`recipe proposed at ${dest}`);
  for (const n of notes) log.warn(n);
  log.info("Review the recipe and run `runo new <name>` to materialize an environment.");
}

async function cmdNew(flags: Flags): Promise<void> {
  const name = flags.positional[0];
  if (!name) throw new RunoError("Usage: runo new <name>", "E.g.: runo new checkout-fix");
  const repo = requireRepo();
  const branch = `task/${name}`;
  const slug = slugify(branch);
  const worktree = worktreePathFor(path.basename(repo), slug);
  log.step(`creating branch ${branch} + worktree ${worktree}`);
  ensureWorktree(repo, branch, worktree, { createBranch: true });
  const ctx = buildContext(repo, branch);
  await upEnv(ctx);
  log.info(`local worktree: ${ctx.worktree}`);
}

async function cmdUp(flags: Flags): Promise<void> {
  const byCwd = registry.findByCwd(process.cwd());
  let ctx: EnvContext;
  if (flags.here) {
    // the current working tree (e.g. an Orca worktree) IS the sync anchor
    const repo = requireRepo();
    const branch = currentBranch(repo);
    const existing = registry.findByRepoBranch(repo, branch);
    ctx = existing ? contextFromEnv(existing) : buildContextHere(repo, branch);
  } else if (byCwd && !flags.branch) {
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
    throw new RunoError("Usage: runo agent <claude|codex> [args...]");
  const env = resolveEnv({ branch: flags.branch });
  const rt = await runningRuntime(env);
  const provider = getProvider(env.provider);
  const keys = requireAgentEnv(agent);

  // credentials travel via a 600 file (never via argv/logs)
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
    // tmux session on the VM: detach (Ctrl+B D / closed laptop) does NOT kill
    // the agent; running `runo agent` again reattaches, with scrollback.
    const session = `runo-agent-${agent}`;
    log.step(`opening ${agent} on the VM (${rt.ip}) in tmux "${session}" — Ctrl+B D detaches without killing the agent; \`runo agent ${agent}\` reattaches`);
    code = await provider.execInteractive(
      rt,
      `tmux new-session -A -s ${session} ${shq(`bash -lc ${shq(inner)}`)}`,
    );
  } else {
    // no local TTY (headless use, e.g. `runo agent claude -- -p "..."`): direct exec
    log.step(`opening ${agent} on the VM (${rt.ip}) — cwd ${remoteDir}`);
    code = await provider.execInteractive(rt, inner);
  }
  process.exit(code);
}

async function cmdValidate(flags: Flags): Promise<void> {
  const env = resolveEnv({ branch: flags.branch });
  const ctx = contextFromEnv(env);
  const evidence = await validateEnv(ctx, flags.positional[0]);
  if (evidence.status !== "passed") {
    log.error(`validation FAILED (${evidence.steps.filter((s) => s.status === "failed").length} step(s))`);
    process.exit(1);
  }
  log.ok("validation passed");
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
  log.ok("pull complete — changes in the local worktree:");
  console.log(out || "  (no differences)");
  log.info("Commit/push happen FROM HERE — zero git credentials in the cloud.");
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
    log.step("restarting services…");
    const { startServices } = await import("./engine/services");
    await startServices(provider, rt, ctx.recipe, remoteRepoDir(env.repo));
  }
  log.ok(
    `push complete${flags.restart ? " (services restarted)" : " — compose dev with watch reloads by itself; use --restart for run: services"}`,
  );
}

async function cmdUrl(flags: Flags): Promise<void> {
  const env = resolveEnv({ branch: flags.branch });
  const provider = getProvider(env.provider);
  const rt = await provider.status(env.runtime as unknown as Runtime);
  if (!rt.ip)
    throw new RunoError(`Environment ${env.name} has no IP (state: ${rt.state})`, "Run `runo resume`");
  registry.patch(env.name, { runtime: rt as unknown as Record<string, unknown> });
  const urls = Object.values(urlsFor(env, rt.ip));
  if (urls.length === 0)
    throw new RunoError("No public service in this env", "Mark `public: true` (or `public: <service>`) in the recipe and run `runo up`");
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
      throw new RunoError(`Service "${svc}" does not exist in the recipe`, `Services: ${Object.keys(ctx.recipe.services).join(", ")}`);
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
    cmd = parts.join(" ; ") || "echo 'no services in the recipe'";
  }
  const code = await provider.logs(rt, cmd, { cwd: remoteDir });
  process.exit(code);
}

async function cmdExec(flags: Flags): Promise<void> {
  if (flags.passthrough.length === 0)
    throw new RunoError("Usage: runo exec -- <command...>", "E.g.: runo exec -- docker ps");
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
    log.info("no environments — create one with `runo new <name>`");
    return;
  }
  const provider = getProvider("aws");
  const rows: string[][] = [["ENV", "BRANCH", "STATE", "URL", "UPTIME", "INSTANCE"]];
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
  log.step(`stopping instance for ${env.name} (stopped = EBS-only cost)…`);
  const rt = await provider.suspend(env.runtime as unknown as Runtime);
  registry.patch(env.name, { runtime: rt as unknown as Record<string, unknown>, state: "stopped" });
  log.ok(`${env.name} suspended — resume with \`runo resume\` (the public IP will change)`);
}

async function cmdResume(flags: Flags): Promise<void> {
  const env = resolveEnv({ branch: flags.branch });
  await resumeEnv(contextFromEnv(env));
}

async function cmdBake(flags: Flags): Promise<void> {
  const provider = getProvider("aws");
  await provider.preflight();
  if (flags.rm) {
    await provider.removeBootImage();
    return;
  }
  log.step("baking base image (~10-12min; one-time — serves every env of this install)…");
  const imageId = await provider.prepareBootImage();
  log.ok(`base image ready: ${imageId} — subsequent runo up boot in ~1-2min`);
}

async function cmdPool(flags: Flags): Promise<void> {
  const provider = getProvider("aws");
  await provider.preflight();
  const arg = flags.positional[0];
  if (arg === undefined) {
    const pool = await provider.poolStatus();
    if (pool.length === 0) {
      log.info("warm pool is empty — create with `runo pool <n>` (a stopped instance costs EBS only, ~US$3/mo)");
      return;
    }
    for (const p of pool) console.log(`${p.id}  ${p.state}  ${p.instanceType ?? "-"}`);
    return;
  }
  const target = Number(arg);
  if (!Number.isInteger(target)) throw new RunoError("Usage: runo pool [n]", "E.g.: runo pool 2 (or 0 to drain)");
  await provider.poolScale(target);
  log.ok(`warm pool adjusted to ${target} instance(s)`);
}

async function destroyOne(env: EnvRecord): Promise<void> {
  const provider = getProvider(env.provider);
  if ((env.runtime as any)?.id) {
    log.step(`terminating instance for ${env.name}…`);
    await provider.destroy(env.runtime as unknown as Runtime);
  }
  if (env.externalWorktree) {
    registry.remove(env.name);
    log.ok(`${env.name} destroyed (instance + registry; external worktree kept)`);
    return;
  }
  removeWorktree(env.repoPath, env.worktree);
  registry.remove(env.name);
  log.ok(`${env.name} destroyed (instance + worktree + registry)`);
}

async function cmdDestroy(flags: Flags): Promise<void> {
  if (flags.all) {
    const envs = registry.list();
    for (const env of envs) await destroyOne(env);
    const provider = getProvider("aws");
    await provider.preflight();
    const leftover = await provider.listManaged();
    for (const rt of leftover) {
      log.warn(`runo instance outside the registry: ${rt.name ?? rt.id} — terminating`);
      await provider.destroy(rt);
    }
    await provider.cleanupShared();
    log.ok("runo destroy --all: instances, keypair and security group removed");
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
        throw new RunoError(`Unknown command: ${cmd}`, "See `runo help`");
    }
  } catch (e) {
    if (e instanceof RunoError) {
      log.error(e.message);
      if (e.hint) log.info(`→ ${e.hint}`);
      process.exit(1);
    }
    log.error((e as Error)?.message ?? String(e));
    if (process.env.RUNO_DEBUG) console.error(e);
    else log.dim("(run with RUNO_DEBUG=1 for a stack trace)");
    process.exit(1);
  }
}

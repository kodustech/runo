import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { TMP_DIR, remoteRepoDir } from "../config";
import { RunoError } from "../errors";
import { log } from "../log";
import { getProvider } from "../provider";
import type { Runtime, RuntimeProvider } from "../provider/types";
import { registry, urlsFor, type EnvRecord } from "../registry";
import { shq } from "../ssh";
import { git, type EnvContext } from "./context";
import { getExpose } from "../expose";
import { composePrefix, healthcheckPublic, planServices, probeServices, startServices, waitInternalPorts } from "./services";
import { IDLE_MARK_ACTIVE, ensureIdleWatchdog } from "./idleWatchdog";

/** Tooling that cloud-init must have left ready on the VM. */
const TOOLING_CHECK =
  "docker --version && docker compose version && git --version && tmux -V && rsync --version | head -1 && node --version && bun --version && pnpm --version && claude --version && codex --version";

/** The recipe path as the repo sees it, so another machine can load the same one. */
function recipeRelative(ctx: EnvContext): string {
  const rel = path.relative(ctx.worktree, ctx.recipePath);
  return rel.startsWith("..") ? ctx.recipePath : rel;
}

function baseRecord(ctx: EnvContext): EnvRecord {
  return (
    registry.get(ctx.envName) ?? {
      name: ctx.envName,
      repo: ctx.repoName,
      repoPath: ctx.repoPath,
      branch: ctx.branch,
      slug: ctx.slug,
      profile: ctx.profile,
      worktree: ctx.worktree,
      externalWorktree: ctx.externalWorktree,
      provider: "aws",
      runtime: {},
      state: "creating",
      publicServices: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  );
}

export async function uploadCode(
  provider: RuntimeProvider,
  rt: Runtime,
  ctx: EnvContext,
  remoteDir: string,
): Promise<void> {
  // Code travels via git archive (tracked files only) — zero git credentials in the cloud
  log.step("uploading code (git archive HEAD)…");
  mkdirSync(TMP_DIR, { recursive: true });
  const tarPath = path.join(TMP_DIR, `${ctx.envName}-code.tar`);

  // submodules: git archive exports them as EMPTY dirs — stage superproject +
  // each submodule's HEAD into a temp tree and ship that. `submodule update
  // --init` resolves objects from the shared .git/modules locally (no network
  // for already-fetched commits; read-only in any case).
  const hasSubmodules = existsSync(path.join(ctx.worktree, ".gitmodules"));
  if (hasSubmodules) {
    const stage = path.join(TMP_DIR, `${ctx.envName}-stage`);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    const explode = (repoDir: string, ref: string, dest: string) => {
      mkdirSync(dest, { recursive: true });
      const r = Bun.spawnSync(["bash", "-c", `git -C ${JSON.stringify(repoDir)} archive --format=tar ${JSON.stringify(ref)} | tar -x -C ${JSON.stringify(dest)}`]);
      if (r.exitCode !== 0)
        throw new RunoError(`archive of ${repoDir}@${ref} failed: ${r.stderr.toString().trim()}`);
    };
    // Submodule content comes from ALREADY-populated checkouts at the exact
    // commit each superproject records — `submodule update --init` silently
    // no-ops in linked worktrees, and this path is guaranteed offline.
    // Recursive: monorepos nest submodules (e.g. app → packages/commons).
    const shipTree = (repoDir: string, ref: string, dest: string, origDir: string) => {
      explode(repoDir, ref, dest);
      const gm = path.join(dest, ".gitmodules");
      if (!existsSync(gm)) return;
      const modPaths = git(repoDir, "config", "--file", gm, "--get-regexp", "\\.path$")
        .stdout.split("\n")
        .map((l) => l.split(" ").slice(1).join(" ").trim())
        .filter(Boolean);
      for (const rel of modPaths) {
        const sha = git(repoDir, "ls-tree", ref, rel).stdout.split(/\s+/)[2]; // "160000 commit <sha>\t<path>"
        if (!sha) continue;
        const candidates = [path.join(repoDir, rel), path.join(origDir, rel)];
        const src = candidates.find((c) => existsSync(path.join(c, ".git")));
        if (!src)
          throw new RunoError(
            `Submodule "${rel}" is not populated in ${repoDir} nor in ${origDir}`,
            `Run: git -C ${origDir} submodule update --init --recursive`,
          );
        try {
          shipTree(src, sha, path.join(dest, rel), path.join(origDir, rel));
        } catch (e) {
          if (e instanceof RunoError) throw e;
          log.warn(`submodule ${rel}: recorded commit ${sha.slice(0, 7)} not found locally — shipping ${src}'s HEAD instead`);
          shipTree(src, "HEAD", path.join(dest, rel), path.join(origDir, rel));
        }
      }
    };
    shipTree(ctx.worktree, "HEAD", stage, ctx.repoPath);
    const pack = Bun.spawnSync(["tar", "-cf", tarPath, "-C", stage, "."]);
    if (pack.exitCode !== 0) throw new RunoError(`packing staged tree failed: ${pack.stderr.toString().trim()}`);
    rmSync(stage, { recursive: true, force: true });
  } else {
    const archive = git(ctx.worktree, "archive", "--format=tar", "-o", tarPath, "HEAD");
    if (archive.exitCode !== 0)
      throw new RunoError(`git archive failed in worktree ${ctx.worktree}: ${archive.stderr}`);
  }
  await provider.upload(rt, tarPath, "/tmp/runo-code.tar");
  rmSync(tarPath, { force: true });
  // sudo: containers may have written root-owned files (node_modules) into
  // the bind-mounted tree — a plain rm as the ssh user cannot remove them
  const extract = await provider.exec(
    rt,
    `sudo rm -rf ${shq(remoteDir)} && mkdir -p ${shq(remoteDir)} && tar -xf /tmp/runo-code.tar -C ${shq(remoteDir)} && rm -f /tmp/runo-code.tar`,
  );
  if (extract.exitCode !== 0)
    throw new RunoError(`Code extraction on the VM failed: ${extract.stderr.trim()}`);

  await uploadRecipeFiles(provider, rt, ctx, remoteDir);

  // git on the VM so the agent can work there
  const localSha = git(ctx.worktree, "rev-parse", "--short", "HEAD").stdout || "unknown";
  const init = await provider.exec(
    rt,
    `git init -q -b ${shq(ctx.branch)} && git add -A && git -c user.name=runo -c user.email=runo@kodus.local commit -qm ${shq(`runo: upload ${localSha}`)}`,
    { cwd: remoteDir },
  );
  if (init.exitCode !== 0)
    throw new RunoError(`git init/commit on the VM failed: ${init.stderr.trim()}`);
}

/** Uploads untracked runtime material (env files, preview credentials) before
 * a reconcile. A running VM can be adopted by a fresh CI runner, so relying on
 * the original `up` materialization would otherwise leave it with stale or
 * missing files when the recipe adds a new files.copy entry. */
export async function uploadRecipeFiles(
  provider: RuntimeProvider,
  rt: Runtime,
  ctx: EnvContext,
  remoteDir: string,
): Promise<void> {
  // files.copy: required untracked files (e.g. .env) — from the worktree, else the original repo
  for (const rel of ctx.recipe.filesCopy) {
    const fromWorktree = path.join(ctx.worktree, rel);
    const fromRepo = path.join(ctx.repoPath, rel);
    const src = existsSync(fromWorktree) ? fromWorktree : existsSync(fromRepo) ? fromRepo : null;
    if (!src)
      throw new RunoError(
        `files.copy: "${rel}" exists neither in the worktree nor in ${ctx.repoPath}`,
        "Create the file (e.g. a DEVELOPMENT .env — the env's URL is public, never use production credentials)",
      );
    log.step(`copying untracked file: ${rel}`);
    await provider.upload(rt, src, path.posix.join(remoteDir, rel));
  }
}

export async function runSteps(
  provider: RuntimeProvider,
  rt: Runtime,
  remoteDir: string,
  label: string,
  cmds: string[],
  opts: { retries?: number } = {},
): Promise<void> {
  for (const cmd of cmds) {
    log.step(`${label}: ${cmd}`);
    const attempts = (opts.retries ?? 0) + 1;
    let last = 1;
    for (let i = 1; i <= attempts; i++) {
      const r = await provider.exec(rt, cmd, { cwd: remoteDir, stream: true, timeoutMs: 40 * 60_000 });
      last = r.exitCode;
      if (last === 0) break;
      if (i < attempts) {
        log.warn(`"${cmd}" failed (exit ${last}) — attempt ${i + 1}/${attempts} in 5s…`);
        await new Promise((r2) => setTimeout(r2, 5000));
      }
    }
    if (last !== 0)
      throw new RunoError(`${label} step failed (exit ${last}): ${cmd}`, "Output above; the VM stays up for inspection via `runo exec`");
  }
}

async function finishUp(
  provider: RuntimeProvider,
  rt: Runtime,
  ctx: EnvContext,
  env: EnvRecord,
  opts: { runData: boolean },
): Promise<EnvRecord> {
  const remoteDir = remoteRepoDir(ctx.repoName);
  const plan = await planServices(provider, rt, ctx.recipe, remoteDir);

  // expose BEFORE the services boot: an app that emits absolute links (auth
  // callbacks, a frontend calling its own API) needs its public address in the
  // environment it starts with — see composePrefix's ${RUNO_PUBLIC_URL}.
  const expose = getExpose(ctx.recipe);
  const urls = await expose.up({
    provider,
    rt,
    envName: ctx.envName,
    slug: ctx.slug,
    services: plan.publicServices.map((s, i) => ({ name: s.name, port: s.port, primary: i === 0 })),
  });

  await startServices(provider, rt, ctx.recipe, remoteDir, plan, urls);
  await waitInternalPorts(provider, rt, plan.internalPorts);
  if (opts.runData) {
    const data = [ctx.recipe.data.migrate, ctx.recipe.data.seed].filter(Boolean) as string[];
    await runSteps(provider, rt, remoteDir, "data", data, { retries: 2 });
  }
  await healthcheckPublic(provider, rt, ctx.recipe, remoteDir, plan.publicServices, urls);

  // idle auto-suspend (the on-VM watchdog reads /etc/runo/idle-limit and
  // idle-signals); an up is activity too, so the idle clock restarts here
  const { idleSuspendSec: idle, idleActivity } = ctx.recipe.limits;
  await provider.exec(
    rt,
    [
      "sudo mkdir -p /etc/runo",
      `echo ${idle} | sudo tee /etc/runo/idle-limit >/dev/null`,
      `echo ${shq(idleActivity.join(" "))} | sudo tee /etc/runo/idle-signals >/dev/null`,
      IDLE_MARK_ACTIVE,
    ].join(" && "),
  );
  if (idle > 0) {
    const counts = idleActivity.length ? `without ${idleActivity.join("/")} activity` : "after this up, whatever happens";
    log.dim(`auto-suspend: the VM suspends itself ${Math.round(idle / 60)}min ${counts} (limits.idle_suspend)`);
  }
  // the watchdog itself (script + cron) must exist too — baked/pool/old VMs
  // can miss the cloud-init install and would then stay up forever
  await ensureIdleWatchdog(provider, rt);

  // control plane learns the env's services (per-env hostnames on the ingress)
  await provider.registerServices?.(
    rt,
    plan.publicServices.map((s) => ({ name: s.name, port: s.port })),
    { recipe: recipeRelative(ctx), urls },
  );

  const updated = registry.upsert({
    ...env,
    runtime: rt as unknown as Record<string, unknown>,
    state: "running",
    materialized: true,
    publicServices: plan.publicServices,
    recipe: recipeRelative(ctx),
    exposeMode: ctx.recipe.expose.mode,
    urls,
    lastUpAt: new Date().toISOString(),
  });
  log.ok(`environment ${ctx.envName} is up`);
  for (const [svc, url] of Object.entries(urlsFor(updated, rt.ip))) console.log(`  ${svc}: ${url}`);
  return updated;
}

/**
 * Materializes/resumes/reconciles the branch's remote environment (idempotent —
 * the behavior of `runo up`).
 */
export async function upEnv(ctx: EnvContext): Promise<EnvRecord> {
  const provider = getProvider("aws");
  await provider.preflight();

  let env = baseRecord(ctx);
  let rt: Runtime | null = null;
  // An adopted env carries no proof that the previous run finished — it may
  // have died mid-migration. Migrations and seeds are idempotent, so re-running
  // them is cheap insurance; skipping them leaves a half-built environment
  // (that is exactly how the first CI preview came up without its login).
  let adopted = false;

  // No local record? The env may still exist — the registry is per machine and
  // CI runs on a new one every job. The instance's own tags are the source of
  // truth, so adopt what the branch already has instead of paying for a second
  // VM (and leaking the first).
  if (!(env.runtime as any)?.id && provider.findByTags) {
    const found = await provider.findByTags(ctx.repoName, ctx.branch, ctx.profile);
    if (found) {
      log.step(`adopting the existing instance for ${ctx.branch}${ctx.profile ? ` (${ctx.profile})` : ""} (${found.id}, ${found.state})`);
      adopted = true;
      env = registry.upsert({
        ...env,
        runtime: found as unknown as Record<string, unknown>,
        state: found.state === "running" ? "running" : "stopped",
        // the upload/setup pipeline may or may not have completed on that
        // instance; finishUp re-checks the repo on disk before reconciling
        materialized: true,
      });
    }
  }

  if (env.runtime && (env.runtime as any).id) {
    rt = await provider.status(env.runtime as unknown as Runtime);
    if (rt.state === "terminated" || rt.state === "shutting-down" || rt.state === "unknown") {
      log.warn(`the env's previous instance no longer exists (${rt.state}) — recreating`);
      rt = null;
      env = { ...env, runtime: {}, state: "creating", materialized: false };
    }
  }

  if (!rt) {
    // ---- materialize from scratch ----
    log.step(
      `creating VM for ${ctx.envName} (${ctx.recipe.limits.instance}, ${ctx.recipe.limits.diskGb}GB)…`,
    );
    env = registry.upsert({ ...env, state: "creating" });
    rt = await provider.create({
      envName: ctx.envName,
      slug: ctx.slug,
      instanceType: ctx.recipe.limits.instance,
      diskGb: ctx.recipe.limits.diskGb,
      repo: ctx.repoName,
      branch: ctx.branch,
      profile: ctx.profile,
      spot: ctx.recipe.limits.spot,
    });
    env = registry.upsert({
      ...env,
      runtime: rt as unknown as Record<string, unknown>,
      state: "provisioning",
    });
    await provider.waitReady(rt, { firstBoot: true });
    // retry: right after boot, sshd may restart / regenerate host keys mid-check
    let tooling = { exitCode: 1, stdout: "", stderr: "" };
    for (let i = 0; i < 4 && tooling.exitCode !== 0; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 15_000));
      tooling = await provider.exec(rt, TOOLING_CHECK, { timeoutMs: 60_000 });
    }
    if (tooling.exitCode !== 0)
      throw new RunoError(
        "Incomplete tooling on the VM after boot",
        `Failed: ${tooling.stderr.trim().split("\n").pop()}\nInspect with: runo exec -- cat /var/log/cloud-init-output.log`,
      );
    const remoteDir = remoteRepoDir(ctx.repoName);
    await uploadCode(provider, rt, ctx, remoteDir);
    await runSteps(provider, rt, remoteDir, "setup", ctx.recipe.setup);
    return await finishUp(provider, rt, ctx, env, { runData: true });
  }

  if (rt.state === "stopped" || rt.state === "stopping") {
    log.step("environment is stopped — resuming (runo up is idempotent)…");
    return await resumeEnv(ctx);
  }

  if (rt.state === "pending") rt = await provider.resume(rt); // waits for running

  // a long reconcile must not race the watchdog of a VM that sat idle
  await provider.exec(rt, IDLE_MARK_ACTIVE);

  // reconcile only applies if materialization completed AND the repo still exists on the VM
  const remoteDir = remoteRepoDir(ctx.repoName);
  const repoExists =
    env.materialized === true &&
    (await provider.exec(rt, `test -d ${shq(remoteDir)}`)).exitCode === 0;

  if (!repoExists) {
    log.warn("previous materialization incomplete — redoing upload/setup/services");
    await provider.waitReady(rt);
    // a previous round may have left the stack running on top of the tree we
    // are about to wipe — bring it down first (named volumes survive, so
    // dependency installs stay cached)
    if (ctx.recipe.mode === "compose") {
      log.step("stopping the previous stack before re-upload…");
      await provider.exec(rt, `${composePrefix(ctx.recipe, rt.ip)} down --remove-orphans || true`, {
        cwd: remoteDir,
        timeoutMs: 10 * 60_000,
      });
    }
    await uploadCode(provider, rt, ctx, remoteDir);
    await runSteps(provider, rt, remoteDir, "setup", ctx.recipe.setup);
    return await finishUp(provider, rt, ctx, env, { runData: true });
  }

  // ---- reconcile a running env ----
  log.step("environment already exists — reconciling services and health check…");
  // CI runners are ephemeral and may have added/rotated files.copy material
  // since this VM was created. Upload it before compose parses env_file paths.
  await uploadRecipeFiles(provider, rt, ctx, remoteDir);
  return await finishUp(provider, rt, ctx, env, { runData: adopted });
}

/** Instance start + IP redetection + services back up. */
export async function resumeEnv(ctx: EnvContext): Promise<EnvRecord> {
  const provider = getProvider("aws");
  const env = registry.get(ctx.envName);
  if (!env?.runtime || !(env.runtime as any).id)
    throw new RunoError(`Environment ${ctx.envName} does not exist in the registry`, "Create it with `runo new` / `runo up`");
  let rt = await provider.status(env.runtime as unknown as Runtime);
  if (rt.state === "terminated")
    throw new RunoError(`The instance for env ${ctx.envName} was terminated`, "Recreate it with `runo up`");
  if (rt.state === "running") {
    log.step("instance is already running — reconciling services…");
  } else {
    log.step("starting the instance (the public IP CHANGES on stop/start)…");
    rt = await provider.resume(rt);
    log.ok(`new public IP: ${rt.ip}`);
  }
  registry.upsert({ ...env, runtime: rt as unknown as Record<string, unknown>, state: "running" });
  await provider.waitReady(rt);
  await provider.exec(rt, IDLE_MARK_ACTIVE);

  // hot return from hibernation? services already answering = restart nothing
  if (await probeServices(rt, env.publicServices, env.urls ?? {})) {
    log.ok("services already hot (hibernation resume) — nothing to restart");
    const updated = registry.upsert({
      ...env,
      runtime: rt as unknown as Record<string, unknown>,
      state: "running",
    });
    for (const [svc, url] of Object.entries(urlsFor(updated, rt.ip)))
      console.log(`  ${svc}: ${url}`);
    return updated;
  }
  return await finishUp(provider, rt, ctx, { ...env, runtime: rt as any }, { runData: false });
}

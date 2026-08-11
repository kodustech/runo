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
import { healthcheckPublic, probeServices, startServices, waitInternalPorts } from "./services";

/** Tooling that cloud-init must have left ready on the VM. */
const TOOLING_CHECK =
  "docker --version && docker compose version && git --version && tmux -V && rsync --version | head -1 && node --version && bun --version && pnpm --version && claude --version && codex --version";

function baseRecord(ctx: EnvContext): EnvRecord {
  return (
    registry.get(ctx.envName) ?? {
      name: ctx.envName,
      repo: ctx.repoName,
      repoPath: ctx.repoPath,
      branch: ctx.branch,
      slug: ctx.slug,
      worktree: ctx.worktree,
      provider: "aws",
      runtime: {},
      state: "creating",
      publicServices: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  );
}

async function uploadCode(
  provider: RuntimeProvider,
  rt: Runtime,
  ctx: EnvContext,
  remoteDir: string,
): Promise<void> {
  // Code travels via git archive (tracked files only) — zero git credentials in the cloud
  log.step("uploading code (git archive HEAD)…");
  mkdirSync(TMP_DIR, { recursive: true });
  const tarPath = path.join(TMP_DIR, `${ctx.envName}-code.tar`);
  const archive = git(ctx.worktree, "archive", "--format=tar", "-o", tarPath, "HEAD");
  if (archive.exitCode !== 0)
    throw new RunoError(`git archive failed in worktree ${ctx.worktree}: ${archive.stderr}`);
  await provider.upload(rt, tarPath, "/tmp/runo-code.tar");
  rmSync(tarPath, { force: true });
  const extract = await provider.exec(
    rt,
    `rm -rf ${shq(remoteDir)} && mkdir -p ${shq(remoteDir)} && tar -xf /tmp/runo-code.tar -C ${shq(remoteDir)} && rm -f /tmp/runo-code.tar`,
  );
  if (extract.exitCode !== 0)
    throw new RunoError(`Code extraction on the VM failed: ${extract.stderr.trim()}`);

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

async function runSteps(
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
  const plan = await startServices(provider, rt, ctx.recipe, remoteDir);
  await provider.ensurePorts(plan.publicServices.map((s) => s.port));
  await waitInternalPorts(provider, rt, plan.internalPorts);
  if (opts.runData) {
    const data = [ctx.recipe.data.migrate, ctx.recipe.data.seed].filter(Boolean) as string[];
    await runSteps(provider, rt, remoteDir, "data", data, { retries: 2 });
  }
  await healthcheckPublic(provider, rt, ctx.recipe, remoteDir, plan.publicServices);

  // idle auto-suspend (the on-VM watchdog reads /etc/runo/idle-limit)
  const idle = ctx.recipe.limits.idleSuspendSec;
  await provider.exec(rt, `sudo mkdir -p /etc/runo && echo ${idle} | sudo tee /etc/runo/idle-limit >/dev/null`);
  if (idle > 0)
    log.dim(`auto-suspend: the VM suspends itself after ${Math.round(idle / 60)}min of inactivity (limits.idle_suspend)`);

  const updated = registry.upsert({
    ...env,
    runtime: rt as unknown as Record<string, unknown>,
    state: "running",
    materialized: true,
    publicServices: plan.publicServices,
    lastUpAt: new Date().toISOString(),
  });
  const urls = urlsFor(updated, rt.ip);
  log.ok(`environment ${ctx.envName} is up`);
  for (const [svc, url] of Object.entries(urls)) console.log(`  ${svc}: ${url}`);
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

  // reconcile only applies if materialization completed AND the repo still exists on the VM
  const remoteDir = remoteRepoDir(ctx.repoName);
  const repoExists =
    env.materialized === true &&
    (await provider.exec(rt, `test -d ${shq(remoteDir)}`)).exitCode === 0;

  if (!repoExists) {
    log.warn("previous materialization incomplete — redoing upload/setup/services");
    await provider.waitReady(rt);
    await uploadCode(provider, rt, ctx, remoteDir);
    await runSteps(provider, rt, remoteDir, "setup", ctx.recipe.setup);
    return await finishUp(provider, rt, ctx, env, { runData: true });
  }

  // ---- reconcile a running env ----
  log.step("environment already exists — reconciling services and health check…");
  return await finishUp(provider, rt, ctx, env, { runData: false });
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

  // hot return from hibernation? services already answering = restart nothing
  if (await probeServices(rt, env.publicServices)) {
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

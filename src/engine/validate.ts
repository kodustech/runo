import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REMOTE_RUNO_DIR, remoteRepoDir } from "../config";
import { RunoError } from "../errors";
import { fmtDuration, log } from "../log";
import { getProvider } from "../provider";
import type { Runtime } from "../provider/types";
import { registry, urlsFor } from "../registry";
import { shq } from "../ssh";
import type { EnvContext } from "./context";

interface StepResult {
  name: string;
  run: string;
  status: "passed" | "failed";
  durationMs: number;
  exitCode: number;
  logFile: string;
}

export interface Evidence {
  version: 1;
  repo: string;
  branch: string;
  sha: string;
  env: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed";
  steps: StepResult[];
  urls: Record<string, string>;
}

/**
 * Runs the validate steps ON the VM and downloads the evidence (JSON + MD)
 * into the local worktree — the future contract with Kody.
 */
export async function validateEnv(ctx: EnvContext, onlyStep?: string): Promise<Evidence> {
  const provider = getProvider("aws");
  const env = registry.get(ctx.envName);
  if (!env) throw new RunoError(`Environment ${ctx.envName} is not registered`, "Create it with `runo new`/`runo up`");
  const rt = await provider.status(env.runtime as unknown as Runtime);
  if (rt.state !== "running" || !rt.ip)
    throw new RunoError(`Environment ${ctx.envName} is not running (${rt.state})`, "Run `runo up`/`runo resume`");

  let steps = ctx.recipe.validate;
  if (onlyStep) {
    steps = steps.filter((s) => s.name === onlyStep);
    if (steps.length === 0)
      throw new RunoError(
        `Step "${onlyStep}" does not exist in the recipe`,
        `Available steps: ${ctx.recipe.validate.map((s) => s.name).join(", ") || "(none)"}`,
      );
  }
  if (steps.length === 0)
    throw new RunoError("Recipe has no validate steps", "Add a `validate:` section to the recipe");

  const remoteDir = remoteRepoDir(ctx.repoName);
  const shaRes = await provider.exec(rt, "git rev-parse --short HEAD", { cwd: remoteDir });
  const sha = shaRes.exitCode === 0 ? shaRes.stdout.trim() : "unknown";

  const startedAt = new Date().toISOString();
  const results: StepResult[] = [];
  await provider.exec(rt, `mkdir -p ${REMOTE_RUNO_DIR}/evidence/logs`);

  for (const step of steps) {
    const logRel = `.kodus/evidence/logs/${sha}-${step.name}.log`;
    const remoteLog = `${REMOTE_RUNO_DIR}/evidence/logs/${sha}-${step.name}.log`;
    log.step(`validate[${step.name}]: ${step.run} (on the VM)`);
    const t0 = Date.now();
    const r = await provider.exec(rt, `{ ${step.run} ; } > ${shq(remoteLog)} 2>&1`, {
      cwd: remoteDir,
      timeoutMs: 40 * 60_000,
    });
    const durationMs = Date.now() - t0;
    const status = r.exitCode === 0 ? "passed" : "failed";
    results.push({ name: step.name, run: step.run, status, durationMs, exitCode: r.exitCode, logFile: logRel });
    (status === "passed" ? log.ok : log.error)(
      `${step.name}: ${status} (${fmtDuration(durationMs)}, exit ${r.exitCode})`,
    );
  }

  const finishedAt = new Date().toISOString();
  const evidence: Evidence = {
    version: 1,
    repo: ctx.repoName,
    branch: ctx.branch,
    sha,
    env: ctx.envName,
    startedAt,
    finishedAt,
    status: results.every((s) => s.status === "passed") ? "passed" : "failed",
    steps: results,
    urls: urlsFor(env, rt.ip),
  };

  // download logs + write JSON/MD into the local worktree
  const evidenceDir = path.join(ctx.worktree, ".kodus", "evidence");
  mkdirSync(path.join(evidenceDir, "logs"), { recursive: true });
  await provider.download(rt, `${REMOTE_RUNO_DIR}/evidence/logs/${sha}-*.log`, path.join(evidenceDir, "logs/"));
  writeFileSync(path.join(evidenceDir, `${sha}.json`), JSON.stringify(evidence, null, 2) + "\n");
  writeFileSync(path.join(evidenceDir, `${sha}.md`), renderMarkdown(evidence));
  log.ok(`evidence: ${path.join(evidenceDir, `${sha}.json`)} (+ .md, + logs/)`);
  return evidence;
}

function renderMarkdown(e: Evidence): string {
  const icon = (s: string) => (s === "passed" ? "✅" : "❌");
  const lines = [
    `${icon(e.status)} **runo — environment validation \`${e.env}\` (commit ${e.sha})**`,
    "",
    `- Repo: \`${e.repo}\` · Branch: \`${e.branch}\``,
    `- Started: ${e.startedAt} · Finished: ${e.finishedAt}`,
    "",
    "| Step | Status | Duration | Exit | Log |",
    "| --- | --- | --- | --- | --- |",
    ...e.steps.map(
      (s) =>
        `| ${s.name} | ${icon(s.status)} ${s.status} | ${fmtDuration(s.durationMs)} | ${s.exitCode} | \`${s.logFile}\` |`,
    ),
    "",
    ...Object.entries(e.urls).map(([svc, url]) => `🔗 ${svc}: ${url}`),
    "",
  ];
  return lines.join("\n");
}

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/** runo's state root. RUNO_HOME must be respected in ALL paths. */
export const RUNO_HOME = path.resolve(
  process.env.RUNO_HOME || path.join(homedir(), ".runo"),
);

/** Short hash of RUNO_HOME — prevents keypair/SG collisions between parallel installs. */
export const HASH6 = createHash("sha256").update(RUNO_HOME).digest("hex").slice(0, 6);

export const AWS_REGION = process.env.RUNO_AWS_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "sa-east-1";

export const SSH_DIR = path.join(RUNO_HOME, "ssh");
export const WORKTREES_DIR = path.join(RUNO_HOME, "worktrees");
export const TMP_DIR = path.join(RUNO_HOME, "tmp");
export const REGISTRY_PATH = path.join(RUNO_HOME, "envs.json");

/** Global agent credentials file — independent of RUNO_HOME. */
export const AGENT_ENV_PATH = path.join(homedir(), ".kodus", "agent.env");

/**
 * Cost guardrail: maximum simultaneous RUNNING instances.
 * A laptop wants a low ceiling; CI running one preview per open pull request
 * needs a different one — RUNO_MAX_INSTANCES moves it deliberately.
 */
export const MAX_INSTANCES = (() => {
  const raw = process.env.RUNO_MAX_INSTANCES?.trim();
  if (!raw) return 3;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`RUNO_MAX_INSTANCES must be a positive integer (got "${raw}")`);
  return n;
})();

/** runo's remote state directory on the VM. */
export const REMOTE_RUNO_DIR = "/home/ubuntu/.runo";
export const REMOTE_USER = "ubuntu";

export function remoteRepoDir(repoName: string): string {
  return `/home/ubuntu/${repoName}`;
}

export function envNameFor(slug: string): string {
  return `runo-${HASH6}-${slug}`;
}

export function slugify(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A profile is a second axis of an env's identity: the same branch can be
 * materialized more than once, one env per profile ("cloud" and
 * "self-hosted" of the same pull request). It is part of the slug, so the
 * env name, the VM name, the worktree, the ingress hostname and the tags all
 * split by themselves. No profile keeps every identifier exactly as before.
 */
export function validateProfile(raw: string): string {
  const p = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(p) || p.endsWith("-"))
    throw new Error(
      `Invalid profile "${raw}": use lowercase letters, digits and dashes (e.g. "cloud", "self-hosted")`,
    );
  return p;
}

/** RUNO_PROFILE, validated; `--profile` sets the same variable. */
export function profileFromEnv(): string | undefined {
  const raw = process.env.RUNO_PROFILE?.trim();
  return raw ? validateProfile(raw) : undefined;
}

export function slugFor(branch: string, profile?: string): string {
  const base = slugify(branch);
  return profile ? `${base}-${profile}` : base;
}

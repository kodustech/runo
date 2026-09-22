import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUNO_HOME, REGISTRY_PATH } from "./config";
import { RunoError } from "./errors";

export class AmbiguousEnvError extends RunoError {
  constructor(branch: string, profiles: string[]) {
    super(
      `${branch} has more than one environment (profiles: ${profiles.join(", ")})`,
      "Pick one with --profile <name> (or RUNO_PROFILE)",
    );
  }
}

export interface PublicService {
  name: string;
  port: number;
  health?: string; // HTTP path; absent = TCP check
  healthTimeoutSec?: number; // default 120
}

export interface EnvRecord {
  name: string; // runo-<hash6>-<slug>
  repo: string;
  repoPath: string;
  branch: string;
  slug: string;
  /** Second identity axis (--profile): one branch may own one env per
   * profile. Absent for envs created without one. */
  profile?: string;
  worktree: string;
  provider: string; // "aws"
  server?: string;
  runtime: Record<string, unknown>; // opaque provider data (instanceId, ip, ...)
  state: "creating" | "provisioning" | "running" | "stopped" | "error";
  /** true only after the full pipeline (upload+setup+services+health) — the
   * instance state does NOT substitute this: an interrupted up stays false. */
  materialized?: boolean;
  /** worktree is owned by an external tool (Orca, the user) — runo up --here.
   * destroy must NOT remove it. */
  externalWorktree?: boolean;
  publicServices: PublicService[];
  /** Recipe this env was materialized from, relative to the repo (--recipe). */
  recipe?: string;
  /** How this env is published (recipe expose.mode) — "ip" for older records. */
  exposeMode?: string;
  /** service name → public URL, as handed out by the expose layer. */
  urls?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  lastUpAt?: string;
}

interface RegistryFile {
  version: 1;
  envs: Record<string, EnvRecord>;
}

function loadFile(): RegistryFile {
  if (!existsSync(REGISTRY_PATH)) return { version: 1, envs: {} };
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch {
    return { version: 1, envs: {} };
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.envs !== "object" || parsed.envs === null) {
    // registry written by another install/version — never overwrite blindly
    throw new Error(
      `${REGISTRY_PATH} exists but is not in this runo's format (expected {version, envs}). ` +
        `Another runo install may be using this RUNO_HOME — use a dedicated RUNO_HOME.`,
    );
  }
  return parsed as RegistryFile;
}

function saveFile(reg: RegistryFile): void {
  mkdirSync(RUNO_HOME, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n");
}

export const registry = {
  list(): EnvRecord[] {
    return Object.values(loadFile().envs);
  },

  get(name: string): EnvRecord | undefined {
    return loadFile().envs[name];
  },

  /** Every env of the branch, whatever its profile. */
  listByRepoBranch(repoPath: string, branch: string): EnvRecord[] {
    return this.list().filter(
      (e) => (e.repoPath === repoPath || e.worktree === repoPath) && e.branch === branch,
    );
  },

  /**
   * The branch's env. With a profile, that profile's env; without one, the
   * branch's only env — two envs of the same branch need the profile to tell
   * them apart, and guessing would push code to the wrong machine.
   */
  findByRepoBranch(repoPath: string, branch: string, profile?: string): EnvRecord | undefined {
    const all = this.listByRepoBranch(repoPath, branch);
    if (profile !== undefined) return all.find((e) => e.profile === profile);
    if (all.length <= 1) return all[0];
    throw new AmbiguousEnvError(branch, all.map((e) => e.profile ?? "(none)"));
  },

  /** Every env anchored at cwd — an external worktree (--here, attach) may
   * anchor one per profile. */
  listByCwd(cwd: string): EnvRecord[] {
    const abs = path.resolve(cwd);
    return this.list().filter((e) => abs === e.worktree || abs.startsWith(e.worktree + path.sep));
  },

  findByCwd(cwd: string): EnvRecord | undefined {
    return this.listByCwd(cwd)[0];
  },

  upsert(env: EnvRecord): EnvRecord {
    const reg = loadFile();
    env.updatedAt = new Date().toISOString();
    reg.envs[env.name] = env;
    saveFile(reg);
    return env;
  },

  patch(name: string, partial: Partial<EnvRecord>): EnvRecord | undefined {
    const reg = loadFile();
    const cur = reg.envs[name];
    if (!cur) return undefined;
    const next = { ...cur, ...partial, updatedAt: new Date().toISOString() };
    reg.envs[name] = next;
    saveFile(reg);
    return next;
  },

  remove(name: string): void {
    const reg = loadFile();
    delete reg.envs[name];
    saveFile(reg);
  },
};

/**
 * Public URLs of the env. Whatever the expose layer handed out wins; the
 * IP:port form is the fallback for records written before expose existed.
 */
export function urlsFor(env: EnvRecord, ip: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  // keep the recipe's service order (publicServices[0] is the primary)
  for (const svc of env.publicServices) {
    const fromExpose = env.urls?.[svc.name];
    if (fromExpose) out[svc.name] = fromExpose;
    else if (ip) out[svc.name] = `http://${ip}:${svc.port}`;
  }
  for (const [name, url] of Object.entries(env.urls ?? {})) if (!out[name]) out[name] = url;
  return out;
}

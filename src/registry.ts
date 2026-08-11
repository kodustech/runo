import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUNO_HOME, REGISTRY_PATH } from "./config";

export interface PublicService {
  name: string;
  port: number;
  health?: string; // path HTTP; ausente = check TCP
  healthTimeoutSec?: number; // default 120
}

export interface EnvRecord {
  name: string; // runo-<hash6>-<slug>
  repo: string;
  repoPath: string;
  branch: string;
  slug: string;
  worktree: string;
  provider: string; // "aws"
  runtime: Record<string, unknown>; // dados opacos do provider (instanceId, ip, ...)
  state: "creating" | "provisioning" | "running" | "stopped" | "error";
  /** true somente após o pipeline completo (upload+setup+serviços+health) — o
   * estado da instância NÃO substitui isto: um up interrompido fica false. */
  materialized?: boolean;
  publicServices: PublicService[];
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
    // registry escrito por outra instalação/versão do runo — não sobrescrever às cegas
    throw new Error(
      `${REGISTRY_PATH} existe mas não está no formato deste runo (esperado {version, envs}). ` +
        `Outra instalação do runo pode estar usando este RUNO_HOME — use um RUNO_HOME dedicado.`,
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

  findByRepoBranch(repoPath: string, branch: string): EnvRecord | undefined {
    return this.list().find(
      (e) => (e.repoPath === repoPath || e.worktree === repoPath) && e.branch === branch,
    );
  },

  findByCwd(cwd: string): EnvRecord | undefined {
    const abs = path.resolve(cwd);
    return this.list().find((e) => abs === e.worktree || abs.startsWith(e.worktree + path.sep));
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

export function urlsFor(env: EnvRecord, ip: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!ip) return out;
  for (const svc of env.publicServices) out[svc.name] = `http://${ip}:${svc.port}`;
  return out;
}

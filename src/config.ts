import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/** Raiz de estado do runo. Respeitar RUNO_HOME em TODOS os paths. */
export const RUNO_HOME = path.resolve(
  process.env.RUNO_HOME || path.join(homedir(), ".runo"),
);

/** Hash curto do RUNO_HOME — evita colisão de keypair/SG entre instalações paralelas. */
export const HASH6 = createHash("sha256").update(RUNO_HOME).digest("hex").slice(0, 6);

export const AWS_REGION = process.env.RUNO_AWS_REGION || "sa-east-1";

export const SSH_DIR = path.join(RUNO_HOME, "ssh");
export const WORKTREES_DIR = path.join(RUNO_HOME, "worktrees");
export const TMP_DIR = path.join(RUNO_HOME, "tmp");
export const REGISTRY_PATH = path.join(RUNO_HOME, "envs.json");

/** Arquivo global de chaves dos agentes — independente do RUNO_HOME (decisão 10). */
export const AGENT_ENV_PATH = path.join(homedir(), ".kodus", "agent.env");

/** Guardrail de custo: máximo de instâncias simultâneas (decisão 15). */
export const MAX_INSTANCES = 3;

/** Diretório remoto de estado do runo na VM. */
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

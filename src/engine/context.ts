import path from "node:path";
import { WORKTREES_DIR, envNameFor, slugify } from "../config";
import { RunoError } from "../errors";
import { loadRecipe, type NormalizedRecipe } from "../recipe";
import { registry, type EnvRecord } from "../registry";

export function git(cwd: string, ...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  };
}

export function repoTop(cwd: string): string | null {
  const r = git(cwd, "rev-parse", "--show-toplevel");
  return r.exitCode === 0 ? r.stdout : null;
}

export function currentBranch(repoPath: string): string {
  const r = git(repoPath, "branch", "--show-current");
  if (r.exitCode !== 0 || !r.stdout)
    throw new RunoError(`Não consegui detectar a branch atual em ${repoPath}`);
  return r.stdout;
}

export interface EnvContext {
  repoPath: string; // repo original (âncora do worktree)
  repoName: string;
  branch: string;
  slug: string;
  envName: string;
  worktree: string;
  recipe: NormalizedRecipe;
  recipePath: string;
}

export function worktreePathFor(repoName: string, slug: string): string {
  return path.join(WORKTREES_DIR, `${repoName}-${slug}`);
}

/** Monta o contexto de um env a partir do repo original + branch. */
export function buildContext(repoPath: string, branch: string): EnvContext {
  const repoName = path.basename(repoPath);
  const slug = slugify(branch);
  const worktree = worktreePathFor(repoName, slug);
  // recipe: worktree primeiro (se já existir), senão o repo original —
  // cobre recipe untracked (caso kodus-ai)
  const { recipe, path: recipePath } = loadRecipe(worktree, repoPath);
  return { repoPath, repoName, branch, slug, envName: envNameFor(slug), worktree, recipe, recipePath };
}

export function contextFromEnv(env: EnvRecord): EnvContext {
  const { recipe, path: recipePath } = loadRecipe(env.worktree, env.repoPath);
  return {
    repoPath: env.repoPath,
    repoName: env.repo,
    branch: env.branch,
    slug: env.slug,
    envName: env.name,
    worktree: env.worktree,
    recipe,
    recipePath,
  };
}

/**
 * Resolve qual env o comando alvo: cwd dentro de um worktree do runo >
 * repo+branch do cwd > --branch no repo do cwd.
 */
export function resolveEnv(opts: { branch?: string } = {}): EnvRecord {
  const cwd = process.cwd();
  const byWorktree = registry.findByCwd(cwd);
  if (byWorktree && !opts.branch) return byWorktree;

  const top = repoTop(cwd);
  if (top) {
    const branch = opts.branch ?? (byWorktree ? byWorktree.branch : currentBranch(top));
    const found =
      registry.findByRepoBranch(top, branch) ??
      registry.list().find((e) => e.branch === branch && (top === e.repoPath || top === e.worktree));
    if (found) return found;
    if (byWorktree) return byWorktree;
    throw new RunoError(
      `Nenhum ambiente registrado para ${path.basename(top)} @ ${branch}`,
      "Crie com `runo new <nome>` (ou veja os envs existentes com `runo ls`)",
    );
  }
  if (byWorktree) return byWorktree;
  throw new RunoError(
    "Fora de um repositório git e de qualquer worktree do runo",
    "Rode dentro do repo do projeto ou de um worktree criado pelo runo (`runo ls` mostra os paths)",
  );
}

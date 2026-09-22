import path from "node:path";
import { WORKTREES_DIR, envNameFor, profileFromEnv, slugFor } from "../config";
import { RunoError } from "../errors";
import { loadRecipe, loadRecipeFrom, type NormalizedRecipe } from "../recipe";
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
    throw new RunoError(`Could not detect the current branch in ${repoPath}`);
  return r.stdout;
}

export interface EnvContext {
  repoPath: string; // original repo (worktree anchor)
  repoName: string;
  branch: string;
  slug: string;
  /** Second identity axis: see slugFor in config. */
  profile?: string;
  envName: string;
  worktree: string;
  externalWorktree?: boolean; // worktree owned by an external tool (runo up --here)
  recipe: NormalizedRecipe;
  recipePath: string;
}

export function worktreePathFor(repoName: string, slug: string): string {
  return path.join(WORKTREES_DIR, `${repoName}-${slug}`);
}

/** Builds an env context from the original repo + branch (+ profile). */
export function buildContext(repoPath: string, branch: string, profile = profileFromEnv()): EnvContext {
  const repoName = path.basename(repoPath);
  const slug = slugFor(branch, profile);
  const worktree = worktreePathFor(repoName, slug);
  // recipe: worktree first (if it already exists), then the original repo —
  // covers untracked recipes
  const { recipe, path: recipePath } = loadRecipe(worktree, repoPath);
  return { repoPath, repoName, branch, slug, profile, envName: envNameFor(slug), worktree, recipe, recipePath };
}

/**
 * `runo up --here`: the CURRENT working tree is the sync anchor — for tools
 * that own their worktrees (Orca, plain checkouts). runo never removes it.
 */
export function buildContextHere(
  worktreePath: string,
  branch: string,
  profile = profileFromEnv(),
): EnvContext {
  const repoName = path.basename(worktreePath);
  const slug = slugFor(branch, profile);
  const { recipe, path: recipePath } = loadRecipe(worktreePath);
  return {
    repoPath: worktreePath,
    repoName,
    branch,
    slug,
    profile,
    envName: envNameFor(slug),
    worktree: worktreePath,
    externalWorktree: true,
    recipe,
    recipePath,
  };
}

export function contextFromEnv(env: EnvRecord): EnvContext {
  const { recipe, path: recipePath } = loadRecipeFrom(env.recipe, [env.worktree, env.repoPath]);
  return {
    repoPath: env.repoPath,
    repoName: env.repo,
    branch: env.branch,
    slug: env.slug,
    profile: env.profile,
    envName: env.name,
    worktree: env.worktree,
    externalWorktree: env.externalWorktree,
    recipe,
    recipePath,
  };
}

/**
 * Resolves which env a command targets: cwd inside a runo worktree >
 * cwd's repo+branch > --branch within the cwd's repo. A branch with several
 * profiles needs --profile (RUNO_PROFILE) to pick one, unless the cwd is a
 * runo-owned worktree, which belongs to exactly one env.
 */
export function resolveEnv(opts: { branch?: string; profile?: string } = {}): EnvRecord {
  const cwd = process.cwd();
  const profile = opts.profile ?? profileFromEnv();
  const byWorktree = registry.findByCwd(cwd);
  if (byWorktree?.server && byWorktree.server !== process.env.RUNO_SERVER?.replace(/\/+$/, ""))
    throw new RunoError(`This checkout is attached to ${byWorktree.server}; set RUNO_SERVER accordingly`);
  // A runo-created worktree is one env; an external one (--here, attach) may
  // anchor one env per profile, so only trust it when the profile agrees.
  if (byWorktree && !opts.branch && (profile === undefined || byWorktree.profile === profile)) return byWorktree;

  const top = repoTop(cwd);
  if (top) {
    const branch = opts.branch ?? (byWorktree ? byWorktree.branch : currentBranch(top));
    const found = registry.findByRepoBranch(top, branch, profile);
    if (found) return found;
    if (byWorktree && profile === undefined) return byWorktree;
    throw new RunoError(
      `No environment registered for ${path.basename(top)} @ ${branch}${profile ? ` (profile ${profile})` : ""}`,
      "Create one with `runo new <name>` (or list existing envs with `runo ls`)",
    );
  }
  if (byWorktree) return byWorktree;
  throw new RunoError(
    "Outside a git repository and any runo worktree",
    "Run inside the project repo or a runo-created worktree (`runo ls` shows the paths)",
  );
}

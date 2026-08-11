import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { RunoError } from "../errors";
import { git } from "./context";

/**
 * Ensures the env's local worktree: the sync anchor — upload source,
 * `runo pull` destination.
 */
export function ensureWorktree(
  repoPath: string,
  branch: string,
  dest: string,
  opts: { createBranch?: boolean } = {},
): string {
  if (existsSync(path.join(dest, ".git"))) return dest;
  mkdirSync(path.dirname(dest), { recursive: true });
  const args = opts.createBranch
    ? ["worktree", "add", "-b", branch, dest]
    : ["worktree", "add", dest, branch];
  const r = git(repoPath, ...args);
  if (r.exitCode !== 0) {
    if (/already checked out/i.test(r.stderr))
      throw new RunoError(
        `Branch "${branch}" is already checked out in the main working tree (${repoPath})`,
        "Use `runo new <name>` to create a dedicated task branch — runo works in its own worktrees so it never fights your checkout",
      );
    if (/already exists/i.test(r.stderr) && opts.createBranch)
      throw new RunoError(
        `Branch "${branch}" already exists`,
        `If you want an env for it: runo up --branch ${branch}`,
      );
    if (/invalid reference|not a valid ref/i.test(r.stderr))
      throw new RunoError(`Branch "${branch}" does not exist in ${repoPath}`, "Create it with `runo new <name>`");
    throw new RunoError(`git worktree add failed: ${r.stderr}`);
  }
  return dest;
}

export function removeWorktree(repoPath: string, dest: string): void {
  if (!existsSync(dest)) {
    git(repoPath, "worktree", "prune");
    return;
  }
  const r = git(repoPath, "worktree", "remove", "--force", dest);
  if (r.exitCode !== 0) {
    rmSync(dest, { recursive: true, force: true });
    git(repoPath, "worktree", "prune");
  }
}

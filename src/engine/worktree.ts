import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { RunoError } from "../errors";
import { git } from "./context";

/**
 * Garante o worktree local do env (decisão 9): âncora de sync — origem do
 * upload, destino do `runo pull`.
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
        `A branch "${branch}" já está checked out no working tree principal (${repoPath})`,
        "Use `runo new <nome>` para criar uma task branch dedicada — o runo trabalha em worktrees próprios para não disputar o seu checkout",
      );
    if (/already exists/i.test(r.stderr) && opts.createBranch)
      throw new RunoError(
        `A branch "${branch}" já existe`,
        `Se quer um env para ela: runo up --branch ${branch}`,
      );
    if (/invalid reference|not a valid ref/i.test(r.stderr))
      throw new RunoError(`Branch "${branch}" não existe em ${repoPath}`, "Crie com `runo new <nome>`");
    throw new RunoError(`git worktree add falhou: ${r.stderr}`);
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

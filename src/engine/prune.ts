import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TMP_DIR } from "../config";
import type { Runtime, RuntimeProvider } from "../provider/types";
import { shq } from "../ssh";
import { git } from "./context";

/** What `runo push` never syncs, so it never prunes either. */
export const PUSH_EXCLUDES = [".git", "node_modules", "dist", ".kodus"];

/**
 * Files git lists on the VM that it no longer lists here: deleted or renamed
 * since the env was created. Both lists come from
 * `git ls-files -co --exclude-standard` (tracked + untracked-not-ignored), so
 * ignored files — caches, .env, node_modules, build output — never qualify.
 */
export function staleOnRemote(
  local: Iterable<string>,
  remote: Iterable<string>,
  excludes: string[] = PUSH_EXCLUDES,
): string[] {
  const here = new Set(local);
  return [...remote].filter(
    (file) =>
      !here.has(file) &&
      !excludes.some((dir) => file === dir || file.startsWith(`${dir}/`)),
  );
}

const lsFiles = (stdout: string) => stdout.split("\0").filter(Boolean);

/**
 * rsync never deletes, so a file removed or renamed here lived on in the VM's
 * copy: a dead route kept rendering, a deleted spec kept running (and
 * failing). Mirrors deletions the way git sees the tree. Returns how many
 * files it removed; any failure to list either side leaves the VM untouched.
 */
export async function pruneRemote(
  provider: RuntimeProvider,
  rt: Runtime,
  worktree: string,
  remoteDir: string,
): Promise<number> {
  const local = git(worktree, "ls-files", "-z", "-co", "--exclude-standard");
  if (local.exitCode !== 0) return 0;
  const remote = await provider.exec(rt, "git ls-files -z -co --exclude-standard", {
    cwd: remoteDir,
  });
  if (remote.exitCode !== 0) return 0;

  const stale = staleOnRemote(lsFiles(local.stdout), lsFiles(remote.stdout));
  if (stale.length === 0) return 0;

  // Through a file, not argv: a big rename can list thousands of paths.
  mkdirSync(TMP_DIR, { recursive: true });
  const localList = path.join(TMP_DIR, `prune-${process.pid}-${Date.now()}`);
  const remoteList = `/tmp/runo-prune-${process.pid}-${Date.now()}`;
  writeFileSync(localList, stale.join("\0"));
  try {
    await provider.upload(rt, localList, remoteList);
  } finally {
    rmSync(localList, { force: true });
  }
  // `git ls-files -c` still lists paths already gone from the VM's disk, so
  // count what rm actually removed rather than the list.
  const removed = await provider.exec(
    rt,
    `xargs -0 rm -fv -- < ${shq(remoteList)} | wc -l; rm -f ${shq(remoteList)}`,
    { cwd: remoteDir },
  );
  return Number.parseInt(removed.stdout.trim(), 10) || 0;
}

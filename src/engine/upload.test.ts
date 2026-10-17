import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codeExtractCommand } from "./up";

const sh = (cmd: string, cwd?: string) => {
  const r = Bun.spawnSync(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd}\n${r.stderr.toString()}`);
  return r.stdout.toString();
};
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

test("a warm tree syncs the commit: removed files go, ignored builds stay", () => {
  const root = mkdtempSync(path.join(tmpdir(), "runo-sync-"));
  const remote = path.join(root, "app");
  // the tree the base image carries: a committed checkout plus ignored output
  put(path.join(remote, ".gitignore"), "node_modules/\ndist/\n");
  put(path.join(remote, "a.txt"), "old");
  put(path.join(remote, "gone.txt"), "deleted by the new commit");
  put(path.join(remote, "pkg", "gone-too.ts"), "x");
  put(path.join(remote, "pkg", "kept.ts"), "x");
  sh("git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm base", remote);
  put(path.join(remote, "node_modules", "dep", "index.js"), "dependency");
  put(path.join(remote, "pkg", "dist", "kept.js"), "build output");
  put(path.join(remote, "scratch.md"), "untracked, not ignored");
  sh("touch -t 202001010000 pkg/kept.ts", remote);

  // the new commit
  const src = path.join(root, "src");
  put(path.join(src, ".gitignore"), "node_modules/\ndist/\n");
  put(path.join(src, "a.txt"), "new");
  put(path.join(src, "pkg", "kept.ts"), "x");
  put(path.join(src, "pkg", "added.ts"), "y");
  put(path.join(src, "file with space.txt"), "z");
  const tar = path.join(root, "code.tar");
  sh(`tar -cf ${JSON.stringify(tar)} -C ${JSON.stringify(src)} .`);

  sh(codeExtractCommand(remote, tar, true));

  expect(readFileSync(path.join(remote, "a.txt"), "utf8")).toBe("new");
  expect(existsSync(path.join(remote, "pkg", "added.ts"))).toBe(true);
  expect(existsSync(path.join(remote, "file with space.txt"))).toBe(true);
  expect(existsSync(path.join(remote, "gone.txt"))).toBe(false);
  expect(existsSync(path.join(remote, "pkg", "gone-too.ts"))).toBe(false);
  expect(readFileSync(path.join(remote, "node_modules", "dep", "index.js"), "utf8")).toBe("dependency");
  expect(readFileSync(path.join(remote, "pkg", "dist", "kept.js"), "utf8")).toBe("build output");
  expect(existsSync(path.join(remote, "scratch.md"))).toBe(true);
  // untouched by the commit: same mtime, so an incremental build skips it
  expect(statSync(path.join(remote, "pkg", "kept.ts")).mtime.getFullYear()).toBe(2020);
  expect(existsSync(path.join(remote, ".git"))).toBe(true);
  expect(existsSync(tar)).toBe(false);
  expect(existsSync(`${remote}.runo-stage`)).toBe(false);
});

test("a cold tree is replaced", () => {
  const cmd = codeExtractCommand("/home/ubuntu/app", "/tmp/runo-code.tar", false);
  expect(cmd.startsWith("sudo rm -rf '/home/ubuntu/app'")).toBe(true);
});

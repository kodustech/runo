import { expect, test } from "bun:test";
import { staleOnRemote } from "./prune";

test("lists files the VM still has that are gone here", () => {
  expect(
    staleOnRemote(
      ["src/app.ts", "src/new-name.ts"],
      ["src/app.ts", "src/old-name.ts", "src/removed.spec.ts"],
    ),
  ).toEqual(["src/old-name.ts", "src/removed.spec.ts"]);
});

test("never prunes what push never syncs", () => {
  expect(
    staleOnRemote(
      ["src/app.ts"],
      [
        "src/app.ts",
        ".kodus/evidence/abc.md",
        "node_modules/x/index.js",
        "dist/main.js",
        ".git/HEAD",
        ".kodus",
      ],
    ),
  ).toEqual([]);
});

test("an exclude only matches whole path segments", () => {
  expect(staleOnRemote([], ["distribution/readme.md", "dist-notes.md"])).toEqual([
    "distribution/readme.md",
    "dist-notes.md",
  ]);
});

test("nothing is stale when both sides match", () => {
  expect(staleOnRemote(["a", "b"], ["b", "a"])).toEqual([]);
});

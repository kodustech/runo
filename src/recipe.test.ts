import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRecipe, recipeCandidates } from "./recipe";

const saved = { RUNO_RECIPE: process.env.RUNO_RECIPE, RUNO_PROFILE: process.env.RUNO_PROFILE };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

test("--recipe wins, then the env's remembered recipe, then the profile's file, then the default", () => {
  delete process.env.RUNO_RECIPE;
  delete process.env.RUNO_PROFILE;
  expect(recipeCandidates()).toEqual([".kodus/workspace.yaml"]);
  process.env.RUNO_PROFILE = "cloud";
  expect(recipeCandidates()).toEqual([".kodus/workspace.cloud.yaml", ".kodus/workspace.yaml"]);
  expect(recipeCandidates(".kodus/workspace.preview.yaml")).toEqual([".kodus/workspace.preview.yaml"]);
  process.env.RUNO_RECIPE = ".kodus/other.yaml";
  expect(recipeCandidates(".kodus/workspace.preview.yaml")).toEqual([".kodus/other.yaml"]);
});

test("a profile without its own recipe file falls back to the default recipe", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runo-recipe-test-"));
  try {
    mkdirSync(path.join(dir, ".kodus"));
    const yaml = (port: number) => `version: 1\nservices:\n  api:\n    run: bun app.ts\n    port: ${port}\n`;
    writeFileSync(path.join(dir, ".kodus/workspace.yaml"), yaml(3000));
    writeFileSync(path.join(dir, ".kodus/workspace.cloud.yaml"), yaml(4000));
    delete process.env.RUNO_RECIPE;
    process.env.RUNO_PROFILE = "cloud";
    expect(loadRecipe(dir).path).toBe(path.join(dir, ".kodus/workspace.cloud.yaml"));
    process.env.RUNO_PROFILE = "self-hosted";
    expect(loadRecipe(dir).path).toBe(path.join(dir, ".kodus/workspace.yaml"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

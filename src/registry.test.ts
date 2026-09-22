import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// the registry resolves RUNO_HOME at import time
const home = mkdtempSync(path.join(tmpdir(), "runo-registry-test-"));
process.env.RUNO_HOME = home;
const { registry, AmbiguousEnvError } = await import("./registry");

function record(name: string, profile?: string) {
  return {
    name, repo: "app", repoPath: "/repo/app", branch: "pr-1", slug: profile ? `pr-1-${profile}` : "pr-1", profile,
    worktree: `/wt/${name}`, provider: "aws", runtime: {}, state: "running" as const, publicServices: [],
    createdAt: "", updatedAt: "",
  };
}

test("one branch, one env per profile — a lookup without the profile refuses to guess", () => {
  try {
    registry.upsert(record("only"));
    expect(registry.findByRepoBranch("/repo/app", "pr-1")?.name).toBe("only");
    expect(registry.findByRepoBranch("/repo/app", "pr-1", "cloud")).toBeUndefined();

    registry.remove("only");
    registry.upsert(record("cloud", "cloud"));
    registry.upsert(record("selfhosted", "self-hosted"));
    expect(registry.listByRepoBranch("/repo/app", "pr-1").map((e) => e.name).sort()).toEqual(["cloud", "selfhosted"]);
    expect(registry.findByRepoBranch("/repo/app", "pr-1", "cloud")?.name).toBe("cloud");
    expect(registry.findByRepoBranch("/repo/app", "pr-1", "self-hosted")?.name).toBe("selfhosted");
    expect(() => registry.findByRepoBranch("/repo/app", "pr-1")).toThrow(AmbiguousEnvError);
    // a single profiled env is still the branch's env when nothing narrower is asked
    registry.remove("selfhosted");
    expect(registry.findByRepoBranch("/repo/app", "pr-1")?.name).toBe("cloud");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

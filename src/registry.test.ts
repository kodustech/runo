import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// RUNO_HOME is resolved once, when config.ts is first imported — by whichever
// test file bun loaded first. Run against a throwaway home in a child process
// so this never touches the developer's real registry.
function inHome(script: string): string {
  const home = mkdtempSync(path.join(tmpdir(), "runo-registry-test-"));
  try {
    const proc = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: import.meta.dir,
      env: { ...process.env, RUNO_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    return proc.stdout.toString();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const prelude = `
  const { registry, AmbiguousEnvError } = await import("./registry.ts");
  const record = (name, profile, worktree = "/wt/" + name) => ({
    name, repo: "app", repoPath: "/repo/app", branch: "pr-1", slug: profile ? "pr-1-" + profile : "pr-1", profile,
    worktree, provider: "aws", runtime: {}, state: "running", publicServices: [], createdAt: "", updatedAt: "",
  });
  const out = (label, value) => console.log(label + "=" + JSON.stringify(value));
`;

test("one branch, one env per profile — a lookup without the profile refuses to guess", () => {
  const out = inHome(`${prelude}
    registry.upsert(record("only"));
    out("single", registry.findByRepoBranch("/repo/app", "pr-1")?.name);
    out("single-other-profile", registry.findByRepoBranch("/repo/app", "pr-1", "cloud"));
    registry.remove("only");
    registry.upsert(record("cloud", "cloud"));
    registry.upsert(record("selfhosted", "self-hosted"));
    out("list", registry.listByRepoBranch("/repo/app", "pr-1").map((e) => e.name).sort());
    out("cloud", registry.findByRepoBranch("/repo/app", "pr-1", "cloud")?.name);
    out("self", registry.findByRepoBranch("/repo/app", "pr-1", "self-hosted")?.name);
    try { registry.findByRepoBranch("/repo/app", "pr-1"); out("ambiguous", "no error"); }
    catch (e) { out("ambiguous", e instanceof AmbiguousEnvError ? e.message : String(e)); }
    registry.remove("selfhosted");
    out("last", registry.findByRepoBranch("/repo/app", "pr-1")?.name);
  `);
  expect(out).toContain('single="only"');
  expect(out).toContain("single-other-profile=undefined");
  expect(out).toContain('list=["cloud","selfhosted"]');
  expect(out).toContain('cloud="cloud"');
  expect(out).toContain('self="selfhosted"');
  expect(out).toContain('ambiguous="pr-1 has more than one environment (profiles: cloud, self-hosted)"');
  expect(out).toContain('last="cloud"');
});

test("an external worktree may anchor one env per profile", () => {
  const out = inHome(`${prelude}
    registry.upsert(record("cloud", "cloud", "/checkout"));
    registry.upsert(record("selfhosted", "self-hosted", "/checkout"));
    out("anchored", registry.listByCwd("/checkout/apps/api").map((e) => e.name).sort());
    out("elsewhere", registry.listByCwd("/elsewhere"));
  `);
  expect(out).toContain('anchored=["cloud","selfhosted"]');
  expect(out).toContain("elsewhere=[]");
});

import { expect, test } from "bun:test";
import { RemoteProvider } from "./remote";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("fresh CI runner discovers existing shared environment without local state", async () => {
  const requests: any[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    expect(req.headers.get("authorization")).toBe("Bearer qa-token");
    if (new URL(req.url).pathname === "/v1/envs")
      return Response.json({ result: [{ repo: "kodus-ai", branch: "fix/test", instanceId: "i-preview" }] });
    const body = await req.json();
    requests.push(body);
    return Response.json({ result: { id: "i-preview", ip: "127.0.0.1", state: "running" } });
  }});
  try {
    const provider = new RemoteProvider(server.url.toString(), "qa-token");
    expect((await provider.findByTags("kodus-ai", "fix/test"))?.id).toBe("i-preview");
    expect(await provider.findByTags("kodus-ai", "missing")).toBeNull();
    expect(requests[0]).toEqual({ method: "status", args: [{ id: "i-preview", ip: null, state: "unknown" }] });
  } finally { server.stop(true); }
});

test("sharing errors are surfaced to CI", async () => {
  const server = Bun.serve({ port: 0, fetch() {
    return Response.json({ error: { message: "Environment access denied" } }, { status: 403 });
  }});
  try {
    const provider = new RemoteProvider(server.url.toString(), "token");
    await expect(provider.share("i-preview", ["qa"])).rejects.toThrow("Environment access denied");
  } finally { server.stop(true); }
});

test("CLI attaches a fresh checkout and executes on the shared VM without SSH keys", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runo-attach-test-"));
  const checkout = path.join(dir, "app");
  mkdirSync(path.join(checkout, ".kodus"), { recursive: true });
  Bun.spawnSync(["git", "init", checkout], { stdout: "pipe", stderr: "pipe" });
  writeFileSync(path.join(checkout, ".kodus/workspace.preview.yaml"), "version: 1\nservices:\n  api:\n    run: bun app.ts\n    port: 3000\n");
  const commands: any[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const route = new URL(req.url).pathname;
    if (route === "/v1/envs") return Response.json({ result: [{
      envName: "preview-123", slug: "pr-123", repo: "app", branch: "feature",
      owner: "ci", instanceId: "i-preview", recipe: ".kodus/workspace.preview.yaml",
      createdAt: new Date().toISOString(),
    }] });
    const body = await req.json() as any;
    if (route === "/v1/rpc") return Response.json({ result: { id: "i-preview", ip: "192.0.2.10", state: "running" } });
    commands.push(body);
    return new Response('{"t":"out","d":"database-ok"}\n{"t":"exit","code":0}\n');
  }});
  const env = { ...process.env, RUNO_HOME: path.join(dir, "state"), RUNO_SERVER: server.url.toString(), RUNO_TOKEN: "qa-token", RUNO_RECIPE: "" };
  const run = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, new URL("../../bin/runo.ts", import.meta.url).pathname, ...args], {
      cwd: checkout, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    return { code: await proc.exited, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
  };
  try {
    const attached = await run("attach", "preview-123");
    expect(attached.stderr).toBe("");
    expect(attached.code).toBe(0);
    const record = JSON.parse(readFileSync(path.join(dir, "state/envs.json"), "utf8")).envs["preview-123"];
    expect(record.runtime.id).toBe("i-preview");
    expect(record.externalWorktree).toBe(true);
    expect(record.recipe).toBe(".kodus/workspace.preview.yaml");
    const executed = await run("exec", "--", "docker", "exec", "db_postgres", "psql", "--version");
    expect(executed.code).toBe(0);
    expect(executed.stdout).toContain("database-ok");
    expect(commands[0].rt.id).toBe("i-preview");
    expect(commands[0].command).toContain("docker exec db_postgres psql --version");
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two profiles of one branch are two environments on the control plane", async () => {
  const server = Bun.serve({ port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/v1/envs")
      return Response.json({ result: [
        { envName: "pr-1-cloud", repo: "kodus-ai", branch: "fix/test", profile: "cloud", instanceId: "i-cloud" },
        { envName: "pr-1-self-hosted", repo: "kodus-ai", branch: "fix/test", profile: "self-hosted", instanceId: "i-self" },
        { envName: "pr-2", repo: "kodus-ai", branch: "fix/other", instanceId: "i-plain" },
      ] });
    const body = await req.json();
    return Response.json({ result: { id: body.args[0].id, ip: "127.0.0.1", state: "running" } });
  }});
  try {
    const provider = new RemoteProvider(server.url.toString(), "qa-token");
    expect((await provider.findByTags("kodus-ai", "fix/test", "cloud"))?.id).toBe("i-cloud");
    expect((await provider.findByTags("kodus-ai", "fix/test", "self-hosted"))?.id).toBe("i-self");
    // no profile never adopts a profiled env, and a profile never adopts a plain one
    expect(await provider.findByTags("kodus-ai", "fix/test")).toBeNull();
    expect(await provider.findByTags("kodus-ai", "fix/other", "cloud")).toBeNull();
    expect((await provider.findByTags("kodus-ai", "fix/other"))?.id).toBe("i-plain");
    const all = await provider.listByBranch("kodus-ai", "fix/test");
    expect(all.map((rt) => [rt.id, rt.profile])).toEqual([["i-cloud", "cloud"], ["i-self", "self-hosted"]]);
  } finally { server.stop(true); }
});

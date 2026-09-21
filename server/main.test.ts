import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type Call = (route: string, user: string, body?: unknown) => Promise<Response>;

async function withServer(run: (request: Call, port: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "runo-access-test-"));
  writeFileSync(path.join(dir, "server-envs.json"), JSON.stringify({ preview: {
    envName: "preview", owner: "ci", members: ["qa"], instanceId: "i-preview",
    repo: "app", branch: "pr-1", slug: "pr-1", createdAt: new Date().toISOString(),
  }}));
  // Mock cloud access in a separate process so module mocks never leak to other tests.
  const source = `
    import { mock } from "bun:test";
    mock.module(${JSON.stringify(new URL("../src/provider/aws.ts", import.meta.url).pathname)}, () => ({
      Ec2Provider: class {
        async status(rt) { return { id: rt.id, ip: "192.0.2.10", state: "running" }; }
        async exec(rt) { return { exitCode: 0, stdout: rt.ip, stderr: "" }; }
        async listManaged() { return [{ id: "i-preview", ip: "192.0.2.10", state: "running" }]; }
        async suspend(rt) { return { ...rt, state: "stopped" }; }
        async destroy() {}
        async poolStatus() { return []; }
      }
    }));
    await import(${JSON.stringify(new URL("./main.ts", import.meta.url).pathname)});
  `;
  const proc = Bun.spawn([process.execPath, "-e", source], {
    env: { ...process.env, RUNO_HOME: dir, RUNO_SERVER_PORT: "0", RUNO_INGRESS_DOMAIN: "", RUNO_PUBLIC_URL: "",
      RUNO_GITHUB_CLIENT_ID: "", RUNO_GITHUB_CLIENT_SECRET: "", RUNO_SERVER_ADMINS: "boss",
      RUNO_SERVER_TOKENS: "ci:ci-token,qa:qa-token,stranger:stranger-token,boss:boss-token" },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    const reader = proc.stdout.getReader();
    let output = "";
    let port: string | undefined;
    while (!port) {
      const next = await reader.read();
      if (next.done) throw new Error(`Server exited: ${await new Response(proc.stderr).text()}`);
      output += new TextDecoder().decode(next.value);
      port = output.match(/listening on :(\d+)/)?.[1];
    }
    reader.releaseLock();
    const request: Call = (route, user, body) => fetch(`http://localhost:${port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${user}-token`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await run(request, port);
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}

const rt = { id: "i-preview", ip: "attacker.example", state: "running" };

test("HTTP routes enforce environment grants and ignore supplied SSH addresses", () => withServer(async (request) => {
    expect((await (await request("/v1/envs", "stranger")).json() as any).result).toEqual([]);
    for (const [route, body] of [
      ["/v1/exec", { rt, command: "psql" }],
      ["/v1/download", { rt, remotePath: "/tmp/" }],
      ["/v1/register-services", { rt, services: [] }],
      ["/v1/rpc", { method: "status", args: [rt] }],
    ] as const) expect((await request(route, "stranger", body)).status).toBe(403);
    expect((await request(`/v1/upload?rt=${encodeURIComponent(JSON.stringify(rt))}&path=/tmp/test`, "stranger", {})).status).toBe(403);
    expect((await request(`/v1/tty?rt=${encodeURIComponent(JSON.stringify(rt))}&cmd=eA==`, "stranger")).status).toBe(403);
    const execution = await request("/v1/exec", "qa", { rt, command: "psql" });
    expect(execution.status).toBe(200);
    expect((await execution.json() as any).result.stdout).toBe("192.0.2.10");
    expect((await request("/v1/share", "qa", { id: rt.id, members: ["stranger"] })).status).toBe(403);
    expect((await request("/v1/rpc", "qa", { method: "destroy", args: [rt] })).status).toBe(403);
    expect((await request("/v1/share", "ci", { id: rt.id, members: [] })).status).toBe(200);
    expect((await request("/v1/exec", "qa", { rt, command: "psql" })).status).toBe(403);
}), 15000);

test("a browser session runs the panel but cannot reach a VM, skip CSRF, or act as admin", () => withServer(async (request, port) => {
  const base = `http://localhost:${port}`;
  const login = await fetch(`${base}/auth/token`, {
    method: "POST", headers: { "content-type": "application/json", "x-runo-panel": "1" }, body: JSON.stringify({ token: "ci-token" }),
  });
  const cookie = login.headers.get("set-cookie")!;
  expect(cookie).toMatch(/^runo_session=[\w-]+; Path=\/; HttpOnly; SameSite=Lax/);
  const session = (route: string, method = "GET", body?: unknown, headers: Record<string, string> = { "x-runo-panel": "1" }) =>
    fetch(base + route, { method, headers: { cookie: cookie.split(";")[0], "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });

  expect(await (await session("/v1/me")).json()).toMatchObject({ result: { user: "ci", via: "session", admin: false } });
  expect((await fetch(`${base}/auth/token`, { method: "POST", headers: { "x-runo-panel": "1" }, body: JSON.stringify({ token: "guess" }) })).status).toBe(401);

  // the owner's own session still gets no shell, and cannot create machines
  expect((await session("/v1/exec", "POST", { rt, command: "id" })).status).toBe(403);
  expect((await session(`/v1/tty?rt=${encodeURIComponent(JSON.stringify(rt))}&cmd=eA==`)).status).toBe(403);
  expect((await session("/v1/rpc", "POST", { method: "create", args: [{}] })).status).toBe(403);
  // writes without the panel header, or from another origin, are refused
  expect((await session("/v1/rpc", "POST", { method: "suspend", args: [rt] }, {})).status).toBe(403);
  expect((await session("/v1/rpc", "POST", { method: "suspend", args: [rt] }, { "x-runo-panel": "1", origin: "https://evil.example" })).status).toBe(403);
  expect((await session("/v1/rpc", "POST", { method: "suspend", args: [rt] })).status).toBe(200);
  // configuration is admin-only
  expect((await session("/v1/policies", "PUT", { max_disk_gb: 1 })).status).toBe(403);
  expect((await session("/v1/users")).status).toBe(403);

  // admin: edits policies (validated, audited), manages any machine's lifecycle, still no VM access
  expect((await request("/v1/policies", "boss", undefined)).status).toBe(200);
  const put = (route: string, body: unknown) => fetch(base + route, { method: "PUT", headers: { authorization: "Bearer boss-token" }, body: JSON.stringify(body) });
  expect((await put("/v1/policies", { max_disk_gb: "huge" })).status).toBe(400);
  expect((await put("/v1/policies", { max_disk_gb: 80, max_running_total: 4 })).status).toBe(200);
  expect(await (await request("/v1/policies", "stranger")).json()).toEqual({ result: { max_disk_gb: 80, max_running_total: 4 } });
  expect((await request("/v1/exec", "boss", { rt, command: "id" })).status).toBe(403);
  expect((await request("/v1/rpc", "boss", { method: "destroy", args: [rt] })).status).toBe(200);

  const history = (await (await request("/v1/machines?days=1", "boss")).json() as any).result;
  expect(history[0]).toMatchObject({ instanceId: "i-preview", owner: "ci", endedBy: "boss", endReason: "destroy" });
  expect((await (await request("/v1/machines?days=1", "stranger")).json() as any).result).toEqual([]);
  const actions = (await (await request("/v1/events", "boss")).json() as any).result.map((e: any) => `${e.actor}:${e.action}`);
  expect(actions).toEqual(expect.arrayContaining(["boss:destroy", "boss:policies.update", "ci:suspend", "ci:login"]));

  await session("/auth/logout", "POST");
  expect((await session("/v1/me")).status).toBe(401);
}), 15000);

import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("HTTP routes enforce environment grants and ignore supplied SSH addresses", async () => {
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
      }
    }));
    await import(${JSON.stringify(new URL("./main.ts", import.meta.url).pathname)});
  `;
  const proc = Bun.spawn([process.execPath, "-e", source], {
    env: { ...process.env, RUNO_HOME: dir, RUNO_SERVER_PORT: "0", RUNO_INGRESS_DOMAIN: "",
      RUNO_SERVER_TOKENS: "ci:ci-token,qa:qa-token,stranger:stranger-token" },
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
    const request = (route: string, user: string, body?: unknown) => fetch(`http://localhost:${port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${user}-token`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const rt = { id: "i-preview", ip: "attacker.example", state: "running" };
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
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

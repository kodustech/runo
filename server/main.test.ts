import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type Call = (route: string, user: string, body?: unknown, signal?: AbortSignal) => Promise<Response>;

async function withServer(run: (request: Call, port: string, dir: string) => Promise<void>, maxInstances = "5"): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "runo-access-test-"));
  writeFileSync(path.join(dir, "server-envs.json"), JSON.stringify({ preview: {
    envName: "preview", owner: "ci", members: ["qa"], instanceId: "i-preview",
    repo: "app", branch: "pr-1", slug: "pr-1", createdAt: new Date().toISOString(),
  }}));
  // Mock cloud access in a separate process so module mocks never leak to other tests.
  const source = `
    import { mock } from "bun:test";
    import { Ec2Provider as RealEc2Provider } from ${JSON.stringify(new URL("../src/provider/aws.ts", import.meta.url).pathname)};
    const fleet = [{ id: "i-preview", ip: "192.0.2.10", state: "running" }];
    let nextId = 0;
    class TestEc2Provider extends RealEc2Provider {
      constructor(options) {
        super(options);
        this.ensureKeyPair = async () => {};
        this.ensureSecurityGroup = async () => "sg-test";
        this.canonicalAmi = async () => ({ amiId: "ami-test", rootDevice: "/dev/sda1" });
        this.waitReady = async () => {};
        this.claimFromPool = async () => null;
        this.launchInstance = async (options) => {
          await Bun.sleep(40);
          if (options.tags.some((tag) => tag.Key === "runo:env" && tag.Value === "cloud-failure")) throw new Error("simulated cloud failure");
          const rt = { id: "i-new-" + (++nextId), ip: "192.0.2.11", state: "running", instanceType: options.instanceType };
          fleet.push(rt);
          return rt.id;
        };
        this.waitForState = async (id) => fleet.find((rt) => rt.id === id);
        this.ec2 = { send: async (cmd) => {
          switch (cmd.constructor.name) {
            case "RunInstancesCommand":
              fleet.push({ id: "i-bake", ip: "192.0.2.12", state: "running" });
              return { Instances: [{ InstanceId: "i-bake" }] };
            case "StartInstancesCommand":
              await Bun.sleep(40);
              fleet.find((rt) => rt.id === cmd.input.InstanceIds[0]).state = "running";
              return {};
            case "StopInstancesCommand":
            case "TerminateInstancesCommand":
              fleet.find((rt) => rt.id === cmd.input.InstanceIds[0]).state = cmd.constructor.name === "StopInstancesCommand" ? "stopped" : "terminated";
              return {};
            case "CreateImageCommand":
              await Bun.write(process.env.RUNO_HOME + "/bake-image-pending", "1");
              while (!await Bun.file(process.env.RUNO_HOME + "/bake-image-release").exists()) await Bun.sleep(5);
              return { ImageId: "ami-baked" };
            case "DescribeImagesCommand": return { Images: [{ State: "available" }] };
            default: throw new Error("unexpected cloud command: " + cmd.constructor.name);
          }
        }};
      }
      async status(rt) { return fleet.find((entry) => entry.id === rt.id) ?? { id: rt.id, ip: null, state: "terminated" }; }
      async exec(rt) { return { exitCode: 0, stdout: rt.ip, stderr: "" }; }
      async listManaged() { return fleet; }
      async suspend(rt) { const entry = fleet.find((entry) => entry.id === rt.id); entry.state = "stopped"; return entry; }
      async destroy(rt) { fleet.find((entry) => entry.id === rt.id).state = "terminated"; }
      async poolStatus() { return []; }
      async ensurePorts() {}
    }
    mock.module(${JSON.stringify(new URL("../src/provider/aws.ts", import.meta.url).pathname)}, () => ({ Ec2Provider: TestEc2Provider }));
    await import(${JSON.stringify(new URL("./main.ts", import.meta.url).pathname)});
  `;
  const proc = Bun.spawn([process.execPath, "-e", source], {
    env: { ...process.env, RUNO_PROVIDER: "aws", RUNO_HOME: dir, RUNO_MAX_INSTANCES: maxInstances, RUNO_SERVER_PORT: "0", RUNO_INGRESS_DOMAIN: "", RUNO_PUBLIC_URL: "",
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
    const request: Call = (route, user, body, signal) => fetch(`http://localhost:${port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${user}-token`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    await run(request, port, dir);
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
  // publishing a preview must not take an admin: 80/443 are open to everyone, the rest is not
  expect((await request("/v1/rpc", "stranger", { method: "ensurePorts", args: [[80, 443]] })).status).toBe(200);
  expect((await request("/v1/rpc", "stranger", { method: "ensurePorts", args: [[5432]] })).status).toBe(403);
  expect((await request("/v1/rpc", "boss", { method: "ensurePorts", args: [[5432]] })).status).toBe(200);
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

test("a branch may own one environment per profile, never two of the same", () => withServer(async (request) => {
  const spec = (profile?: string) => ({
    envName: profile ? `preview-${profile}` : "preview-again", slug: profile ? `pr-1-${profile}` : "pr-1",
    repo: "app", branch: "pr-1", instanceType: "t3.micro", diskGb: 20, ...(profile ? { profile } : {}),
  });
  // "preview" (app@pr-1, no profile) already exists: a second profile-less env is refused
  expect((await request("/v1/rpc", "ci", { method: "create", args: [spec()] })).ok).toBe(false);
  expect((await request("/v1/rpc", "ci", { method: "create", args: [spec("cloud")] })).ok).toBe(true);
  expect((await request("/v1/rpc", "ci", { method: "create", args: [spec("self-hosted")] })).ok).toBe(true);
  expect((await request("/v1/rpc", "ci", { method: "create", args: [spec("cloud")] })).ok).toBe(false);
  const envs = (await (await request("/v1/envs", "ci")).json() as any).result;
  expect(envs.map((e: any) => [e.envName, e.profile ?? null]).sort()).toEqual([
    ["preview", null], ["preview-cloud", "cloud"], ["preview-self-hosted", "self-hosted"],
  ]);
}), 15000);

for (const environmentLimit of ["5", ""]) {
  test(`panel capacity overrides ${environmentLimit || "the default CLI limit"} and hot-reloads through the real provider`, () => withServer(async (request, port) => {
    const put = async (policy: unknown) => {
      const response = await fetch(`http://localhost:${port}/v1/policies`, {
        method: "PUT", headers: { authorization: "Bearer boss-token" }, body: JSON.stringify(policy),
      });
      expect(response.status).toBe(200);
    };
    const create = (index: number) => request("/v1/rpc", "ci", { method: "create", args: [{
      envName: `capacity-${index}`, slug: `capacity-${index}`, repo: "app", branch: `capacity-${index}`, instanceType: "t3.micro", diskGb: 20,
    }] });
    await put({ max_running_total: 10 });
    expect(await (await request("/v1/server", "boss")).json()).toMatchObject({ result: { maxInstances: 10 } });
    // The fixture starts with one machine; the CLI environment setting never changes.
    for (let index = 2; index <= 10; index++) expect((await create(index)).status).toBe(200);
    const blocked = await create(11);
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({ error: { message: expect.stringContaining("limit 10") } });
    await put({ max_running_total: 11 });
    expect((await create(11)).status).toBe(200);
    expect(await (await request("/v1/server", "boss")).json()).toMatchObject({ result: { maxInstances: 11 } });
    await put({});
    expect((await create(12)).status).toBe(200);
    expect(await (await request("/v1/server", "boss")).json()).toMatchObject({ result: { maxInstances: null } });
  }, environmentLimit), 15000);
}

test("resuming observes panel capacity for the machine's owner, including an admin resume", () => withServer(async (request, port) => {
  const put = async (policy: unknown) => {
    expect((await fetch(`http://localhost:${port}/v1/policies`, {
      method: "PUT", headers: { authorization: "Bearer boss-token" }, body: JSON.stringify(policy),
    })).status).toBe(200);
  };
  expect((await request("/v1/rpc", "ci", { method: "create", args: [{ envName: "second", slug: "second", branch: "second", repo: "app", instanceType: "t3.micro", diskGb: 20 }] })).status).toBe(200);
  expect((await request("/v1/rpc", "ci", { method: "suspend", args: [rt] })).status).toBe(200);
  await put({ max_envs_per_user: 1, max_running_total: 10 });
  for (const user of ["ci", "boss"]) {
    const response = await request("/v1/rpc", user, { method: "resume", args: [rt] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("limit 1") } });
  }
  await put({ max_running_total: 1 });
  expect((await request("/v1/rpc", "ci", { method: "resume", args: [rt] })).status).toBe(400);
  await put({ max_running_total: 2 });
  expect((await request("/v1/rpc", "ci", { method: "resume", args: [rt] })).status).toBe(200);
  expect((await request("/v1/rpc", "ci", { method: "resume", args: [rt] })).status).toBe(200);
}), 15000);

for (const quota of ["owner", "organization"] as const) {
  for (const methods of [["resume", "resume"], ["create", "resume"], ["create", "create"]] as const) {
    test(`simultaneous ${methods.join("/")} cannot spend the same ${quota} slot`, () => withServer(async (request, port) => {
      const create = (name: string) => request("/v1/rpc", "ci", { method: "create", args: [{
        envName: name, slug: name, branch: name, repo: "app", instanceType: "t3.micro", diskGb: 20,
      }] });
      const second = await create("second");
      expect(second.status).toBe(200);
      const secondRt = (await second.json() as any).result;
      for (const runtime of [rt, secondRt])
        expect((await request("/v1/rpc", "ci", { method: "suspend", args: [runtime] })).status).toBe(200);
      expect((await fetch(`http://localhost:${port}/v1/policies`, {
        method: "PUT", headers: { authorization: "Bearer boss-token" },
        body: JSON.stringify(quota === "owner" ? { max_envs_per_user: 1, max_running_total: 10 } : { max_envs_per_user: 10, max_running_total: 1 }),
      })).status).toBe(200);

      // The fake cloud delays both launches and starts before making them visible.
      const responses = await Promise.all(methods.map((method, index) => method === "create"
        ? create(`concurrent-${index}`)
        : request("/v1/rpc", "boss", { method, args: [index === 0 ? rt : secondRt] })));
      expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
      const blocked = responses.find((response) => response.status === 400)!;
      expect(await blocked.json()).toMatchObject({ error: { message: expect.stringContaining("limit 1") } });
      const fleet = (await (await request("/v1/rpc", "ci", { method: "listManaged" })).json() as any).result;
      expect(fleet.filter((runtime: any) => runtime.state === "running")).toHaveLength(1);
    }), 15000);
  }
}

test("a failed cloud launch releases capacity for the next request", () => withServer(async (request, port) => {
  expect((await request("/v1/rpc", "ci", { method: "suspend", args: [rt] })).status).toBe(200);
  expect((await fetch(`http://localhost:${port}/v1/policies`, {
    method: "PUT", headers: { authorization: "Bearer boss-token" },
    body: JSON.stringify({ max_envs_per_user: 1, max_running_total: 1 }),
  })).status).toBe(200);
  const create = (name: string) => request("/v1/rpc", "ci", { method: "create", args: [{
    envName: name, slug: name, branch: name, repo: "app", instanceType: "t3.micro", diskGb: 20,
  }] });
  expect((await create("cloud-failure")).status).toBe(500);
  expect((await create("after-failure")).status).toBe(200);
}), 15000);

test("image generation does not block create or resume after the bake VM is accounted for", () => withServer(async (request, port, dir) => {
  expect((await request("/v1/rpc", "ci", { method: "suspend", args: [rt] })).status).toBe(200);
  expect((await fetch(`http://localhost:${port}/v1/policies`, {
    method: "PUT", headers: { authorization: "Bearer boss-token" }, body: JSON.stringify({ max_running_total: 2 }),
  })).status).toBe(200);
  let finished = false;
  const baking = request("/v1/rpc", "boss", { method: "prepareBootImage" }).then((response) => { finished = true; return response; });
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(path.join(dir, "bake-image-pending")) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(path.join(dir, "bake-image-pending"))).toBe(true);
    const resumed = await request("/v1/rpc", "ci", { method: "resume", args: [rt] }, AbortSignal.timeout(2000));
    expect(resumed.status).toBe(200);
    expect((await request("/v1/rpc", "ci", { method: "create", args: [{
      envName: "while-baking", slug: "while-baking", branch: "while-baking", repo: "app", instanceType: "t3.micro", diskGb: 20,
    }] }, AbortSignal.timeout(2000))).status).toBe(200);
    expect(finished).toBe(false);
  } finally {
    writeFileSync(path.join(dir, "bake-image-release"), "1");
    expect((await baking).status).toBe(200);
  }
}), 15000);

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { GceError, GceProvider, gceCloudInit, instanceNameFor, machineTypeFor, mapState } from "./gce";

const done = { status: "DONE", selfLink: "https://compute.googleapis.com/op" };

function providerWith(api: (method: string, path: string, body?: any) => Promise<any>): GceProvider {
  const p = new GceProvider();
  (p as any).api = api;
  (p as any).pollMs = 1;
  (p as any).ensureLocalKey = () => false;
  (p as any).instanceBody = () => ({});
  return p;
}

const instance = (name: string, meta: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  name,
  status: "RUNNING",
  machineType: "zones/us-central1-a/machineTypes/e2-standard-4",
  networkInterfaces: [{ accessConfigs: [{ natIP: "34.1.2.3" }] }],
  metadata: { items: Object.entries(meta).map(([key, value]) => ({ key, value })) },
  ...extra,
});

test("EC2 sizes in a recipe become the E2 shape with the same vCPU and memory", () => {
  expect(machineTypeFor("t3.xlarge")).toBe("e2-standard-4");
  expect(machineTypeFor("t3a.large")).toBe("e2-standard-2");
  expect(machineTypeFor("m7i-flex.2xlarge")).toBe("e2-standard-8");
  expect(machineTypeFor("e2-standard-8")).toBe("e2-standard-8");
});

test("instance names fit Compute Engine's 63 characters and stay stable", () => {
  expect(instanceNameFor("runo-abc123-feat-x")).toBe("runo-abc123-feat-x");
  const long = `runo-abc123-${"very-long-branch-name-".repeat(5)}`;
  const name = instanceNameFor(long);
  expect(name.length).toBeLessThanOrEqual(63);
  expect(name).toMatch(/^[a-z]([-a-z0-9]*[a-z0-9])?$/);
  expect(instanceNameFor(long)).toBe(name);
  expect(instanceNameFor(`${long}2`)).not.toBe(name);
});

test("a stopped instance (TERMINATED) is stopped, not gone", () => {
  expect(mapState("TERMINATED")).toBe("stopped");
  expect(mapState("SUSPENDED")).toBe("stopped");
  expect(mapState("STAGING")).toBe("pending");
});

test("cloud-init creates the ubuntu user and drops the EC2-only agent", () => {
  const base = readFileSync(new URL("../../image/cloud-init.yaml", import.meta.url).pathname, "utf8");
  const out = gceCloudInit(base, "ssh-ed25519 AAAAkey runo-abc123\n");
  expect(out.startsWith("#cloud-config")).toBe(true);
  const doc = parse(out);
  expect(doc.packages).not.toContain("ec2-hibinit-agent");
  expect(doc.packages).toContain("docker.io");
  expect(doc.users[0].name).toBe("ubuntu");
  expect(doc.users[0].ssh_authorized_keys).toEqual(["ssh-ed25519 AAAAkey runo-abc123"]);
  expect(doc.runcmd.length).toBeGreaterThan(0);
});

test("create deletes the instance it launched when it never comes up", async () => {
  const deleted: string[] = [];
  const p = providerWith(async (method, path) => {
    if (method === "GET" && path.includes("/instances?")) return { items: [] };
    if (method === "GET" && path.startsWith("global/firewalls/")) return { allowed: [{ IPProtocol: "tcp", ports: ["22"] }] };
    if (method === "POST" && path.endsWith("/instances")) return done;
    if (method === "GET" && path.includes("/instances/")) throw new GceError(404, "gone");
    if (method === "DELETE") { deleted.push(path.split("/").pop()!); return done; }
    throw new Error(`unexpected ${method} ${path}`);
  });
  await expect(
    p.create({ envName: "runo-abc123-b", slug: "b", instanceType: "t3.medium", diskGb: 20, repo: "app", branch: "b" }),
  ).rejects.toThrow(/deleted unexpectedly/);
  expect(deleted).toEqual(["runo-abc123-b"]);
});

test("ensurePorts adds only the missing ports to the existing rule, once", async () => {
  const patches: any[] = [];
  let gets = 0;
  const p = providerWith(async (method, path, body) => {
    if (method === "GET" && path.startsWith("global/firewalls/")) { gets++; return { allowed: [{ IPProtocol: "tcp", ports: ["22", "80"] }] }; }
    if (method === "PATCH") { patches.push(body); return done; }
    throw new Error(`unexpected ${method} ${path}`);
  });
  await p.ensurePorts([80, 443]);
  await p.ensurePorts([443]);
  expect(patches).toEqual([{ allowed: [{ IPProtocol: "tcp", ports: ["22", "80", "443"] }] }]);
  expect(gets).toBe(1);
});

test("a branch's env is found by repo, branch and profile", async () => {
  const p = providerWith(async (method, path) => {
    if (method === "GET" && path.includes("/instances?"))
      return {
        items: [
          instance("runo-abc123-b", { "runo-repo": "app", "runo-branch": "feat/b" }),
          instance("runo-abc123-b-cloud", { "runo-repo": "app", "runo-branch": "feat/b", "runo-profile": "cloud" }),
          instance("runo-abc123-c", { "runo-repo": "app", "runo-branch": "feat/c" }),
        ],
      };
    throw new Error(`unexpected ${method} ${path}`);
  });
  expect((await p.findByTags("app", "feat/b"))?.id).toBe("runo-abc123-b");
  expect((await p.findByTags("app", "feat/b", "cloud"))?.id).toBe("runo-abc123-b-cloud");
  expect(await p.findByTags("app", "feat/x")).toBeNull();
  const all = await p.listByBranch("app", "feat/b");
  expect(all.map((r) => r.profile ?? "")).toEqual(expect.arrayContaining(["", "cloud"]));
  expect(all[0]?.ip).toBe("34.1.2.3");
  expect(all[0]?.instanceType).toBe("e2-standard-4");
});

test("resume uses `resume` for a suspended instance and `start` for a stopped one", async () => {
  const verbs: string[] = [];
  let status = "SUSPENDED";
  const p = providerWith(async (method, path) => {
    if (method === "GET") return instance("runo-abc123-b", {}, { status });
    if (method === "POST") { verbs.push(path.split("/").pop()!); status = "RUNNING"; return done; }
    throw new Error(`unexpected ${method} ${path}`);
  });
  await p.resume({ id: "runo-abc123-b", ip: null, state: "stopped" });
  status = "TERMINATED";
  await p.resume({ id: "runo-abc123-b", ip: null, state: "stopped" });
  expect(verbs).toEqual(["resume", "start"]);
});

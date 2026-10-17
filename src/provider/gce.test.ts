import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GceError, GceProvider, gceCloudInit, imageFamilyFor, instanceNameFor, machineTypeFor, mapState } from "./gce";
import { MAX_INSTANCES } from "../config";

const done = { status: "DONE", selfLink: "https://compute.googleapis.com/op" };

function providerWith(api: (method: string, path: string, body?: any) => Promise<any>, runningInstanceLimit?: () => number | undefined): GceProvider {
  const p = new GceProvider(runningInstanceLimit ? { runningInstanceLimit } : {});
  (p as any).api = api;
  (p as any).pollMs = 1;
  (p as any).ensureLocalKey = () => false;
  (p as any).instanceBody = () => ({});
  (p as any).repoImage = async () => null;
  return p;
}

function withKey(p: GceProvider): GceProvider {
  const dir = mkdtempSync(path.join(tmpdir(), "runo-gce-"));
  writeFileSync(path.join(dir, "k.pub"), "ssh-ed25519 AAAAkey runo\n");
  Object.defineProperty(p, "keyPath", { get: () => path.join(dir, "k") });
  return p;
}

const spec = { envName: "runo-abc123-b", slug: "b", instanceType: "e2-standard-4", diskGb: 40, repo: "app", branch: "feat/b" };

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

test("GCE resumes use hot-reloaded panel capacity and an empty policy is unlimited", async () => {
  let limit: number | undefined = 10;
  let status = "TERMINATED";
  let starts = 0;
  const p = providerWith(async (method, route) => {
    if (method === "GET" && route.includes("/instances?"))
      return { items: Array.from({ length: 10 }, (_, i) => instance(`active-${i}`, {}, { status: i ? "RUNNING" : "STAGING" })) };
    if (method === "GET") return instance("stopped", {}, { status });
    if (method === "POST") { starts++; status = "RUNNING"; return done; }
    throw new Error(`unexpected ${method} ${route}`);
  }, () => limit);
  const rt = { id: "stopped", ip: null, state: "stopped" } as const;
  await expect(p.resume(rt)).rejects.toThrow("max 10");
  expect(starts).toBe(0);
  limit = 11;
  expect(await p.resume(rt)).toMatchObject({ state: "running" });
  expect(await p.resume(rt)).toMatchObject({ state: "running" });
  expect(starts).toBe(1);
  status = "TERMINATED";
  limit = undefined;
  expect(await p.resume(rt)).toMatchObject({ state: "running" });
  expect(starts).toBe(2);
});

test("direct GCE retains its local capacity guardrail", async () => {
  const p = providerWith(async (method, route) => {
    if (method === "GET" && route.includes("/instances?"))
      return { items: Array.from({ length: MAX_INSTANCES }, (_, i) => instance(`active-${i}`, {})) };
    if (method === "GET") return instance("stopped", {}, { status: "TERMINATED" });
    throw new Error(`unexpected ${method} ${route}`);
  });
  await expect(p.resume({ id: "stopped", ip: null, state: "stopped" })).rejects.toThrow(`max ${MAX_INSTANCES}`);
});

test("an env of a repo with a base image boots from it, without cloud-init, on a disk at least as large", () => {
  const p = withKey(new GceProvider());
  const body: any = (p as any).instanceBody(spec, "n", "e2-standard-4", false, { name: "img", image: "global/images/img", diskGb: 80 });
  const disk = body.disks[0].initializeParams;
  expect(disk.sourceImage).toBe("global/images/img");
  expect(disk.diskSizeGb).toBe("80");
  const keys = body.metadata.items.map((i: any) => i.key);
  expect(keys).not.toContain("user-data");
  expect(keys).toContain("ssh-keys");
  const cold: any = (p as any).instanceBody(spec, "n", "e2-standard-4", false, null);
  expect(cold.metadata.items.map((i: any) => i.key)).toContain("user-data");
  expect(cold.disks[0].initializeParams.diskSizeGb).toBe("40");
  expect(cold.serviceAccounts).toEqual([]);
});

test("bake from an env stops it, images its boot disk into the repo's family and keeps two images", async () => {
  const calls: string[] = [];
  let status = "RUNNING";
  let inserted: any;
  const images = ["c", "b", "a"].map((n, i) => ({ name: `img-${n}`, status: "READY", creationTimestamp: `2026-10-1${5 - i}` }));
  const p = providerWith(async (method, path, body) => {
    calls.push(`${method} ${path.split("?")[0]}`);
    if (method === "GET" && path.startsWith("zones/"))
      return instance("runo-abc123-main", {}, {
        status,
        disks: [{ boot: true, source: "https://www.googleapis.com/compute/v1/projects/proj/zones/us-central1-a/disks/runo-abc123-main" }],
      });
    if (method === "POST" && path.endsWith("/stop")) { status = "TERMINATED"; return done; }
    if (method === "POST" && path === "global/images") { inserted = body; return done; }
    if (method === "GET" && path.startsWith("global/images")) return { items: images };
    if (method === "DELETE") return done;
    throw new Error(`unexpected ${method} ${path}`);
  });
  (p as any).project = "proj";
  const name = await p.imageFromRuntime({ id: "runo-abc123-main", ip: null, state: "running" }, "app");
  expect(inserted.sourceDisk).toBe("zones/us-central1-a/disks/runo-abc123-main");
  expect(inserted.family).toBe(imageFamilyFor("app"));
  expect(inserted.labels.runo_base_image).toBe("app");
  expect(name.startsWith(imageFamilyFor("app"))).toBe(true);
  expect(calls).toContain("POST zones/us-central1-a/instances/runo-abc123-main/stop");
  expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE global/images/img-a"]);
});

test("image families are valid Compute Engine names", () => {
  for (const repo of ["app", "Brendi_App", "kodus-ai", "a".repeat(80)]) {
    const f = imageFamilyFor(repo);
    expect(f).toMatch(/^[a-z]([-a-z0-9]*[a-z0-9])?$/);
    expect(f.length).toBeLessThanOrEqual(50);
  }
});

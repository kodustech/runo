import { expect, test } from "bun:test";
import { defaultPricing, parsePricing } from "./pricing";
import { parsePolicies } from "./policies";
import { Store } from "./store";
import { breakdown, machineUsage, sampleFleet, usageBetween } from "./usage";

const HOUR = 3_600_000;
const pricing = { instance_hourly: { "t3.xlarge": 0.2 }, spot_factor: 0.5, ebs_gb_month: 0.1, ebs_extra_month: 0, ipv4_hourly: 0 };
const machine = (id: string, over: object = {}) => ({
  instanceId: id, envName: `env-${id}`, slug: id, owner: "alice", repo: "app", branch: "main",
  instanceType: "t3.xlarge", spot: false, diskGb: 73, createdAt: 0, ...over,
});

test("cost counts running hours inside the window, and storage for as long as the machine exists", () => {
  const store = new Store(":memory:");
  store.addMachine(machine("i-1"));
  store.openRun("i-1", 0);
  store.closeRun("i-1", 10 * HOUR);
  store.endMachine("i-1", "alice", "destroy", 730 * HOUR);
  const [all] = usageBetween(store, pricing, 0, 1000 * HOUR, 1000 * HOUR);
  expect(all.runningHours).toBe(10);
  expect(all.computeCost).toBeCloseTo(2);
  expect(all.storageCost).toBeCloseTo(7.3); // one month of 73GB, stopped or not
  // a window that starts mid-run only pays for its share
  const [late] = usageBetween(store, pricing, 8 * HOUR, 1000 * HOUR, 1000 * HOUR);
  expect(late.runningHours).toBe(2);
});

test("spot factor applies, unknown types are flagged instead of silently free", () => {
  const spot = machineUsage({ ...machine("i-2", { spot: true }), endedAt: null, endedBy: null, endReason: null },
    [{ instanceId: "i-2", startedAt: 0, endedAt: 10 * HOUR }], pricing, 0, 10 * HOUR, 10 * HOUR);
  expect(spot.computeCost).toBeCloseTo(1);
  const odd = machineUsage({ ...machine("i-3", { instanceType: "x9.mega", diskGb: null }), endedAt: null, endedBy: null, endReason: null },
    [{ instanceId: "i-3", startedAt: 0, endedAt: null }], pricing, 0, 10 * HOUR, 10 * HOUR);
  expect(odd.priced).toBe(false);
  expect(odd.running).toBe(true);
  expect(breakdown([spot, odd], (m) => m.owner)[0]).toMatchObject({ key: "alice", machines: 2, runningHours: 20 });
});

test("sampler: backfills registered envs, tracks stops nobody requested, never trusts a partial listing", async () => {
  const store = new Store(":memory:");
  const env = { envName: "env-a", owner: "ci", instanceId: "i-a", instanceType: "t3.xlarge", createdAt: new Date(0).toISOString() };
  const running = [{ id: "i-a", ip: null, state: "running" as const }];

  await sampleFleet(store, running, [env], async () => false, 1 * HOUR);
  expect(store.machine("i-a")?.owner).toBe("ci");
  expect(store.runsBetween(0, 2 * HOUR)).toHaveLength(1);
  expect(store.latestSample()).toMatchObject({ running: 1, stopped: 0 });

  // idle watchdog stopped it: run closes, history says nobody asked
  await sampleFleet(store, [{ id: "i-a", ip: null, state: "stopped" }], [env], async () => false, 3 * HOUR);
  expect(store.runsBetween(0, 9 * HOUR)[0].endedAt).toBe(3 * HOUR);
  expect(store.lastEvent("i-a")).toMatchObject({ actor: "system", action: "auto-stopped" });

  // missing from the listing but the cloud still knows it: nothing ends
  await sampleFleet(store, [], [env], async () => false, 4 * HOUR);
  expect(store.machine("i-a")?.endedAt).toBeNull();
  // confirmed gone
  await sampleFleet(store, [], [env], async () => true, 5 * HOUR);
  expect(store.machine("i-a")).toMatchObject({ endedAt: 5 * HOUR, endReason: "vanished" });
  // still in the registry, but history does not resurrect it
  await sampleFleet(store, [], [env], async () => true, 6 * HOUR);
  expect(store.openMachines()).toHaveLength(0);
  expect(store.peak(0, 9 * HOUR)).toMatchObject({ running: 1, ts: 1 * HOUR });
});

test("a resume requested through the server is not reported as automatic", async () => {
  const store = new Store(":memory:");
  store.addMachine(machine("i-b"));
  store.addEvent({ actor: "alice", action: "resume", instanceId: "i-b", ts: 10 * HOUR });
  await sampleFleet(store, [{ id: "i-b", ip: null, state: "running" }], [], async () => false, 10 * HOUR + 60_000);
  expect(store.lastEvent("i-b")?.action).toBe("resume");
});

test("panel input is validated before it reaches policies.yaml or the price table", () => {
  expect(parsePolicies({ max_disk_gb: 100, env_ttl_days: 0.5, max_envs_per_user: null })).toEqual({ max_disk_gb: 100, env_ttl_days: 0.5 });
  expect(parsePolicies({ allowed_instance_types: ["t3.large", "t3.large"] })).toEqual({ allowed_instance_types: ["t3.large"] });
  for (const bad of [{ max_disk_gb: -1 }, { max_running_total: 1.5 }, { allowed_instance_types: ["rm -rf"] }, { surprise: 1 }, []])
    expect(() => parsePolicies(bad)).toThrow();
  expect(parsePricing(defaultPricing("us-east-2")).instance_hourly["t3.xlarge"]).toBe(0.1664);
  expect(() => parsePricing({ ...defaultPricing("us-east-2"), spot_factor: 2 })).toThrow();
  expect(() => parsePricing({ ...defaultPricing("us-east-2"), instance_hourly: { "t3.large": "free" } })).toThrow();
});

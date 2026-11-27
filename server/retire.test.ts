import { expect, test } from "bun:test";
import type { Runtime } from "../src/provider/types";
import { parsePolicies } from "./policies";
import { stoppedSince, sweepStopped, type RetireProvider } from "./retire";
import { Store } from "./store";

const DAY = 86_400_000;
const NOW = 30 * DAY;

const env = (id: string) => ({ envName: `env-${id}`, owner: "alice", instanceId: id, createdAt: new Date(0).toISOString() });

/** A store where `id` ran from day 0 until `stoppedAt` (null = still running). */
function storeWith(runs: Record<string, number | null>): Store {
  const store = new Store(":memory:");
  for (const [id, stoppedAt] of Object.entries(runs)) {
    store.addMachine({ instanceId: id, envName: `env-${id}`, slug: id, owner: "alice", repo: "app", branch: "b", instanceType: "t3.xlarge", spot: false, diskGb: 100, createdAt: 0 });
    store.openRun(id, 0);
    if (stoppedAt !== null) store.closeRun(id, stoppedAt);
  }
  return store;
}

function fakeProvider(live: Runtime[], over: Partial<RetireProvider> = {}) {
  const calls = { snapshot: [] as string[], destroy: [] as string[], cleared: [] as string[] };
  const provider: RetireProvider = {
    listManaged: async () => live,
    status: async (rt) => live.find((l) => l.id === rt.id) ?? { ...rt, state: "terminated" },
    destroy: async (rt) => { calls.destroy.push(rt.id); },
    snapshotForRetire: async (rt) => { calls.snapshot.push(rt.id); return [`snap-${rt.id}`]; },
    retireSnapshotsState: async () => "completed",
    clearRetireMark: async (rt) => { calls.cleared.push(rt.id); },
    ...over,
  };
  return { provider, calls };
}

const quiet = { warn() {}, dim() {} };

async function sweep(o: { store: Store; live: Runtime[]; envs: ReturnType<typeof env>[]; dryRun?: boolean; afterDays?: number; over?: Partial<RetireProvider> }) {
  const { provider, calls } = fakeProvider(o.live, o.over);
  const dropped: string[] = [];
  const outcomes = await sweepStopped({
    afterDays: o.afterDays ?? 7, dryRun: Boolean(o.dryRun), provider, store: o.store, envs: o.envs,
    dropEnv: (name) => dropped.push(name), log: quiet, now: NOW,
  });
  return { outcomes, calls, dropped };
}

test("an env stopped for less than the policy, or running, is left alone", async () => {
  const store = storeWith({ "i-recent": NOW - 2 * DAY, "i-up": null });
  const { outcomes, calls } = await sweep({
    store,
    live: [{ id: "i-recent", ip: null, state: "stopped" }, { id: "i-up", ip: "192.0.2.1", state: "running" }],
    envs: [env("i-recent"), env("i-up")],
  });
  expect(outcomes).toEqual([]);
  expect(calls.snapshot).toEqual([]);
});

test("a policy of 1.5 days retires an env stopped 37 hours and leaves one stopped 35 hours", async () => {
  const HOUR = DAY / 24;
  const store = storeWith({ "i-35h": NOW - 35 * HOUR, "i-37h": NOW - 37 * HOUR });
  const { calls } = await sweep({
    store, afterDays: 1.5,
    live: [{ id: "i-35h", ip: null, state: "stopped" }, { id: "i-37h", ip: null, state: "stopped" }],
    envs: [env("i-35h"), env("i-37h")],
  });
  expect(calls.snapshot).toEqual(["i-37h"]);
});

test("an env stopped past the policy is snapshotted first, and the history says so", async () => {
  const store = storeWith({ "i-old": NOW - 10 * DAY });
  const { outcomes, calls, dropped } = await sweep({ store, live: [{ id: "i-old", ip: null, state: "stopped" }], envs: [env("i-old")] });
  expect(outcomes).toEqual([{ envName: "env-i-old", instanceId: "i-old", action: "snapshot", detail: "snap-i-old" }]);
  expect(calls.snapshot).toEqual(["i-old"]);
  expect(calls.destroy).toEqual([]); // terminating waits for the snapshot to complete
  expect(dropped).toEqual([]);
  expect(store.lastEvent("i-old")).toMatchObject({ actor: "system", action: "retire-snapshot" });
});

test("a dry run only reports", async () => {
  const store = storeWith({ "i-old": NOW - 10 * DAY, "i-marked": NOW - 10 * DAY });
  const { outcomes, calls } = await sweep({
    store, dryRun: true,
    live: [
      { id: "i-old", ip: null, state: "stopped" },
      { id: "i-marked", ip: null, state: "stopped", retireSnapshots: ["snap-1"], retireAt: new Date(NOW - DAY).toISOString() },
    ],
    envs: [env("i-old"), env("i-marked")],
  });
  expect(outcomes.map((o) => o.action)).toEqual(["would-snapshot", "would-retire"]);
  expect(calls).toEqual({ snapshot: [], destroy: [], cleared: [] });
});

test("a marked env waits for its snapshots, then is terminated and leaves the registry", async () => {
  const store = storeWith({ "i-old": NOW - 10 * DAY });
  const live: Runtime[] = [{ id: "i-old", ip: null, state: "stopped", retireSnapshots: ["snap-1"], retireAt: new Date(NOW - DAY).toISOString() }];
  const pending = await sweep({ store, live, envs: [env("i-old")], over: { retireSnapshotsState: async () => "pending" } });
  expect(pending.outcomes.map((o) => o.action)).toEqual(["waiting"]);
  expect(pending.calls.destroy).toEqual([]);

  const done = await sweep({ store, live, envs: [env("i-old")] });
  expect(done.outcomes.map((o) => o.action)).toEqual(["retired"]);
  expect(done.calls.destroy).toEqual(["i-old"]);
  expect(done.dropped).toEqual(["env-i-old"]);
  expect(store.machine("i-old")).toMatchObject({ endedBy: "system", endReason: "retired" });
  expect(store.lastEvent("i-old")).toMatchObject({ action: "retire" });
});

test("an env resumed after it was listed is never terminated", async () => {
  const store = storeWith({ "i-old": NOW - 10 * DAY });
  const live: Runtime[] = [{ id: "i-old", ip: null, state: "stopped", retireSnapshots: ["snap-1"], retireAt: new Date(NOW - DAY).toISOString() }];
  const { calls } = await sweep({
    store, live, envs: [env("i-old")],
    over: { status: async (rt) => ({ ...rt, state: "running" }) },
  });
  expect(calls.destroy).toEqual([]);
});

test("a mark taken before the env was last used is dropped, and its clock starts over", async () => {
  // marked on day 15, used again until day 25
  const store = storeWith({ "i-used": NOW - 5 * DAY });
  const { outcomes, calls } = await sweep({
    store,
    live: [{ id: "i-used", ip: null, state: "stopped", retireSnapshots: ["snap-stale"], retireAt: new Date(15 * DAY).toISOString() }],
    envs: [env("i-used")],
  });
  expect(outcomes.map((o) => o.action)).toEqual(["mark-cleared"]);
  expect(calls.cleared).toEqual(["i-used"]);
  expect(calls.destroy).toEqual([]);
});

test("failed snapshots drop the mark so the next sweep takes new ones; one env failing does not stop the others", async () => {
  const store = storeWith({ "i-bad": NOW - 10 * DAY, "i-boom": NOW - 10 * DAY, "i-ok": NOW - 10 * DAY });
  const { outcomes, calls } = await sweep({
    store,
    live: [
      { id: "i-bad", ip: null, state: "stopped", retireSnapshots: ["snap-err"], retireAt: new Date(NOW - DAY).toISOString() },
      { id: "i-boom", ip: null, state: "stopped" },
      { id: "i-ok", ip: null, state: "stopped" },
    ],
    envs: [env("i-bad"), env("i-boom"), env("i-ok")],
    over: {
      retireSnapshotsState: async () => "failed",
      snapshotForRetire: async (rt) => { if (rt.id === "i-boom") throw new Error("throttled"); return [`snap-${rt.id}`]; },
    },
  });
  expect(outcomes.map((o) => [o.instanceId, o.action])).toEqual([["i-bad", "snapshot-failed"], ["i-boom", "error"], ["i-ok", "snapshot"]]);
  expect(calls.cleared).toEqual(["i-bad"]);
});

test("stopped since: the end of the last run, or the creation of an env never seen running", () => {
  const store = storeWith({ "i-1": 5 * DAY, "i-2": null });
  expect(stoppedSince(store, env("i-1"))).toBe(5 * DAY);
  expect(stoppedSince(store, env("i-2"))).toBeNull();
  expect(stoppedSince(store, { ...env("i-never"), createdAt: new Date(3 * DAY).toISOString() })).toBe(3 * DAY);
});

test("retire policies are validated", () => {
  expect(parsePolicies({ retire_stopped_after_days: 7, retire_dry_run: true })).toEqual({ retire_stopped_after_days: 7, retire_dry_run: true });
  expect(parsePolicies({ retire_stopped_after_days: 0.5, retire_dry_run: false })).toEqual({ retire_stopped_after_days: 0.5 });
  expect(() => parsePolicies({ retire_stopped_after_days: 0 })).toThrow("positive number");
  expect(() => parsePolicies({ retire_dry_run: "yes" })).toThrow("true or false");
});

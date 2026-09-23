/**
 * Usage accounting: turns what the sampler observed (runs, machine lifetimes,
 * fleet-size samples) into hours, estimated cost and peaks.
 *
 * The sampler is the only writer of runs. Machines stop without asking the
 * server (idle watchdog, spot interruption, someone in the AWS console), so
 * state is observed once a minute instead of inferred from RPCs.
 */
import type { Runtime } from "../src/provider/types";
import type { Pricing } from "./pricing";
import type { Machine, Run, Store } from "./store";

const HOUR = 3_600_000;
const HOURS_PER_MONTH = 730;

export function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

export interface MachineUsage extends Machine {
  runningHours: number;
  aliveHours: number;
  computeCost: number;
  storageCost: number;
  cost: number;
  /** false when the instance type has no price — compute is then missing from `cost`. */
  priced: boolean;
  running: boolean;
}

export function machineUsage(
  m: Machine, runs: Run[], pricing: Pricing, from: number, to: number, now = Date.now(),
): MachineUsage {
  let runningMs = 0;
  let running = false;
  for (const r of runs) {
    if (r.instanceId !== m.instanceId) continue;
    runningMs += overlapMs(r.startedAt, r.endedAt ?? now, from, to);
    if (r.endedAt === null) running = true;
  }
  const aliveMs = overlapMs(m.createdAt, m.endedAt ?? now, from, to);
  const rate = m.instanceType ? pricing.instance_hourly[m.instanceType] : undefined;
  const hourly = (rate ?? 0) * (m.spot ? pricing.spot_factor : 1) + pricing.ipv4_hourly;
  const computeCost = (runningMs / HOUR) * hourly;
  const storageCost = m.diskGb
    ? (aliveMs / HOUR / HOURS_PER_MONTH) * (m.diskGb * pricing.ebs_gb_month + pricing.ebs_extra_month)
    : 0;
  return {
    ...m,
    runningHours: runningMs / HOUR,
    aliveHours: aliveMs / HOUR,
    computeCost,
    storageCost,
    cost: computeCost + storageCost,
    priced: rate !== undefined,
    running,
  };
}

export function usageBetween(store: Store, pricing: Pricing, from: number, to: number, now = Date.now()): MachineUsage[] {
  const runs = store.runsBetween(from, to);
  return store.machinesBetween(from, to).map((m) => machineUsage(m, runs, pricing, from, to, now));
}

export interface Breakdown {
  key: string;
  machines: number;
  runningHours: number;
  cost: number;
}

export function breakdown(usage: MachineUsage[], by: (m: MachineUsage) => string | null): Breakdown[] {
  const out = new Map<string, Breakdown>();
  for (const m of usage) {
    const key = by(m) ?? "(unknown)";
    const row = out.get(key) ?? { key, machines: 0, runningHours: 0, cost: 0 };
    row.machines++;
    row.runningHours += m.runningHours;
    row.cost += m.cost;
    out.set(key, row);
  }
  return [...out.values()].sort((a, b) => b.cost - a.cost);
}

/** Estimated cost per UTC day across [from, to]. */
export function dailyCost(store: Store, pricing: Pricing, from: number, to: number, now = Date.now()): { ts: number; cost: number }[] {
  const DAY = 24 * HOUR;
  const machines = store.machinesBetween(from, to);
  const runs = store.runsBetween(from, to);
  const days: { ts: number; cost: number }[] = [];
  for (let day = Math.floor(from / DAY) * DAY; day < to; day += DAY) {
    const end = Math.min(day + DAY, now);
    let cost = 0;
    if (end > day) for (const m of machines) cost += machineUsage(m, runs, pricing, day, end, now).cost;
    days.push({ ts: day, cost });
  }
  return days;
}

/** Month-to-date estimate and a straight-line projection to the end of the month (UTC). */
export function monthEstimate(store: Store, pricing: Pricing, now = Date.now()): { monthToDate: number; forecast: number } {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const monthToDate = usageBetween(store, pricing, start, now, now).reduce((sum, m) => sum + m.cost, 0);
  const elapsed = Math.max(now - start, HOUR);
  return { monthToDate, forecast: (monthToDate / elapsed) * (end - start) };
}

// ---------- sampler ----------

export interface RegisteredEnv {
  envName: string;
  slug?: string;
  owner: string;
  repo?: string;
  branch?: string;
  instanceId: string;
  instanceType?: string;
  spot?: boolean;
  createdAt?: string;
}

export const isUp = (state: string) => state === "running" || state === "pending";

/**
 * Registered envs whose instance no longer exists: missing from `managed` and
 * confirmed gone by the provider (a partial listing must not drop records).
 * Spot interruptions and console terminations never go through `destroy`, so
 * without this their records would count against the owner forever.
 */
export async function vanishedEnvs(
  managed: Runtime[],
  registered: RegisteredEnv[],
  confirmGone: (instanceId: string) => Promise<boolean>,
): Promise<RegisteredEnv[]> {
  const live = new Set(managed.map((rt) => rt.id));
  const gone: RegisteredEnv[] = [];
  for (const e of registered)
    if (!live.has(e.instanceId) && (await confirmGone(e.instanceId))) gone.push(e);
  return gone;
}

/**
 * One observation of the fleet. `managed` is what the cloud says is alive;
 * `confirmGone` double-checks a machine missing from it before history calls
 * it terminated (a partial listing must not close machines).
 */
export async function sampleFleet(
  store: Store,
  managed: Runtime[],
  registered: RegisteredEnv[],
  confirmGone: (instanceId: string) => Promise<boolean>,
  now = Date.now(),
): Promise<void> {
  // envs that predate the history database (or came from import-envs.ts)
  for (const e of registered)
    if (!store.machine(e.instanceId))
      store.addMachine({
        instanceId: e.instanceId, envName: e.envName, slug: e.slug ?? null, owner: e.owner,
        repo: e.repo ?? null, branch: e.branch ?? null, instanceType: e.instanceType ?? null,
        spot: Boolean(e.spot), diskGb: null, createdAt: e.createdAt ? Date.parse(e.createdAt) || now : now,
      });

  const live = new Map(managed.map((rt) => [rt.id, rt]));
  for (const m of store.openMachines()) {
    const rt = live.get(m.instanceId);
    if (!rt) {
      if (!(await confirmGone(m.instanceId))) continue;
      store.endMachine(m.instanceId, "system", "vanished", now);
      store.addEvent({ actor: "system", action: "vanished", envName: m.envName, instanceId: m.instanceId, ts: now });
      continue;
    }
    const changed = isUp(rt.state) ? store.openRun(m.instanceId, now) : store.closeRun(m.instanceId, now);
    if (!changed) continue;
    // transitions nobody asked the server for: idle watchdog, spot interruption, AWS console
    const last = store.lastEvent(m.instanceId);
    const requested = last && now - last.ts < 5 * 60_000 && ["create", "resume", "suspend"].includes(last.action);
    if (!requested)
      store.addEvent({
        actor: "system", action: isUp(rt.state) ? "auto-started" : "auto-stopped",
        envName: m.envName, instanceId: m.instanceId, ts: now,
      });
  }

  store.addSample({
    ts: now,
    running: managed.filter((rt) => isUp(rt.state)).length,
    stopped: managed.filter((rt) => !isUp(rt.state)).length,
    total: managed.length,
  });
}

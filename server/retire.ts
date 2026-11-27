/**
 * Retires environments nobody came back to. A stopped env costs no compute,
 * but its disk is billed every month, and most stopped envs are branches that
 * were merged or abandoned. After `retire_stopped_after_days` stopped, the
 * sweeper snapshots the env's disks and, once the snapshots complete,
 * terminates the instance and drops it from the registry.
 *
 * It takes two sweeps and never waits: the instance carries the snapshot ids
 * (RETIRE_SNAPSHOTS_TAG) from one sweep to the next, so a server restart in
 * between picks up where it was. An env used after its snapshot (resumed,
 * then stopped again) loses the mark, and its clock starts over.
 *
 * Restore is by hand: the snapshots keep the env's tags plus `cleanup` and
 * `runo:retired-from`, and an admin can register an image or create a volume
 * from them. Most envs need none: `runo up` rebuilds a branch's env from the
 * repo.
 */
import type { Runtime } from "../src/provider/types";
import type { Store } from "./store";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface RetireEnv {
  envName: string;
  owner: string;
  instanceId: string;
  createdAt: string;
}

export interface RetireProvider {
  listManaged(): Promise<Runtime[]>;
  status(rt: Runtime): Promise<Runtime>;
  destroy(rt: Runtime): Promise<void>;
  snapshotForRetire(rt: Runtime, tags: { Key: string; Value: string }[]): Promise<string[]>;
  retireSnapshotsState(ids: string[]): Promise<"completed" | "pending" | "failed">;
  clearRetireMark(rt: Runtime): Promise<void>;
}

export type RetireAction =
  | "would-snapshot"
  | "snapshot"
  | "waiting"
  | "would-retire"
  | "retired"
  | "snapshot-failed"
  | "mark-cleared"
  | "error";

export interface RetireOutcome {
  envName: string;
  instanceId: string;
  action: RetireAction;
  detail?: string;
}

interface Log {
  warn(msg: string): void;
  dim(msg: string): void;
}

/**
 * When the env stopped: the end of its last observed run, or its creation when
 * the sampler never saw it running. null while a run is open.
 */
export function stoppedSince(store: Store, env: RetireEnv): number | null {
  const run = store.lastRun(env.instanceId);
  if (run) return run.endedAt;
  const created = store.machine(env.instanceId)?.createdAt ?? Date.parse(env.createdAt);
  return Number.isFinite(created) ? created : null;
}

export async function sweepStopped(o: {
  afterDays: number;
  dryRun: boolean;
  provider: RetireProvider;
  store: Store;
  envs: RetireEnv[];
  /** Drops the env from the registry, unless it was re-created meanwhile. */
  dropEnv(envName: string, instanceId: string): void;
  log: Log;
  now?: number;
}): Promise<RetireOutcome[]> {
  const now = o.now ?? Date.now();
  const cutoff = now - o.afterDays * DAY;
  const live = new Map((await o.provider.listManaged()).map((rt) => [rt.id, rt]));
  const out: RetireOutcome[] = [];
  const note = (env: RetireEnv, action: RetireAction, detail?: string) =>
    out.push({ envName: env.envName, instanceId: env.instanceId, action, ...(detail ? { detail } : {}) });

  for (const env of o.envs) {
    const rt = live.get(env.instanceId);
    if (!rt) continue; // the sampler drops vanished envs
    try {
      const since = stoppedSince(o.store, env);
      let marked = Boolean(rt.retireSnapshots?.length);
      // a mark from before the env was last used describes a disk that changed since
      if (marked) {
        const markedAt = Date.parse(rt.retireAt ?? "");
        const usedAfter = rt.state !== "stopped" || since === null || !(markedAt >= since);
        if (usedAfter) {
          if (!o.dryRun) await o.provider.clearRetireMark(rt);
          note(env, "mark-cleared");
          marked = false;
        }
      }
      if (rt.state !== "stopped" || since === null || since > cutoff) continue;
      const stoppedHours = Math.floor((now - since) / HOUR);

      if (!marked) {
        if (o.dryRun) {
          o.log.dim(`retire (dry run): would snapshot ${env.envName} (owner ${env.owner}, stopped ${stoppedHours}h)`);
          note(env, "would-snapshot");
          continue;
        }
        const day = new Date(now).toISOString().slice(0, 10);
        const ids = await o.provider.snapshotForRetire(rt, [
          { Key: "cleanup", Value: `runo-retired-${day}` },
          { Key: "runo:retired-from", Value: env.instanceId },
          { Key: "runo:owner", Value: env.owner },
        ]);
        o.log.warn(`retire: ${env.envName} stopped ${stoppedHours}h; snapshotting ${ids.join(", ")} before terminating`);
        o.store.addEvent({
          actor: "system", action: "retire-snapshot", envName: env.envName, instanceId: env.instanceId,
          detail: { owner: env.owner, snapshots: ids, stoppedHours }, ts: now,
        });
        note(env, "snapshot", ids.join(","));
        continue;
      }

      const ids = rt.retireSnapshots!;
      const state = await o.provider.retireSnapshotsState(ids);
      if (state === "pending") {
        note(env, "waiting", ids.join(","));
        continue;
      }
      if (state === "failed") {
        o.log.warn(`retire: snapshots of ${env.envName} failed (${ids.join(", ")}); trying again next sweep`);
        if (!o.dryRun) await o.provider.clearRetireMark(rt);
        note(env, "snapshot-failed", ids.join(","));
        continue;
      }
      if (o.dryRun) {
        o.log.dim(`retire (dry run): would terminate ${env.envName}; snapshots ${ids.join(", ")} are complete`);
        note(env, "would-retire", ids.join(","));
        continue;
      }
      // someone may have resumed it since the listing; never terminate a running env
      const fresh = await o.provider.status(rt);
      if (fresh.state !== "stopped") continue;
      await o.provider.destroy(rt);
      o.dropEnv(env.envName, env.instanceId);
      o.store.endMachine(env.instanceId, "system", "retired", now);
      o.store.addEvent({
        actor: "system", action: "retire", envName: env.envName, instanceId: env.instanceId,
        detail: { owner: env.owner, snapshots: ids, stoppedHours }, ts: now,
      });
      o.log.warn(`retire: terminated ${env.envName} (owner ${env.owner}, stopped ${stoppedHours}h); disk kept in ${ids.join(", ")}`);
      note(env, "retired", ids.join(","));
    } catch (e: any) {
      o.log.warn(`retire failed for ${env.envName}: ${e?.message ?? e}`);
      note(env, "error", String(e?.message ?? e));
    }
  }
  return out;
}

/**
 * Org policies — the platform team's ceilings, enforced by runo-server at
 * env creation time (plus a TTL sweeper). The recipe in each repo decides the
 * machine for that workload; policies bound what any recipe/user may ask for.
 *
 * File: $RUNO_HOME/policies.yaml (re-read on every request — edits apply
 * immediately, no restart). Every field is optional; absent = unlimited.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { RUNO_HOME } from "../src/config";
import { RunoError } from "../src/errors";
import type { CreateSpec } from "../src/provider/types";

export interface Policies {
  /** Exact-match allowlist of EC2 instance types recipes may request. */
  allowed_instance_types?: string[];
  /** Maximum root disk size a recipe may request. */
  max_disk_gb?: number;
  /** Maximum environments a single user may own at once. */
  max_envs_per_user?: number;
  /** Org-wide ceiling of RUNNING/pending instances. */
  max_running_total?: number;
  /** Auto-destroy environments older than this many days (fractions allowed). */
  env_ttl_days?: number;
}

const POLICIES_PATH = () => path.join(RUNO_HOME, "policies.yaml");

export function loadPolicies(): Policies {
  const p = POLICIES_PATH();
  if (!existsSync(p)) return {};
  try {
    return (parse(readFileSync(p, "utf8")) ?? {}) as Policies;
  } catch (e: any) {
    throw new RunoError(`policies.yaml does not parse: ${e?.message ?? e}`, `Fix ${p}`);
  }
}

export function enforceCreate(
  pol: Policies,
  spec: CreateSpec,
  ctx: { user: string; userEnvCount: number; runningTotal: number },
): void {
  if (pol.allowed_instance_types && !pol.allowed_instance_types.includes(spec.instanceType))
    throw new RunoError(
      `Policy: instance type "${spec.instanceType}" is not allowed by your organization`,
      `Allowed types: ${pol.allowed_instance_types.join(", ")}. Change limits.instance in the repo's recipe (by PR) or talk to the platform team.`,
    );
  if (pol.max_disk_gb !== undefined && spec.diskGb > pol.max_disk_gb)
    throw new RunoError(
      `Policy: disk ${spec.diskGb}GB exceeds the organization limit (${pol.max_disk_gb}GB)`,
      "Lower limits.disk in the repo's recipe or talk to the platform team.",
    );
  if (pol.max_envs_per_user !== undefined && ctx.userEnvCount >= pol.max_envs_per_user)
    throw new RunoError(
      `Policy: you already own ${ctx.userEnvCount} environment(s) (limit ${pol.max_envs_per_user})`,
      "Destroy one you no longer need (`runo ls`, `runo destroy`) and try again.",
    );
  if (pol.max_running_total !== undefined && ctx.runningTotal >= pol.max_running_total)
    throw new RunoError(
      `Policy: the organization already has ${ctx.runningTotal} instances running (limit ${pol.max_running_total})`,
      "Suspend or destroy environments, or talk to the platform team.",
    );
}

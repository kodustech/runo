/**
 * Org policies — the platform team's ceilings, enforced by runo-server at
 * env creation time (plus a TTL sweeper). The recipe in each repo decides the
 * machine for that workload; policies bound what any recipe/user may ask for.
 *
 * File: $RUNO_HOME/policies.yaml (re-read on every request — edits apply
 * immediately, no restart). Every field is optional; absent = unlimited.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { RUNO_HOME } from "../src/config";
import { RunoError } from "../src/errors";
import type { CreateSpec } from "../src/provider/types";

export interface Policies {
  /** Exact-match allowlist of EC2 instance types recipes may request. */
  allowed_instance_types?: string[];
  /** Maximum root disk size a recipe may request. */
  max_disk_gb?: number;
  /** Maximum RUNNING/pending environments a single user may have at once. */
  max_envs_per_user?: number;
  /** Org-wide ceiling of RUNNING/pending instances. */
  max_running_total?: number;
  /** Auto-destroy environments older than this many days (fractions allowed). */
  env_ttl_days?: number;
  /**
   * Ports any user may open to the world on the shared security group. Absent =
   * 80 and 443, what `expose.mode: https` needs — so CI does not have to be an
   * admin to publish a preview. Anything else takes an admin.
   */
  allowed_public_ports?: number[];
}

export const DEFAULT_PUBLIC_PORTS = [80, 443];

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

/** Validates a policy document coming from the panel; absent/null fields mean unlimited. */
export function parsePolicies(input: any): Policies {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RunoError("policies must be an object");
  const known = ["allowed_instance_types", "max_disk_gb", "max_envs_per_user", "max_running_total", "env_ttl_days", "allowed_public_ports"];
  const unknown = Object.keys(input).filter((k) => !known.includes(k));
  if (unknown.length) throw new RunoError(`Unknown policy: ${unknown.join(", ")}`);
  const out: Policies = {};
  const types = input.allowed_instance_types;
  if (types !== undefined && types !== null) {
    if (!Array.isArray(types) || !types.length || types.some((t) => typeof t !== "string" || !/^[a-z0-9-]+\.[a-z0-9]+$/.test(t)))
      throw new RunoError("allowed_instance_types must be a non-empty list of instance types (e.g. t3.large)");
    out.allowed_instance_types = [...new Set(types as string[])];
  }
  for (const field of ["max_disk_gb", "max_envs_per_user", "max_running_total"] as const) {
    const v = input[field];
    if (v === undefined || v === null) continue;
    if (!Number.isInteger(v) || v < 1) throw new RunoError(`${field} must be a positive integer`);
    out[field] = v;
  }
  const ports = input.allowed_public_ports;
  if (ports !== undefined && ports !== null) {
    if (!Array.isArray(ports) || ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535))
      throw new RunoError("allowed_public_ports must be a list of ports (1-65535); an empty list means admins only");
    out.allowed_public_ports = [...new Set(ports as number[])];
  }
  const ttl = input.env_ttl_days;
  if (ttl !== undefined && ttl !== null) {
    if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) throw new RunoError("env_ttl_days must be a positive number");
    out.env_ttl_days = ttl;
  }
  return out;
}

/** Atomic replace — a crash mid-write must not leave a policies.yaml that blocks every create. */
export function savePolicies(pol: Policies): void {
  const p = POLICIES_PATH();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, stringify(pol), { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
}

export function enforceCreate(
  pol: Policies,
  spec: CreateSpec,
  ctx: { user: string; userRunningCount: number; runningTotal: number },
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
  if (pol.max_envs_per_user !== undefined && ctx.userRunningCount >= pol.max_envs_per_user)
    throw new RunoError(
      `Policy: you already have ${ctx.userRunningCount} environment(s) running (limit ${pol.max_envs_per_user})`,
      "Suspend or destroy one you no longer need (`runo ls`, `runo suspend`, `runo destroy`) and try again.",
    );
  if (pol.max_running_total !== undefined && ctx.runningTotal >= pol.max_running_total)
    throw new RunoError(
      `Policy: the organization already has ${ctx.runningTotal} instances running (limit ${pol.max_running_total})`,
      "Suspend or destroy environments, or talk to the platform team.",
    );
}

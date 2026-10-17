import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { HASH6, MAX_INSTANCES } from "../config";
import { RunoError } from "../errors";
import { log } from "../log";
import { SshVmProvider } from "./sshvm";
import type { CreateSpec, Runtime, RuntimeProvider, RuntimeState } from "./types";

const API = "https://compute.googleapis.com/compute/v1";
const METADATA = "http://metadata.google.internal/computeMetadata/v1";
const DEFAULT_IMAGE = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/**
 * Recipes written for AWS name EC2 sizes. Each maps to the E2 shape with the
 * same vCPU and memory, so one recipe works on both clouds; a recipe that
 * names a Compute Engine machine type is used as is.
 */
const FROM_EC2: Record<string, string> = {
  "t3.micro": "e2-micro",
  "t3.small": "e2-small",
  "t3.medium": "e2-medium",
  "t3.large": "e2-standard-2",
  "t3.xlarge": "e2-standard-4",
  "t3.2xlarge": "e2-standard-8",
  "m7i-flex.large": "e2-standard-2",
  "m7i-flex.xlarge": "e2-standard-4",
  "m7i-flex.2xlarge": "e2-standard-8",
};

export function machineTypeFor(instance: string): string {
  return FROM_EC2[instance.replace(/^t3a\./, "t3.")] ?? instance;
}

/** Compute Engine names: lowercase, digits and dashes, at most 63 characters. */
export function instanceNameFor(envName: string): string {
  const clean = envName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+$/, "");
  if (clean.length <= 63) return clean;
  const hash = createHash("sha256").update(envName).digest("hex").slice(0, 6);
  return `${clean.slice(0, 56).replace(/-+$/, "")}-${hash}`;
}

function labelValue(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 63);
}

/** Image family of a repo's base image: one per repo and install. */
export function imageFamilyFor(repo: string): string {
  const slug = repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  return `runo-${HASH6}-${slug}`.slice(0, 50).replace(/-+$/, "");
}

export function mapState(status: string | undefined): RuntimeState {
  switch (status) {
    case "PROVISIONING":
    case "STAGING":
      return "pending";
    case "RUNNING":
      return "running";
    case "STOPPING":
    case "SUSPENDING":
      return "stopping";
    // TERMINATED is Compute Engine's word for a stopped instance: its disk
    // and name survive and `start` brings it back. A deleted one is a 404.
    case "TERMINATED":
    case "STOPPED":
    case "SUSPENDED":
      return "stopped";
    default:
      return "unknown";
  }
}

/**
 * The shared cloud-init, adapted to Compute Engine images: they have no
 * default login user (runcmd adds `ubuntu` to the docker group, so it has to
 * exist first) and no EC2 hibernation agent to talk to.
 */
export function gceCloudInit(base: string, publicKey: string): string {
  const lines = base.split("\n").filter((l) => !/^\s*-\s*ec2-hibinit-agent\s*$/.test(l));
  const users = [
    "users:",
    "  - name: ubuntu",
    "    groups: [adm, sudo]",
    '    sudo: "ALL=(ALL) NOPASSWD:ALL"',
    "    shell: /bin/bash",
    "    lock_passwd: true",
    "    ssh_authorized_keys:",
    `      - ${publicKey.trim()}`,
  ];
  return `${lines.join("\n").trimEnd()}\n\n${users.join("\n")}\n`;
}

/**
 * Google Compute Engine. Configuration:
 *   RUNO_GCP_PROJECT   project the VMs live in (required)
 *   RUNO_GCP_ZONE      default us-central1-a
 *   RUNO_GCP_NETWORK   VPC network, default "default"
 *   RUNO_GCP_SUBNET    subnetwork, required on custom-mode networks
 *   RUNO_GCP_IMAGE     boot image, default Ubuntu 24.04 LTS (family)
 *   RUNO_GCP_DISK_TYPE default pd-balanced
 *
 * Credentials: the metadata server when runo runs on a Compute Engine VM
 * (the control plane, with its own service account), otherwise
 * `gcloud auth print-access-token`. RUNO_GCP_ACCESS_TOKEN overrides both.
 *
 * Environments get no service account: code running on them has no Google
 * Cloud credentials, so nothing in a preview can reach the project's APIs.
 */
export class GceProvider extends SshVmProvider implements RuntimeProvider {
  readonly name = "gce";
  protected readonly firewallHint = "firewall rule";
  readonly project = process.env.RUNO_GCP_PROJECT?.trim() ?? "";
  readonly zone = process.env.RUNO_GCP_ZONE?.trim() || "us-central1-a";
  readonly region = this.zone.replace(/-[a-z]$/, "");
  private network = process.env.RUNO_GCP_NETWORK?.trim() || "default";
  private subnet = process.env.RUNO_GCP_SUBNET?.trim() || "";
  private image = process.env.RUNO_GCP_IMAGE?.trim() || DEFAULT_IMAGE;
  private diskType = process.env.RUNO_GCP_DISK_TYPE?.trim() || "pd-balanced";
  private token?: { value: string; expires: number };
  private onGce?: boolean;
  private openPorts = new Set<string>();
  /** Poll interval of waitForState; a test shortens it. */
  private pollMs = 5000;

  constructor(private readonly options: {
    /** Server: hot-reloaded organization policy; undefined means unlimited. */
    runningInstanceLimit?: () => number | undefined;
  } = {}) {
    super();
  }

  /** Network tag on every env VM, and the name of the firewall rule that targets it. */
  private get netTag(): string {
    return `runo-${HASH6}`;
  }

  private inst(name: string): string {
    return `zones/${this.zone}/instances/${name}`;
  }

  // ---------- API ----------

  private async metadata(path: string): Promise<Response | null> {
    if (this.onGce === false) return null;
    try {
      const res = await fetch(`${METADATA}/${path}`, {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(1500),
      });
      this.onGce = true;
      return res.ok ? res : null;
    } catch {
      this.onGce = false;
      return null;
    }
  }

  private async accessToken(): Promise<string> {
    const injected = process.env.RUNO_GCP_ACCESS_TOKEN?.trim();
    if (injected) return injected;
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await this.metadata("instance/service-accounts/default/token");
    if (res) {
      const body = (await res.json()) as { access_token: string; expires_in: number };
      this.token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
      return body.access_token;
    }
    let out = "";
    try {
      const p = Bun.spawnSync(["gcloud", "auth", "print-access-token"], { stdout: "pipe", stderr: "pipe" });
      if (p.exitCode === 0) out = p.stdout.toString().trim();
    } catch {}
    if (!out)
      throw new RunoError(
        "No Google Cloud credentials",
        "Run `gcloud auth login`, or run runo on a Compute Engine VM with a service account",
      );
    // gcloud tokens last an hour; refresh well before that
    this.token = { value: out, expires: Date.now() + 30 * 60_000 };
    return out;
  }

  private async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith("https://") ? path : `${API}/projects/${this.project}/${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok)
      throw new GceError(res.status, data?.error?.message ?? (text || res.statusText), data?.error?.errors?.[0]?.reason);
    return data as T;
  }

  /** Blocks until a zonal or global operation is DONE; its error becomes ours. */
  private async waitOp(op: any, timeoutMs = 10 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let cur = op;
    while (cur?.status !== "DONE") {
      if (Date.now() > deadline)
        throw new RunoError(`Timed out waiting for ${op?.operationType ?? "operation"} on ${op?.targetLink ?? "?"}`);
      // the wait call itself returns after at most ~2 minutes
      cur = await this.api("POST", `${op.selfLink}/wait`);
    }
    const errors = cur.error?.errors ?? [];
    if (errors.length)
      throw new GceError(400, errors.map((e: any) => e.message).join("; "), errors[0]?.code);
  }

  async preflight(): Promise<void> {
    if (!this.project)
      throw new RunoError(
        "RUNO_GCP_PROJECT is not set",
        "Set the Google Cloud project runo creates its VMs in (and RUNO_GCP_ZONE, default us-central1-a)",
      );
    try {
      await this.api("GET", `zones/${this.zone}`);
    } catch (e: any) {
      if (e instanceof RunoError) throw e;
      throw new RunoError(
        `No access to Compute Engine in ${this.project}/${this.zone} (${e?.message})`,
        "The identity needs roles/compute.instanceAdmin.v1 and roles/compute.securityAdmin on that project",
      );
    }
    const expected = process.env.RUNO_EXPECTED_GCP_IDENTITY?.trim();
    if (expected) {
      const who = await this.identity();
      if (who !== expected)
        throw new RunoError(
          `Google Cloud identity is ${who || "unknown"}, expected ${expected}`,
          "Refusing to manage VMs as any other identity (RUNO_EXPECTED_GCP_IDENTITY)",
        );
    }
  }

  private async identity(): Promise<string> {
    const res = await this.metadata("instance/service-accounts/default/email");
    if (res) return (await res.text()).trim();
    try {
      const p = Bun.spawnSync(["gcloud", "config", "get-value", "account"], { stdout: "pipe", stderr: "pipe" });
      return p.stdout.toString().trim();
    } catch {
      return "";
    }
  }

  // ---------- firewall ----------

  async ensurePorts(ports: number[]): Promise<void> {
    const want = ["22", ...ports.map(String)].filter((p, i, all) => all.indexOf(p) === i);
    if (want.every((p) => this.openPorts.has(p))) return;
    const path = `global/firewalls/${this.netTag}`;
    let rule: any;
    try {
      rule = await this.api("GET", path);
    } catch (e: any) {
      if (!(e instanceof GceError) || e.status !== 404) throw e;
    }
    if (!rule) {
      try {
        await this.waitOp(
          await this.api("POST", "global/firewalls", {
            name: this.netTag,
            description: "runo managed - SSH + public service ports",
            network: `global/networks/${this.network}`,
            direction: "INGRESS",
            sourceRanges: ["0.0.0.0/0"],
            targetTags: [this.netTag],
            allowed: [{ IPProtocol: "tcp", ports: want }],
          }),
        );
      } catch (e: any) {
        // another runo created it a moment ago: merge into theirs
        if (e instanceof GceError && e.status === 409) return await this.ensurePorts(ports);
        throw e;
      }
      want.forEach((p) => this.openPorts.add(p));
      return;
    }
    const have: string[] = (rule.allowed ?? []).flatMap((a: any) => (a.IPProtocol === "tcp" ? a.ports ?? [] : []));
    const missing = want.filter((p) => !have.includes(p));
    if (missing.length)
      await this.waitOp(
        await this.api("PATCH", path, { allowed: [{ IPProtocol: "tcp", ports: [...have, ...missing] }] }),
      );
    [...have, ...missing].forEach((p) => this.openPorts.add(p));
  }

  // ---------- lifecycle ----------

  private mapInstance(i: any): Runtime {
    const meta: Record<string, string> = Object.fromEntries(
      (i?.metadata?.items ?? []).map((m: any) => [m.key, m.value]),
    );
    return {
      id: i.name,
      ip: i.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? null,
      state: mapState(i.status),
      gceStatus: i.status,
      instanceType: String(i.machineType ?? "").split("/").pop(),
      launchedAt: i.lastStartTimestamp ?? i.creationTimestamp,
      name: meta["runo-env-name"] ?? i.name,
      lifecycle: i.scheduling?.provisioningModel === "SPOT" ? "spot" : undefined,
      bootDisk: (i.disks ?? []).find((d: any) => d.boot)?.source,
      ...(meta["runo-profile"] ? { profile: meta["runo-profile"] } : {}),
    };
  }

  private async describe(id: string): Promise<Runtime> {
    if (!id) return { id, ip: null, state: "unknown" };
    try {
      return this.mapInstance(await this.api("GET", this.inst(id)));
    } catch (e: any) {
      if (e instanceof GceError && e.status === 404) return { id, ip: null, state: "terminated", notFound: true };
      throw e;
    }
  }

  private async waitForState(id: string, want: RuntimeState, timeoutMs: number, requireIp = false): Promise<Runtime> {
    const deadline = Date.now() + timeoutMs;
    let last: Runtime = { id, ip: null, state: "unknown" };
    while (Date.now() < deadline) {
      last = await this.describe(id);
      if (last.state === want && (!requireIp || last.ip)) return last;
      if (want !== "terminated" && last.state === "terminated")
        throw new RunoError(`Instance ${id} was deleted unexpectedly`);
      await sleep(this.pollMs);
    }
    throw new RunoError(`Timed out waiting for instance ${id} to reach "${want}" (last state: ${last.state})`);
  }

  /** Cost guardrail: only counts RUNNING instances (stopped ones cost only disk). */
  private async guardrail(): Promise<void> {
    const maxInstances = this.options.runningInstanceLimit
      ? this.options.runningInstanceLimit()
      : MAX_INSTANCES;
    if (maxInstances === undefined) return;
    const active = (await this.listManaged()).filter((m) => m.state === "running" || m.state === "pending");
    if (active.length >= maxInstances)
      throw new RunoError(
        `Cost guardrail: ${active.length} runo instances running (max ${maxInstances}): ${active
          .map((m) => m.name ?? m.id)
          .join(", ")}`,
        "Suspend/destroy environments (`runo ls`, `runo suspend`, `runo destroy`)",
      );
  }

  private instanceBody(
    spec: CreateSpec,
    name: string,
    machineType: string,
    spot: boolean,
    base: { image: string; diskGb: number } | null = null,
  ): Record<string, unknown> {
    const publicKey = readFileSync(`${this.keyPath}.pub`, "utf8").trim();
    const labels = {
      runo_managed: "true",
      runo_home_hash: HASH6,
      runo_env: labelValue(spec.slug),
    };
    const items: Record<string, string> = {
      // a repo's base image was provisioned already: no cloud-init to run
      ...(base
        ? {}
        : {
            "user-data": gceCloudInit(
              readFileSync(new URL("../../image/cloud-init.yaml", import.meta.url).pathname, "utf8"),
              publicKey,
            ),
          }),
      "ssh-keys": `ubuntu:${publicKey}`,
      // runo's key is the only way in: no OS Login, no project-wide keys
      "enable-oslogin": "FALSE",
      "block-project-ssh-keys": "TRUE",
      "runo-env-name": spec.envName,
      "runo-repo": spec.repo,
      "runo-branch": spec.branch,
      ...(spec.profile ? { "runo-profile": spec.profile } : {}),
    };
    return {
      name,
      machineType: `zones/${this.zone}/machineTypes/${machineType}`,
      labels,
      tags: { items: [this.netTag] },
      metadata: { items: Object.entries(items).map(([key, value]) => ({ key, value })) },
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: base?.image ?? this.image,
            // never smaller than the image it is created from
            diskSizeGb: String(Math.max(spec.diskGb, base?.diskGb ?? 0)),
            diskType: `zones/${this.zone}/diskTypes/${this.diskType}`,
            labels,
          },
        },
      ],
      networkInterfaces: [
        {
          network: `global/networks/${this.network}`,
          ...(this.subnet ? { subnetwork: `regions/${this.region}/subnetworks/${this.subnet}` } : {}),
          accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
        },
      ],
      // no service account: nothing on the VM holds Google Cloud credentials
      serviceAccounts: [],
      scheduling: spot
        ? {
            provisioningModel: "SPOT",
            // preemption = stop: the disk survives, runo resume restarts it
            instanceTerminationAction: "STOP",
            onHostMaintenance: "TERMINATE",
            automaticRestart: false,
          }
        : { onHostMaintenance: "MIGRATE", automaticRestart: true },
    };
  }

  private explain(e: any): never {
    const reason = e instanceof GceError ? e.reason ?? "" : "";
    if (/QUOTA_EXCEEDED|quotaExceeded/i.test(reason) || /quota/i.test(e?.message ?? ""))
      throw new RunoError(
        `Compute Engine refused the instance: quota exceeded (${e.message})`,
        "Destroy unused envs (`runo ls` / `runo destroy`) or raise the CPU quota of the region in IAM & Admin → Quotas",
      );
    if (e instanceof GceError && e.status === 403)
      throw new RunoError(
        `Compute Engine refused the request: no permission (${e.message})`,
        "The identity needs roles/compute.instanceAdmin.v1 and roles/compute.securityAdmin on the project",
      );
    throw e;
  }

  async create(spec: CreateSpec): Promise<Runtime> {
    await this.guardrail();
    this.ensureLocalKey();
    await this.ensurePorts([]);
    const name = instanceNameFor(spec.envName);
    const machineType = machineTypeFor(spec.instanceType);
    if (machineType !== spec.instanceType)
      log.dim(`${spec.instanceType} → ${machineType} (same vCPU and memory on Compute Engine)`);

    const base = await this.repoImage(spec.repo);
    if (base) log.dim(`booting from ${spec.repo}'s base image ${base.name} (runo bake --from-env)`);
    const launch = async (spot: boolean) => {
      const op = await this.api("POST", `zones/${this.zone}/instances`, this.instanceBody(spec, name, machineType, spot, base));
      await this.waitOp(op);
    };
    try {
      if (spec.spot) {
        try {
          await launch(true);
          log.dim("SPOT instance (preemption = stop) — cheaper than on-demand");
        } catch (e: any) {
          if (e instanceof GceError && e.status === 403) this.explain(e);
          log.warn(`spot unavailable right now (${e?.reason || e?.message}) — falling back to on-demand`);
          await this.deleteQuietly(name);
          await launch(false);
        }
      } else {
        await launch(false);
      }
    } catch (e: any) {
      await this.deleteQuietly(name);
      this.explain(e);
    }
    log.dim(`instance ${name} created (${machineType}, ${spec.diskGb}GB ${this.diskType}, ${this.zone})`);
    try {
      return await this.waitForState(name, "running", 5 * 60_000, true);
    } catch (e) {
      // the caller never learns this name when create fails, so nothing would
      // ever delete it: an instance that did not come up must not outlive
      // the error that reported it
      log.warn(`instance ${name} did not come up — deleting it so it cannot leak`);
      await this.deleteQuietly(name);
      throw e;
    }
  }

  private async deleteQuietly(name: string): Promise<void> {
    try {
      await this.waitOp(await this.api("DELETE", this.inst(name)));
    } catch (e: any) {
      if (!(e instanceof GceError && e.status === 404))
        log.warn(`could not delete ${name}: ${e?.message ?? e} — delete it by hand`);
    }
  }

  async status(rt: Runtime): Promise<Runtime> {
    return await this.describe(rt.id);
  }

  async suspend(rt: Runtime): Promise<Runtime> {
    const fresh = await this.describe(rt.id);
    if (fresh.lifecycle !== "spot") {
      try {
        await this.waitOp(await this.api("POST", `${this.inst(rt.id)}/suspend`));
        log.dim("suspended (RAM → disk): the next resume comes back with services hot");
        return await this.waitForState(rt.id, "stopped", 10 * 60_000);
      } catch (e: any) {
        log.warn(`suspend unavailable (${e?.message ?? e}) — plain stop`);
      }
    }
    const now = await this.describe(rt.id);
    if (now.state !== "stopped") await this.waitOp(await this.api("POST", `${this.inst(rt.id)}/stop`));
    return await this.waitForState(rt.id, "stopped", 10 * 60_000);
  }

  async resume(rt: Runtime): Promise<Runtime> {
    const fresh = await this.describe(rt.id);
    if (fresh.state === "running") return fresh.ip ? fresh : this.waitForState(rt.id, "running", 5 * 60_000, true);
    if (fresh.state === "pending") return this.waitForState(rt.id, "running", 5 * 60_000, true);
    await this.guardrail();
    const verb = fresh.gceStatus === "SUSPENDED" ? "resume" : "start";
    try {
      await this.waitOp(await this.api("POST", `${this.inst(rt.id)}/${verb}`));
    } catch (e: any) {
      if (/RESOURCE_POOL_EXHAUSTED|STOCKOUT/i.test(`${e?.reason} ${e?.message}`))
        throw new RunoError(
          `No capacity in ${this.zone} to restart the instance right now`,
          "Try again in a few minutes, or `runo destroy` + recreate (a spot recipe can drop `limits.spot`)",
        );
      throw e;
    }
    return await this.waitForState(rt.id, "running", 5 * 60_000, true);
  }

  async destroy(rt: Runtime): Promise<void> {
    try {
      await this.waitOp(await this.api("DELETE", this.inst(rt.id)), 8 * 60_000);
    } catch (e: any) {
      if (e instanceof GceError && e.status === 404) return;
      throw e;
    }
  }

  // ---------- base images (runo bake --from-env) ----------

  private async repoImages(repo?: string): Promise<any[]> {
    const filter = [
      `labels.runo_home_hash = "${HASH6}"`,
      ...(repo ? [`labels.runo_base_image = "${labelValue(repo)}"`] : []),
    ].join(" AND ");
    const page = await this.api("GET", `global/images?${new URLSearchParams({ filter })}`);
    return (page?.items ?? [])
      .filter((i: any) => !repo || i.status === "READY")
      .sort((a: any, b: any) => String(b.creationTimestamp ?? "").localeCompare(String(a.creationTimestamp ?? "")));
  }

  /** The newest ready base image of the repo, when one was baked. */
  private async repoImage(repo: string): Promise<{ name: string; image: string; diskGb: number } | null> {
    try {
      const newest = (await this.repoImages(repo))[0];
      return newest ? { name: newest.name, image: `global/images/${newest.name}`, diskGb: Number(newest.diskSizeGb ?? 0) } : null;
    } catch (e: any) {
      log.warn(`could not look up ${repo}'s base image (${e?.message ?? e}) — booting the stock image`);
      return null;
    }
  }

  async imageFromRuntime(rt: Runtime, repo: string): Promise<string> {
    let fresh = await this.describe(rt.id);
    if (fresh.state === "terminated") throw new RunoError(`Instance ${rt.id} no longer exists`);
    // the disk has to be quiet: a suspended VM still owns its memory state
    if (fresh.gceStatus === "SUSPENDED") {
      await this.waitOp(await this.api("POST", `${this.inst(rt.id)}/resume`));
      fresh = await this.waitForState(rt.id, "running", 5 * 60_000);
    }
    if (fresh.state !== "stopped") {
      log.step("stopping the environment to image its disk…");
      await this.waitOp(await this.api("POST", `${this.inst(rt.id)}/stop`));
      fresh = await this.waitForState(rt.id, "stopped", 10 * 60_000);
    }
    const disk = String(fresh.bootDisk ?? "");
    const at = disk.indexOf(`/projects/${this.project}/`);
    if (at < 0) throw new RunoError(`Could not find the boot disk of ${rt.id}`);
    const family = imageFamilyFor(repo);
    const name = `${family}-${Date.now().toString(36)}`;
    const labels = { runo_managed: "true", runo_home_hash: HASH6, runo_base_image: labelValue(repo) };
    log.step(`creating image ${name} from ${rt.name ?? rt.id}…`);
    await this.waitOp(
      await this.api("POST", "global/images", {
        name,
        family,
        sourceDisk: disk.slice(at + `/projects/${this.project}/`.length),
        labels,
        description: `runo base image for ${repo}, from ${rt.name ?? rt.id}`,
      }),
      30 * 60_000,
    );
    // keep the previous one: a bad bake must be one delete away from rollback
    for (const old of (await this.repoImages(repo)).slice(2)) {
      try {
        await this.waitOp(await this.api("DELETE", `global/images/${old.name}`));
        log.dim(`old image ${old.name} removed`);
      } catch (e: any) {
        log.warn(`could not remove old image ${old.name}: ${e?.message ?? e}`);
      }
    }
    return name;
  }

  async prepareBootImage(): Promise<string> {
    throw new RunoError(
      "runo bake on Compute Engine images an environment that already ran the recipe",
      "Bring an env up (runo up), let it finish, then run `runo bake --from-env`",
    );
  }

  async removeBootImage(): Promise<void> {
    const images = await this.repoImages();
    if (!images.length) {
      log.warn("no base image to remove");
      return;
    }
    for (const img of images) {
      await this.waitOp(await this.api("DELETE", `global/images/${img.name}`));
      log.ok(`image ${img.name} removed`);
    }
  }

  // ---------- not offered on Compute Engine yet ----------

  async poolStatus(): Promise<Runtime[]> {
    return [];
  }

  async poolScale(): Promise<void> {
    throw new RunoError(
      "runo pool is not available on Compute Engine yet",
      "Suspended environments resume in about a minute; keep one suspended instead of a pool",
    );
  }

  // ---------- inventory / cleanup ----------

  private async listRaw(): Promise<any[]> {
    const filter = `labels.runo_managed = "true" AND labels.runo_home_hash = "${HASH6}"`;
    const out: any[] = [];
    let pageToken = "";
    do {
      const qs = new URLSearchParams({ filter, ...(pageToken ? { pageToken } : {}) });
      const page = await this.api("GET", `zones/${this.zone}/instances?${qs}`);
      out.push(...(page?.items ?? []));
      pageToken = page?.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  async findByTags(repo: string, branch: string, profile?: string): Promise<Runtime | null> {
    // a profile-less lookup must not adopt a profiled env
    return (await this.listByBranch(repo, branch)).find((rt) => (rt.profile ?? undefined) === profile) ?? null;
  }

  async listByBranch(repo: string, branch: string): Promise<Runtime[]> {
    const meta = (i: any, key: string) => (i.metadata?.items ?? []).find((m: any) => m.key === key)?.value;
    return (await this.listRaw())
      .filter((i) => meta(i, "runo-repo") === repo && meta(i, "runo-branch") === branch)
      .sort((a, b) => String(b.creationTimestamp ?? "").localeCompare(String(a.creationTimestamp ?? "")))
      .map((i) => this.mapInstance(i));
  }

  async listManaged(): Promise<Runtime[]> {
    return (await this.listRaw()).map((i) => this.mapInstance(i));
  }

  async cleanupShared(): Promise<void> {
    try {
      await this.waitOp(await this.api("DELETE", `global/firewalls/${this.netTag}`));
      log.dim(`firewall rule ${this.netTag} removed`);
    } catch (e: any) {
      if (!(e instanceof GceError && e.status === 404)) throw e;
    }
    this.openPorts.clear();
  }
}

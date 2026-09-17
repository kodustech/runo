import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  CreateSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  AuthorizeSecurityGroupIngressCommand,
  DeleteSecurityGroupCommand,
  ImportKeyPairCommand,
  DescribeKeyPairsCommand,
  DeleteKeyPairCommand,
  DescribeVpcsCommand,
  DescribeImagesCommand,
  CreateImageCommand,
  DeregisterImageCommand,
  DeleteSnapshotCommand,
  CreateTagsCommand,
  DeleteTagsCommand,
  ModifyInstanceAttributeCommand,
  DescribeVolumesCommand,
  ModifyVolumeCommand,
  CancelSpotInstanceRequestsCommand,
  type Instance,
  type Tag,
} from "@aws-sdk/client-ec2";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { AWS_REGION, HASH6, RUNO_HOME, MAX_INSTANCES, REMOTE_USER, SSH_DIR } from "../config";
import { RunoError } from "../errors";
import { verifyIdentity } from "./identity";
import { log } from "../log";
import { rsyncPull, rsyncPush, scpUpload, shq, sshBaseArgs, sshCloseMaster, sshExec, sshInteractive, type SshTarget } from "../ssh";
import type { CreateSpec, ExecOpts, ExecResult, Runtime, RuntimeProvider, RuntimeState } from "./types";

const AMI_SSM_PARAM =
  "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errCode(e: any): string {
  return e?.name ?? e?.Code ?? "";
}

export class Ec2Provider implements RuntimeProvider {
  readonly name = "aws";
  private ec2 = new EC2Client({ region: AWS_REGION });
  private ssm = new SSMClient({ region: AWS_REGION });
  private sts = new STSClient({ region: AWS_REGION });
  private sgIdCache?: string;

  private get keyName(): string {
    return `runo-${HASH6}`;
  }
  private get sgName(): string {
    return `runo-${HASH6}`;
  }
  private get keyPath(): string {
    return path.join(SSH_DIR, this.keyName);
  }

  /**
   * Writes RUNO_SSH_KEY to disk if it is not there yet. Every ssh operation
   * goes through target(), including the ones that create nothing — adopting
   * an existing env skips ensureKeyPair entirely, and without the key on disk
   * that env looks unreachable and gets rebuilt from scratch.
   */
  private materializeInjectedKey(): void {
    const injected = process.env.RUNO_SSH_KEY;
    if (!injected || existsSync(this.keyPath)) return;
    mkdirSync(SSH_DIR, { recursive: true });
    writeFileSync(this.keyPath, injected.endsWith("\n") ? injected : `${injected}\n`, {
      mode: 0o600,
    });
    const pub = Bun.spawnSync(["ssh-keygen", "-y", "-f", this.keyPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (pub.exitCode !== 0)
      throw new RunoError(
        `RUNO_SSH_KEY is not a usable private key: ${pub.stderr.toString().trim()}`,
        "Pass the full private key, newlines included",
      );
    writeFileSync(`${this.keyPath}.pub`, pub.stdout.toString());
  }

  private target(rt: Runtime): SshTarget {
    this.materializeInjectedKey();
    if (!rt.ip)
      throw new RunoError(
        `Environment ${rt.name ?? rt.id} has no public IP (state: ${rt.state})`,
        "If it is stopped, run `runo resume`",
      );
    return { ip: rt.ip, user: REMOTE_USER, keyPath: this.keyPath };
  }

  async preflight(): Promise<void> {
    try {
      const identity = await this.sts.send(new GetCallerIdentityCommand({}));
      verifyIdentity(identity.Arn, AWS_REGION, process.env.RUNO_EXPECTED_AWS_ARN, process.env.RUNO_EXPECTED_AWS_REGION);
    } catch (e: any) {
      if (e instanceof RunoError) throw e;
      throw new RunoError(
        `Invalid or missing AWS credentials (${errCode(e) || e?.message})`,
        "Configure credentials (AWS_PROFILE / aws configure) and confirm with `aws sts get-caller-identity`. Region in use: " +
          AWS_REGION,
      );
    }
  }

  // ---------- shared resources ----------

  private async ensureKeyPair(): Promise<void> {
    mkdirSync(SSH_DIR, { recursive: true });
    const pubPath = `${this.keyPath}.pub`;
    // RUNO_SSH_KEY: the private key as a value instead of a file. An ephemeral
    // CI runner has no ~/.runo, so without this every job would generate a new
    // key, re-import the AWS keypair, and lock itself out of the environment
    // the previous job created for the same branch.
    this.materializeInjectedKey();
    if (!existsSync(this.keyPath)) {
      const gen = Bun.spawnSync(
        ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", this.keyName, "-f", this.keyPath],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (gen.exitCode !== 0)
        throw new RunoError(`Failed to generate SSH key: ${gen.stderr.toString()}`);
      // fresh local key → any old AWS keypair with this name is garbage
      try {
        await this.ec2.send(new DeleteKeyPairCommand({ KeyName: this.keyName }));
      } catch {}
    }
    try {
      await this.ec2.send(new DescribeKeyPairsCommand({ KeyNames: [this.keyName] }));
    } catch (e: any) {
      if (errCode(e) !== "InvalidKeyPair.NotFound") throw e;
      await this.ec2.send(
        new ImportKeyPairCommand({
          KeyName: this.keyName,
          PublicKeyMaterial: new TextEncoder().encode(readFileSync(pubPath, "utf8")),
        }),
      );
    }
  }

  private async ensureSecurityGroup(): Promise<string> {
    if (this.sgIdCache) return this.sgIdCache;
    const found = await this.ec2.send(
      new DescribeSecurityGroupsCommand({
        Filters: [{ Name: "group-name", Values: [this.sgName] }],
      }),
    );
    let sgId = found.SecurityGroups?.[0]?.GroupId;
    if (!sgId) {
      const vpcs = await this.ec2.send(
        new DescribeVpcsCommand({ Filters: [{ Name: "is-default", Values: ["true"] }] }),
      );
      const vpcId = vpcs.Vpcs?.[0]?.VpcId;
      if (!vpcId)
        throw new RunoError(
          `No default VPC in region ${AWS_REGION}`,
          "Create a default VPC (`aws ec2 create-default-vpc`) or use another region via RUNO_AWS_REGION",
        );
      const created = await this.ec2.send(
        new CreateSecurityGroupCommand({
          GroupName: this.sgName,
          Description: "runo managed - SSH + public service ports",
          VpcId: vpcId,
          TagSpecifications: [
            {
              ResourceType: "security-group",
              Tags: [
                { Key: "Name", Value: this.sgName },
                { Key: "runo:managed", Value: "true" },
                { Key: "runo:home-hash", Value: HASH6 },
              ],
            },
          ],
        }),
      );
      sgId = created.GroupId!;
    }
    this.sgIdCache = sgId;
    await this.ensurePorts([22]);
    return sgId;
  }

  async ensurePorts(ports: number[]): Promise<void> {
    const sgId = this.sgIdCache ?? (await this.ensureSecurityGroup());
    for (const port of ports) {
      try {
        await this.ec2.send(
          new AuthorizeSecurityGroupIngressCommand({
            GroupId: sgId,
            IpPermissions: [
              {
                IpProtocol: "tcp",
                FromPort: port,
                ToPort: port,
                IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "runo" }],
              },
            ],
          }),
        );
      } catch (e: any) {
        if (errCode(e) !== "InvalidPermission.Duplicate") throw e;
      }
    }
  }

  // ---------- base image (runo bake) ----------

  private get bakedImagePath(): string {
    return path.join(RUNO_HOME, "aws-base-ami.json");
  }

  private loadBakedImage(): { imageId: string; region: string } | null {
    try {
      const data = JSON.parse(readFileSync(this.bakedImagePath, "utf8"));
      return data?.imageId && data?.region === AWS_REGION ? data : null;
    } catch {
      return null;
    }
  }

  private async canonicalAmi(): Promise<{ amiId: string; rootDevice: string }> {
    // Restricted deployments can pin an EC2 image without granting SSM access.
    if (process.env.RUNO_AWS_AMI) {
      const img = await this.ec2.send(new DescribeImagesCommand({ ImageIds: [process.env.RUNO_AWS_AMI] }));
      const image = img.Images?.[0];
      if (!image || image.State !== "available" || image.Architecture !== "x86_64")
        throw new RunoError("RUNO_AWS_AMI must be an available x86_64 image in the configured region");
      return { amiId: image.ImageId!, rootDevice: image.RootDeviceName ?? "/dev/sda1" };
    }
    const param = await this.ssm.send(new GetParameterCommand({ Name: AMI_SSM_PARAM }));
    const amiId = param.Parameter?.Value;
    if (!amiId)
      throw new RunoError(`Could not resolve the Ubuntu 24.04 AMI via SSM in ${AWS_REGION}`);
    const img = await this.ec2.send(new DescribeImagesCommand({ ImageIds: [amiId] }));
    return { amiId, rootDevice: img.Images?.[0]?.RootDeviceName ?? "/dev/sda1" };
  }

  /**
   * A baked image this account owns for this repo, found by tag. The local
   * pointer file only exists on the machine that baked it — CI bakes nightly,
   * and every developer should get that speed-up without re-baking.
   */
  private async sharedBakedImage(repo: string): Promise<string | null> {
    try {
      const res = await this.ec2.send(
        new DescribeImagesCommand({
          Owners: ["self"],
          Filters: [
            { Name: "tag:runo:base-image", Values: [repo] },
            { Name: "state", Values: ["available"] },
          ],
        }),
      );
      const newest = (res.Images ?? []).sort((a, b) =>
        (b.CreationDate ?? "").localeCompare(a.CreationDate ?? ""),
      )[0];
      return newest?.ImageId ?? null;
    } catch {
      return null;
    }
  }

  /** Baked AMI from runo bake when available; canonical Ubuntu otherwise. */
  private async resolveAmi(repo?: string): Promise<{ amiId: string; rootDevice: string; baked: boolean }> {
    const baked = this.loadBakedImage();
    if (baked) {
      try {
        const img = await this.ec2.send(new DescribeImagesCommand({ ImageIds: [baked.imageId] }));
        const image = img.Images?.[0];
        if (image?.State === "available")
          return { amiId: baked.imageId, rootDevice: image.RootDeviceName ?? "/dev/sda1", baked: true };
      } catch {}
      log.warn(`baked image ${baked.imageId} is no longer available — using the canonical AMI (run runo bake again)`);
      rmSync(this.bakedImagePath, { force: true });
    }
    if (repo) {
      const shared = await this.sharedBakedImage(repo);
      if (shared) {
        const img = await this.ec2.send(new DescribeImagesCommand({ ImageIds: [shared] }));
        const image = img.Images?.[0];
        if (image?.State === "available") {
          log.dim(`using the baked image for ${repo} (${shared}) — no local bake needed`);
          return { amiId: shared, rootDevice: image.RootDeviceName ?? "/dev/sda1", baked: true };
        }
      }
    }
    return { ...(await this.canonicalAmi()), baked: false };
  }

  // ---------- lifecycle ----------

  private envTags(spec: CreateSpec): Tag[] {
    return [
      { Key: "Name", Value: spec.envName },
      { Key: "runo:env", Value: spec.slug },
      { Key: "runo:managed", Value: "true" },
      { Key: "runo:home-hash", Value: HASH6 },
      { Key: "runo:repo", Value: spec.repo },
      { Key: "runo:branch", Value: spec.branch },
    ];
  }

  /** Cost guardrail: only counts RUNNING instances (stopped ones cost only EBS). */
  private async guardrail(): Promise<void> {
    const active = (await this.listManaged()).filter(
      (m) => m.state === "running" || m.state === "pending",
    );
    if (active.length >= MAX_INSTANCES)
      throw new RunoError(
        `Cost guardrail: ${active.length} runo instances running (max ${MAX_INSTANCES}): ${active
          .map((m) => m.name ?? m.id)
          .join(", ")}`,
        "Suspend/destroy environments (`runo ls`, `runo suspend`, `runo destroy`)",
      );
  }

  /**
   * RunInstances with hibernation enabled (encrypted root); if the account/
   * type/AMI does not support it, relaunches without hibernation (graceful
   * fallback).
   */
  private async launchInstance(opts: {
    instanceType: string;
    diskGb: number;
    tags: Tag[];
    sgId: string;
    spot?: boolean;
    repo?: string;
  }): Promise<string> {
    const { amiId, rootDevice, baked } = await this.resolveAmi(opts.repo);
    if (baked) log.dim(`using baked image ${amiId} (runo bake) — fast boot, no heavy cloud-init`);
    const cloudInitPath = new URL("../../image/cloud-init.yaml", import.meta.url).pathname;
    const userData = baked
      ? undefined
      : Buffer.from(readFileSync(cloudInitPath, "utf8")).toString("base64");

    // spot: no hibernation and no InstanceInitiatedShutdownBehavior (the API
    // rejects it); interrupting/shutting down a persistent spot instance
    // already results in "stopped"
    const input = (mode: "spot" | "hibernation" | "plain") => ({
      ImageId: amiId,
      InstanceType: opts.instanceType as any,
      KeyName: this.keyName,
      MinCount: 1,
      MaxCount: 1,
      ...(userData ? { UserData: userData } : {}),
      NetworkInterfaces: [{ DeviceIndex: 0, AssociatePublicIpAddress: true, Groups: [opts.sgId],
        ...(process.env.RUNO_AWS_SUBNET ? { SubnetId: process.env.RUNO_AWS_SUBNET } : {}),
      }],
      BlockDeviceMappings: [
        {
          DeviceName: rootDevice,
          Ebs: {
            VolumeSize: opts.diskGb,
            VolumeType: "gp3" as const,
            // above the free gp3 baseline (3000/125): docker builds/pulls are
            // IO-bound and this costs ~US$0.01/h prorated
            Iops: 4000,
            Throughput: 300,
            DeleteOnTermination: true,
            // hibernation requires an encrypted root (default aws/ebs key)
            ...(mode === "hibernation" ? { Encrypted: true } : {}),
          },
        },
      ],
      // burstable families: never throttle mid-build (surcharge only while
      // bursting above baseline — cheaper than a wedged 30min build)
      ...(opts.instanceType.startsWith("t")
        ? { CreditSpecification: { CpuCredits: "unlimited" } }
        : {}),
      ...(mode === "spot"
        ? {
            InstanceMarketOptions: {
              MarketType: "spot" as const,
              SpotOptions: {
                SpotInstanceType: "persistent" as const,
                // interruption = stop: EBS survives, runo resume restarts later
                InstanceInterruptionBehavior: "stop" as const,
              },
            },
          }
        : {
            // in-VM shutdown (auto-suspend) = "stopped", not terminated
            InstanceInitiatedShutdownBehavior: "stop" as const,
          }),
      ...(mode === "hibernation" ? { HibernationOptions: { Configured: true } } : {}),
      TagSpecifications: [
        { ResourceType: "instance" as const, Tags: opts.tags },
        { ResourceType: "volume" as const, Tags: opts.tags },
      ],
    });

    const explainOrThrow = (e: any): void => {
      const code = errCode(e);
      if (code === "VcpuLimitExceeded")
        throw new RunoError(
          "AWS refused the instance: on-demand vCPU quota exceeded (VcpuLimitExceeded)",
          "Destroy unused envs (`runo ls` / `runo destroy`) or request a quota increase in Service Quotas → Running On-Demand Standard instances",
        );
      if (code === "UnauthorizedOperation")
        throw new RunoError(
          "AWS refused RunInstances: no permission (UnauthorizedOperation)",
          "The IAM user needs EC2 permissions (RunInstances, Describe*, CreateSecurityGroup, ImportKeyPair...)",
        );
    };

    if (opts.spot) {
      try {
        const res = await this.ec2.send(new RunInstancesCommand(input("spot")));
        log.dim("SPOT instance (persistent, interruption=stop) — ~70% cheaper than on-demand");
        return res.Instances![0]!.InstanceId!;
      } catch (e: any) {
        explainOrThrow(e);
        log.warn(`spot unavailable right now (${errCode(e)}) — falling back to on-demand`);
      }
    }
    try {
      const res = await this.ec2.send(new RunInstancesCommand(input("hibernation")));
      return res.Instances![0]!.InstanceId!;
    } catch (e: any) {
      explainOrThrow(e);
      log.warn(`launch with hibernation failed (${errCode(e)}) — creating without hibernation`);
      const res = await this.ec2.send(new RunInstancesCommand(input("plain")));
      return res.Instances![0]!.InstanceId!;
    }
  }

  async create(spec: CreateSpec): Promise<Runtime> {
    await this.guardrail();
    await this.ensureKeyPair();
    const sgId = await this.ensureSecurityGroup();

    // warm pool first: starting a stopped instance beats creating one.
    // Spot envs do NOT use the pool (pool instances are on-demand — they can't
    // be converted; a direct spot launch is fast and it's the cheapest path).
    if (!spec.spot) {
      try {
        const claimed = await this.claimFromPool(spec);
        if (claimed) return claimed;
      } catch (e: any) {
        log.warn(`warm pool claim failed (${e?.message ?? e}) — creating from scratch`);
      }
    }

    const id = await this.launchInstance({
      instanceType: spec.instanceType,
      diskGb: spec.diskGb,
      tags: this.envTags(spec),
      sgId,
      spot: spec.spot,
      repo: spec.repo,
    });
    log.dim(`instance ${id} created (${spec.instanceType}, ${spec.diskGb}GB gp3, ${AWS_REGION})`);
    return await this.waitForState(id, "running", 5 * 60_000, true);
  }

  private mapInstance(i: Instance | undefined, id: string): Runtime {
    if (!i) return { id, ip: null, state: "terminated" };
    const nameTag = i.Tags?.find((t) => t.Key === "Name")?.Value;
    return {
      id,
      ip: i.PublicIpAddress ?? null,
      state: (i.State?.Name as RuntimeState) ?? "unknown",
      instanceType: i.InstanceType,
      launchedAt: i.LaunchTime?.toISOString(),
      name: nameTag,
      lifecycle: i.InstanceLifecycle, // "spot" | undefined (on-demand)
      spotRequestId: i.SpotInstanceRequestId,
    };
  }

  private async describe(id: string): Promise<Runtime> {
    // without an id, DescribeInstances would list the whole account
    if (!id) return { id, ip: null, state: "unknown" };
    try {
      const res = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }));
      return this.mapInstance(res.Reservations?.[0]?.Instances?.[0], id);
    } catch (e: any) {
      if (errCode(e) === "InvalidInstanceID.NotFound") return { id, ip: null, state: "terminated" };
      throw e;
    }
  }

  private async waitForState(
    id: string,
    want: RuntimeState,
    timeoutMs: number,
    requireIp = false,
  ): Promise<Runtime> {
    const deadline = Date.now() + timeoutMs;
    let last: Runtime = { id, ip: null, state: "unknown" };
    while (Date.now() < deadline) {
      last = await this.describe(id);
      if (last.state === want && (!requireIp || last.ip)) return last;
      if (want !== "terminated" && (last.state === "terminated" || last.state === "shutting-down"))
        throw new RunoError(`Instance ${id} terminated unexpectedly (state: ${last.state})`);
      await sleep(5000);
    }
    throw new RunoError(
      `Timed out waiting for instance ${id} to reach "${want}" (last state: ${last.state})`,
    );
  }

  async status(rt: Runtime): Promise<Runtime> {
    return await this.describe(rt.id);
  }

  async suspend(rt: Runtime): Promise<Runtime> {
    const fresh = await this.describe(rt.id);
    if (fresh.lifecycle === "spot") {
      // spot cannot hibernate; plain stop (the persistent spot request stays open)
      await this.ec2.send(new StopInstancesCommand({ InstanceIds: [rt.id] }));
      return await this.waitForState(rt.id, "stopped", 10 * 60_000);
    }
    try {
      await this.ec2.send(new StopInstancesCommand({ InstanceIds: [rt.id], Hibernate: true }));
      log.dim("hibernating (RAM → EBS): the next resume comes back with services hot");
    } catch (e: any) {
      log.warn(`hibernation unavailable (${errCode(e) || e?.message}) — plain stop`);
      await this.ec2.send(new StopInstancesCommand({ InstanceIds: [rt.id] }));
    }
    return await this.waitForState(rt.id, "stopped", 10 * 60_000);
  }

  async resume(rt: Runtime): Promise<Runtime> {
    try {
      await this.ec2.send(new StartInstancesCommand({ InstanceIds: [rt.id] }));
    } catch (e: any) {
      if (errCode(e) === "InsufficientInstanceCapacity")
        throw new RunoError(
          "No spot capacity available right now to restart the instance",
          "Try again in a few minutes, or `runo destroy` + recreate without `limits.spot` (on-demand)",
        );
      throw e;
    }
    return await this.waitForState(rt.id, "running", 5 * 60_000, true);
  }

  async destroy(rt: Runtime): Promise<void> {
    // persistent spot: cancel the request BEFORE terminating, otherwise AWS
    // launches a replacement instance (respawn = leaking cost)
    try {
      const fresh = await this.describe(rt.id);
      if (fresh.spotRequestId) {
        await this.ec2.send(
          new CancelSpotInstanceRequestsCommand({ SpotInstanceRequestIds: [fresh.spotRequestId] }),
        );
        log.dim(`spot request ${fresh.spotRequestId} cancelled`);
      }
    } catch {}
    try {
      await this.ec2.send(new TerminateInstancesCommand({ InstanceIds: [rt.id] }));
    } catch (e: any) {
      if (errCode(e) === "InvalidInstanceID.NotFound") return;
      throw e;
    }
    await this.waitForState(rt.id, "terminated", 8 * 60_000);
  }

  // ---------- warm pool ----------

  private async listPool(): Promise<Runtime[]> {
    const res = await this.ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:runo:role", Values: ["pool"] },
          { Name: "tag:runo:home-hash", Values: [HASH6] },
          { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
        ],
      }),
    );
    const out: Runtime[] = [];
    for (const r of res.Reservations ?? [])
      for (const i of r.Instances ?? []) out.push(this.mapInstance(i, i.InstanceId!));
    return out;
  }

  async poolStatus(): Promise<Runtime[]> {
    return await this.listPool();
  }

  /** Claims a stopped pool instance: retag + adjust type/disk + start. */
  private async claimFromPool(spec: CreateSpec): Promise<Runtime | null> {
    const idle = (await this.listPool()).filter((p) => p.state === "stopped");
    const inst = idle[0];
    if (!inst) return null;
    log.step(`claiming warm pool instance (${inst.id}) — start ≫ create`);
    await this.ec2.send(new CreateTagsCommand({ Resources: [inst.id], Tags: this.envTags(spec) }));
    await this.ec2.send(
      new DeleteTagsCommand({ Resources: [inst.id], Tags: [{ Key: "runo:role" }] }),
    );
    if (inst.instanceType !== spec.instanceType) {
      log.dim(`adjusting type ${inst.instanceType} → ${spec.instanceType} (instance stopped)`);
      await this.ec2.send(
        new ModifyInstanceAttributeCommand({
          InstanceId: inst.id,
          InstanceType: { Value: spec.instanceType },
        }),
      );
    }
    const vols = await this.ec2.send(
      new DescribeVolumesCommand({
        Filters: [{ Name: "attachment.instance-id", Values: [inst.id] }],
      }),
    );
    const root = vols.Volumes?.[0];
    if (root?.VolumeId && (root.Size ?? 0) < spec.diskGb) {
      log.dim(`growing disk ${root.Size}GB → ${spec.diskGb}GB (cloud-init expands the fs on boot)`);
      await this.ec2.send(new ModifyVolumeCommand({ VolumeId: root.VolumeId, Size: spec.diskGb }));
    }
    await this.ec2.send(new StartInstancesCommand({ InstanceIds: [inst.id] }));
    return await this.waitForState(inst.id, "running", 5 * 60_000, true);
  }

  async poolScale(target: number): Promise<void> {
    if (target < 0 || target > 3 || !Number.isInteger(target))
      throw new RunoError("runo pool accepts a size from 0 to 3");
    await this.ensureKeyPair();
    const sgId = await this.ensureSecurityGroup();
    const poolTags: Tag[] = [
      { Key: "Name", Value: `runo-${HASH6}-pool` },
      { Key: "runo:managed", Value: "true" },
      { Key: "runo:home-hash", Value: HASH6 },
      { Key: "runo:role", Value: "pool" },
    ];

    let pool = await this.listPool();
    // shrink: terminate excess stopped instances
    const excess = pool.filter((p) => p.state === "stopped").slice(0, Math.max(0, pool.length - target));
    for (const p of excess) {
      log.step(`removing ${p.id} from the pool…`);
      await this.ec2.send(new TerminateInstancesCommand({ InstanceIds: [p.id] }));
    }
    // grow: provision and stop
    while ((pool = await this.listPool()).length < target) {
      await this.guardrail();
      log.step(`provisioning pool instance ${pool.length + 1}/${target}…`);
      const id = await this.launchInstance({
        instanceType: "t3.medium",
        diskGb: 30,
        tags: poolTags,
        sgId,
      });
      const rt = await this.waitForState(id, "running", 5 * 60_000, true);
      await this.waitReady(rt, { firstBoot: true });
      // auto-suspend disabled while in the pool (claim writes the recipe value)
      await this.exec(rt, "sudo mkdir -p /etc/runo && echo 0 | sudo tee /etc/runo/idle-limit >/dev/null");
      await this.ec2.send(new StopInstancesCommand({ InstanceIds: [id] }));
      await this.waitForState(id, "stopped", 10 * 60_000);
      log.ok(`${id} ready and stopped in the pool (cost: EBS only)`);
    }
  }

  // ---------- exec / files ----------

  private wrap(command: string, cwd?: string): string {
    const inner = cwd ? `cd ${shq(cwd)} && { ${command} ; }` : command;
    return `bash -lc ${shq(inner)}`;
  }

  async exec(rt: Runtime, command: string, opts: ExecOpts = {}): Promise<ExecResult> {
    return await sshExec(this.target(rt), this.wrap(command, opts.cwd), {
      stream: opts.stream,
      timeoutMs: opts.timeoutMs,
    });
  }

  async execInteractive(rt: Runtime, command: string, opts: { cwd?: string } = {}): Promise<number> {
    return await sshInteractive(this.target(rt), this.wrap(command, opts.cwd));
  }

  async execStream(
    rt: Runtime,
    command: string,
    opts: ExecOpts,
    sink: (chunk: { t: "out" | "err"; d: string }) => void,
  ): Promise<number> {
    const t = this.target(rt);
    const proc = Bun.spawn(
      ["ssh", ...sshBaseArgs(t), `${t.user}@${t.ip}`, this.wrap(command, opts.cwd)],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    let timer: Timer | undefined;
    if (opts.timeoutMs) timer = setTimeout(() => proc.kill(), opts.timeoutMs);
    const pump = async (stream: ReadableStream, type: "out" | "err") => {
      const reader = stream.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sink({ t: type, d: dec.decode(value) });
      }
    };
    await Promise.all([
      pump(proc.stdout as ReadableStream, "out"),
      pump(proc.stderr as ReadableStream, "err"),
    ]);
    const code = await proc.exited;
    if (timer) clearTimeout(timer);
    return code;
  }

  /** Raw-byte streaming exec (control plane downloads: remote tar → HTTP body). */
  async execStreamRaw(
    rt: Runtime,
    command: string,
    sink: (chunk: Uint8Array) => void,
  ): Promise<number> {
    const t = this.target(rt);
    const proc = Bun.spawn(
      ["ssh", ...sshBaseArgs(t), `${t.user}@${t.ip}`, this.wrap(command)],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const reader = (proc.stdout as ReadableStream).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sink(value);
    }
    return await proc.exited;
  }

  /** Used by the control plane's interactive tunnel (ssh -tt with piped stdio). */
  spawnTty(rt: Runtime, command: string): ReturnType<typeof Bun.spawn> {
    const t = this.target(rt);
    return Bun.spawn(
      ["ssh", "-tt", ...sshBaseArgs(t), `${t.user}@${t.ip}`, command],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
  }

  async upload(rt: Runtime, localPath: string, remotePath: string): Promise<void> {
    const dir = path.posix.dirname(remotePath);
    if (dir && dir !== "." && dir !== "/") await this.exec(rt, `mkdir -p ${shq(dir)}`);
    const res = await scpUpload(this.target(rt), localPath, remotePath);
    if (res.exitCode !== 0)
      throw new RunoError(`Upload of ${localPath} failed: ${res.stderr.trim()}`);
  }

  async uploadDir(
    rt: Runtime,
    localPath: string,
    remotePath: string,
    excludes: string[] = [],
  ): Promise<void> {
    const res = await rsyncPush(this.target(rt), localPath, remotePath, excludes);
    if (res.exitCode !== 0)
      throw new RunoError(`Push of ${localPath} failed: ${res.stderr.trim()}`);
  }

  async download(
    rt: Runtime,
    remotePath: string,
    localPath: string,
    excludes: string[] = [],
  ): Promise<void> {
    const res = await rsyncPull(this.target(rt), remotePath, localPath, excludes);
    if (res.exitCode !== 0)
      throw new RunoError(`Download of ${remotePath} failed: ${res.stderr.trim()}`);
  }

  serviceUrls(rt: Runtime, ports: number[]): string[] {
    if (!rt.ip) return [];
    return ports.map((p) => `http://${rt.ip}:${p}`);
  }

  async logs(rt: Runtime, command: string, opts: { cwd?: string } = {}): Promise<number> {
    return await this.execInteractive(rt, command, opts);
  }

  async tunnel(rt: Runtime, ports: number[]): Promise<number> {
    const t = this.target(rt);
    const forwards = ports.flatMap((p) => ["-L", `${p}:localhost:${p}`]);
    const proc = Bun.spawn(
      ["ssh", "-N", ...forwards, ...sshBaseArgs(t), `${t.user}@${t.ip}`],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    return await proc.exited;
  }

  // ---------- readiness ----------

  async waitReady(rt: Runtime, opts: { firstBoot?: boolean } = {}): Promise<void> {
    const sshDeadline = Date.now() + 5 * 60_000;
    let up = false;
    while (Date.now() < sshDeadline) {
      const r = await sshExec(this.target(rt), "true", { timeoutMs: 15_000 });
      if (r.exitCode === 0) {
        up = true;
        break;
      }
      await sleep(5000);
    }
    if (!up)
      throw new RunoError(
        `SSH did not respond at ${rt.ip} after 5min`,
        "Check the security group (port 22) and the instance state with `runo ls`",
      );
    if (opts.firstBoot)
      log.step("waiting for provisioning (cloud-init) — first boot takes a few minutes…");
    const ci = await this.exec(rt, "cloud-init status --wait || true; cloud-init status", {
      timeoutMs: 20 * 60_000,
    });
    const out = ci.stdout + ci.stderr;
    if (!/status:\s*(done|degraded)/.test(out)) {
      const tail = await this.exec(rt, "tail -n 40 /var/log/cloud-init-output.log");
      throw new RunoError(
        `cloud-init did not finish successfully (${out.trim().split("\n").pop()})`,
        `Last lines of the provisioning log:\n${tail.stdout}`,
      );
    }
    if (/status:\s*degraded/.test(out))
      log.warn("cloud-init finished 'degraded' — validating essential tooling anyway");
    // drop the mux master opened during boot: group changes from provisioning
    // (docker) only take effect on a fresh connection
    await sshCloseMaster(this.target(rt));
  }

  // ---------- base image (runo bake) ----------

  async prepareBootImage(warm?: {
    repo: string;
    instanceType: string;
    diskGb: number;
    prepare: (rt: Runtime) => Promise<void>;
  }): Promise<string> {
    await this.guardrail();
    await this.ensureKeyPair();
    const sgId = await this.ensureSecurityGroup();
    const { amiId, rootDevice } = await this.canonicalAmi();
    // a warm bake compiles the repo's images, so it needs the machine the repo
    // asks for, not the small default
    const bakeType = warm?.instanceType ?? "t3.medium";
    const bakeDisk = warm?.diskGb ?? 30;
    const cloudInitPath = new URL("../../image/cloud-init.yaml", import.meta.url).pathname;
    const userData = Buffer.from(readFileSync(cloudInitPath, "utf8")).toString("base64");
    const baseTags = [
      { Key: "Name", Value: `runo-base-${HASH6}` },
      { Key: "runo:managed", Value: "true" },
      { Key: "runo:home-hash", Value: HASH6 },
      { Key: "runo:role", Value: "bake" },
      // what makes the image findable from another machine (see sharedBakedImage)
      { Key: "runo:base-image", Value: warm?.repo ?? "generic" },
    ];

    log.step("launching a temporary VM to bake the base image (full cloud-init)…");
    const res = await this.ec2.send(
      new RunInstancesCommand({
        ImageId: amiId,
        InstanceType: bakeType as any,
        KeyName: this.keyName,
        MinCount: 1,
        MaxCount: 1,
        UserData: userData,
        NetworkInterfaces: [{ DeviceIndex: 0, AssociatePublicIpAddress: true, Groups: [sgId] }],
        BlockDeviceMappings: [
          {
            DeviceName: rootDevice,
            Ebs: { VolumeSize: bakeDisk, VolumeType: "gp3", Iops: 4000, Throughput: 300, DeleteOnTermination: true },
          },
        ],
        InstanceInitiatedShutdownBehavior: "stop",
        CreditSpecification: { CpuCredits: "unlimited" },
        TagSpecifications: [
          { ResourceType: "instance", Tags: baseTags },
          { ResourceType: "volume", Tags: baseTags },
        ],
      }),
    );
    const id = res.Instances![0]!.InstanceId!;
    try {
      const rt = await this.waitForState(id, "running", 5 * 60_000, true);
      await this.waitReady(rt, { firstBoot: true });
      const check = await this.exec(
        rt,
        "docker --version && docker compose version && node --version && bun --version && pnpm --version && claude --version && codex --version && tmux -V",
        { timeoutMs: 60_000 },
      );
      if (check.exitCode !== 0)
        throw new RunoError(
          "Incomplete tooling on the bake VM — image was NOT created",
          check.stderr.trim().split("\n").pop(),
        );
      // The expensive, repo-specific half: upload the code and run the
      // recipe's setup so the image already carries the built images and
      // installed dependencies. Every environment created from it skips that
      // work — which is most of a cold boot.
      if (warm) {
        log.step("warming the image with the repo's setup (this is the slow part, once)…");
        await warm.prepare(rt);
      }
      // clean cloud-init state: the image's next boot re-runs only the
      // essentials (ssh keys/hostname) in seconds
      await this.exec(rt, "sudo cloud-init clean --logs");
      log.step("stopping the VM and creating the image (CreateImage)…");
      await this.ec2.send(new StopInstancesCommand({ InstanceIds: [id] }));
      await this.waitForState(id, "stopped", 10 * 60_000);
      const img = await this.ec2.send(
        new CreateImageCommand({
          InstanceId: id,
          Name: `runo-base-${HASH6}-${Date.now()}`,
          Description: warm
            ? `runo baked image for ${warm.repo} (tooling + the repo's setup already applied)`
            : "runo baked base image (docker, node22, bun, pnpm, claude, codex)",
          TagSpecifications: [
            { ResourceType: "image", Tags: baseTags },
            { ResourceType: "snapshot", Tags: baseTags },
          ],
        }),
      );
      const imageId = img.ImageId!;
      const deadline = Date.now() + 20 * 60_000;
      for (;;) {
        const d = await this.ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] }));
        const state = d.Images?.[0]?.State;
        if (state === "available") break;
        if (state === "failed") throw new RunoError(`CreateImage failed (${imageId})`);
        if (Date.now() > deadline)
          throw new RunoError(`Timed out waiting for image ${imageId} to become available`);
        await sleep(10_000);
      }
      const old = this.loadBakedImage();
      mkdirSync(RUNO_HOME, { recursive: true });
      writeFileSync(
        this.bakedImagePath,
        JSON.stringify({ imageId, region: AWS_REGION, createdAt: new Date().toISOString() }, null, 2) + "\n",
      );
      if (old && old.imageId !== imageId) await this.deregisterImage(old.imageId);
      return imageId;
    } finally {
      try {
        await this.ec2.send(new TerminateInstancesCommand({ InstanceIds: [id] }));
      } catch {}
    }
  }

  private async deregisterImage(imageId: string): Promise<void> {
    let snapshots: string[] = [];
    try {
      const d = await this.ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] }));
      snapshots = (d.Images?.[0]?.BlockDeviceMappings ?? [])
        .map((b) => b.Ebs?.SnapshotId)
        .filter((s): s is string => Boolean(s));
      await this.ec2.send(new DeregisterImageCommand({ ImageId: imageId }));
    } catch {}
    for (const snap of snapshots) {
      try {
        await this.ec2.send(new DeleteSnapshotCommand({ SnapshotId: snap }));
      } catch {}
    }
  }

  async removeBootImage(): Promise<void> {
    const baked = this.loadBakedImage();
    if (!baked) {
      log.warn("no baked image to remove (runo bake was never run)");
      return;
    }
    await this.deregisterImage(baked.imageId);
    rmSync(this.bakedImagePath, { force: true });
    log.ok(`image ${baked.imageId} and snapshot removed`);
  }

  // ---------- inventory / cleanup ----------

  /**
   * The env's instance found by its tags, for a caller that has no registry —
   * a CI runner is a fresh machine on every job, and creating a second VM for
   * a branch that already has one is both wrong and expensive.
   */
  async findByTags(repo: string, branch: string): Promise<Runtime | null> {
    const res = await this.ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:runo:managed", Values: ["true"] },
          { Name: "tag:runo:home-hash", Values: [HASH6] },
          { Name: "tag:runo:repo", Values: [repo] },
          { Name: "tag:runo:branch", Values: [branch] },
          { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
        ],
      }),
    );
    const found = (res.Reservations ?? [])
      .flatMap((r) => r.Instances ?? [])
      .sort((a, b) => (b.LaunchTime?.getTime() ?? 0) - (a.LaunchTime?.getTime() ?? 0))[0];
    return found ? this.mapInstance(found, found.InstanceId!) : null;
  }

  async listManaged(): Promise<Runtime[]> {
    // Scoped by runo:home-hash: parallel runo installs in the same account
    // (distinct RUNO_HOMEs) must not count/destroy each other's instances.
    const res = await this.ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:runo:managed", Values: ["true"] },
          { Name: "tag:runo:home-hash", Values: [HASH6] },
          { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
        ],
      }),
    );
    const out: Runtime[] = [];
    for (const r of res.Reservations ?? [])
      for (const i of r.Instances ?? []) out.push(this.mapInstance(i, i.InstanceId!));
    return out;
  }

  async cleanupShared(): Promise<void> {
    try {
      await this.ec2.send(new DeleteKeyPairCommand({ KeyName: this.keyName }));
      log.dim(`keypair ${this.keyName} removed from AWS`);
    } catch {}
    const found = await this.ec2.send(
      new DescribeSecurityGroupsCommand({
        Filters: [{ Name: "group-name", Values: [this.sgName] }],
      }),
    );
    const sgId = found.SecurityGroups?.[0]?.GroupId;
    if (!sgId) return;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        await this.ec2.send(new DeleteSecurityGroupCommand({ GroupId: sgId }));
        log.dim(`security group ${this.sgName} removed`);
        return;
      } catch (e: any) {
        if (errCode(e) === "DependencyViolation") {
          await sleep(10_000); // instances still terminating
          continue;
        }
        throw e;
      }
    }
    log.warn(
      `security group ${this.sgName} still has dependencies — remove it later with: aws ec2 delete-security-group --group-id ${sgId}`,
    );
  }
}

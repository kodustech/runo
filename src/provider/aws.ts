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
import { log } from "../log";
import { rsyncPull, rsyncPush, scpUpload, shq, sshExec, sshInteractive, type SshTarget } from "../ssh";
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

  private target(rt: Runtime): SshTarget {
    if (!rt.ip)
      throw new RunoError(
        `Ambiente ${rt.name ?? rt.id} não tem IP público (estado: ${rt.state})`,
        "Se estiver parado, rode `runo resume`",
      );
    return { ip: rt.ip, user: REMOTE_USER, keyPath: this.keyPath };
  }

  async preflight(): Promise<void> {
    try {
      await this.sts.send(new GetCallerIdentityCommand({}));
    } catch (e: any) {
      throw new RunoError(
        `Credenciais AWS inválidas ou ausentes (${errCode(e) || e?.message})`,
        "Configure as credenciais (AWS_PROFILE / aws configure) e confirme com `aws sts get-caller-identity`. Região em uso: " +
          AWS_REGION,
      );
    }
  }

  // ---------- recursos compartilhados ----------

  private async ensureKeyPair(): Promise<void> {
    mkdirSync(SSH_DIR, { recursive: true });
    const pubPath = `${this.keyPath}.pub`;
    if (!existsSync(this.keyPath)) {
      const gen = Bun.spawnSync(
        ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", this.keyName, "-f", this.keyPath],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (gen.exitCode !== 0)
        throw new RunoError(`Falha ao gerar chave SSH: ${gen.stderr.toString()}`);
      // chave local nova → qualquer keypair antigo na AWS com esse nome é lixo
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
          `Nenhuma VPC default na região ${AWS_REGION}`,
          "Crie uma VPC default (`aws ec2 create-default-vpc`) ou use outra região via RUNO_AWS_REGION",
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
    const param = await this.ssm.send(new GetParameterCommand({ Name: AMI_SSM_PARAM }));
    const amiId = param.Parameter?.Value;
    if (!amiId)
      throw new RunoError(`Não resolvi a AMI Ubuntu 24.04 via SSM em ${AWS_REGION}`);
    const img = await this.ec2.send(new DescribeImagesCommand({ ImageIds: [amiId] }));
    return { amiId, rootDevice: img.Images?.[0]?.RootDeviceName ?? "/dev/sda1" };
  }

  /** AMI assada pelo runo bake quando disponível; senão a Ubuntu canônica. */
  private async resolveAmi(): Promise<{ amiId: string; rootDevice: string; baked: boolean }> {
    const baked = this.loadBakedImage();
    if (baked) {
      try {
        const img = await this.ec2.send(new DescribeImagesCommand({ ImageIds: [baked.imageId] }));
        const image = img.Images?.[0];
        if (image?.State === "available")
          return { amiId: baked.imageId, rootDevice: image.RootDeviceName ?? "/dev/sda1", baked: true };
      } catch {}
      log.warn(`imagem assada ${baked.imageId} não está mais disponível — usando a AMI canônica (rode runo bake de novo)`);
      rmSync(this.bakedImagePath, { force: true });
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

  /** Guardrail de custo: conta só instâncias LIGADAS (paradas custam só EBS). */
  private async guardrail(): Promise<void> {
    const active = (await this.listManaged()).filter(
      (m) => m.state === "running" || m.state === "pending",
    );
    if (active.length >= MAX_INSTANCES)
      throw new RunoError(
        `Guardrail de custo: ${active.length} instâncias runo ligadas (máx ${MAX_INSTANCES}): ${active
          .map((m) => m.name ?? m.id)
          .join(", ")}`,
        "Suspenda/destrua ambientes (`runo ls`, `runo suspend`, `runo destroy`)",
      );
  }

  /**
   * RunInstances com hibernação habilitada (root criptografado); se a conta/
   * tipo/AMI não suportarem, relança sem hibernação (fallback gracioso).
   */
  private async launchInstance(opts: {
    instanceType: string;
    diskGb: number;
    tags: Tag[];
    sgId: string;
    spot?: boolean;
  }): Promise<string> {
    const { amiId, rootDevice, baked } = await this.resolveAmi();
    if (baked) log.dim(`usando imagem assada ${amiId} (runo bake) — boot rápido, sem cloud-init pesado`);
    const cloudInitPath = new URL("../../image/cloud-init.yaml", import.meta.url).pathname;
    const userData = baked
      ? undefined
      : Buffer.from(readFileSync(cloudInitPath, "utf8")).toString("base64");

    // spot: sem hibernação e sem InstanceInitiatedShutdownBehavior (a API rejeita);
    // interrupção/shutdown de spot persistente já resulta em "stopped"
    const input = (mode: "spot" | "hibernation" | "plain") => ({
      ImageId: amiId,
      InstanceType: opts.instanceType as any,
      KeyName: this.keyName,
      MinCount: 1,
      MaxCount: 1,
      ...(userData ? { UserData: userData } : {}),
      NetworkInterfaces: [{ DeviceIndex: 0, AssociatePublicIpAddress: true, Groups: [opts.sgId] }],
      BlockDeviceMappings: [
        {
          DeviceName: rootDevice,
          Ebs: {
            VolumeSize: opts.diskGb,
            VolumeType: "gp3" as const,
            DeleteOnTermination: true,
            // hibernação exige root criptografado (chave default aws/ebs)
            ...(mode === "hibernation" ? { Encrypted: true } : {}),
          },
        },
      ],
      ...(mode === "spot"
        ? {
            InstanceMarketOptions: {
              MarketType: "spot" as const,
              SpotOptions: {
                SpotInstanceType: "persistent" as const,
                // interrupção = stop: EBS sobrevive, runo resume religa depois
                InstanceInterruptionBehavior: "stop" as const,
              },
            },
          }
        : {
            // shutdown de dentro da VM (auto-suspend) = "stopped", não terminada
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
          "AWS recusou a instância: quota de vCPU on-demand excedida (VcpuLimitExceeded)",
          "Destrua envs que não usa (`runo ls` / `runo destroy`) ou peça aumento de quota em Service Quotas → Running On-Demand Standard instances",
        );
      if (code === "UnauthorizedOperation")
        throw new RunoError(
          "AWS recusou RunInstances: sem permissão (UnauthorizedOperation)",
          "O usuário IAM precisa de permissões EC2 (RunInstances, Describe*, CreateSecurityGroup, ImportKeyPair...)",
        );
    };

    if (opts.spot) {
      try {
        const res = await this.ec2.send(new RunInstancesCommand(input("spot")));
        log.dim("instância SPOT (persistente, interrupção=stop) — ~70% mais barato que on-demand");
        return res.Instances![0]!.InstanceId!;
      } catch (e: any) {
        explainOrThrow(e);
        log.warn(`spot indisponível agora (${errCode(e)}) — caindo para on-demand`);
      }
    }
    try {
      const res = await this.ec2.send(new RunInstancesCommand(input("hibernation")));
      return res.Instances![0]!.InstanceId!;
    } catch (e: any) {
      explainOrThrow(e);
      log.warn(`launch com hibernação falhou (${errCode(e)}) — criando sem hibernação`);
      const res = await this.ec2.send(new RunInstancesCommand(input("plain")));
      return res.Instances![0]!.InstanceId!;
    }
  }

  async create(spec: CreateSpec): Promise<Runtime> {
    await this.guardrail();
    await this.ensureKeyPair();
    const sgId = await this.ensureSecurityGroup();

    // warm pool primeiro: start de instância parada é bem mais rápido que criar.
    // Env spot NÃO usa o pool (as instâncias do pool são on-demand — não dá
    // para converter; o launch spot direto já é rápido e é o mais barato).
    if (!spec.spot) {
      try {
        const claimed = await this.claimFromPool(spec);
        if (claimed) return claimed;
      } catch (e: any) {
        log.warn(`claim do warm pool falhou (${e?.message ?? e}) — criando do zero`);
      }
    }

    const id = await this.launchInstance({
      instanceType: spec.instanceType,
      diskGb: spec.diskGb,
      tags: this.envTags(spec),
      sgId,
      spot: spec.spot,
    });
    log.dim(`instância ${id} criada (${spec.instanceType}, ${spec.diskGb}GB gp3, ${AWS_REGION})`);
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
        throw new RunoError(`Instância ${id} terminou inesperadamente (estado: ${last.state})`);
      await sleep(5000);
    }
    throw new RunoError(
      `Timeout esperando instância ${id} chegar a "${want}" (último estado: ${last.state})`,
    );
  }

  async status(rt: Runtime): Promise<Runtime> {
    return await this.describe(rt.id);
  }

  async suspend(rt: Runtime): Promise<Runtime> {
    const fresh = await this.describe(rt.id);
    if (fresh.lifecycle === "spot") {
      // spot não hiberna; stop normal (a spot request persistente fica aberta)
      await this.ec2.send(new StopInstancesCommand({ InstanceIds: [rt.id] }));
      return await this.waitForState(rt.id, "stopped", 10 * 60_000);
    }
    try {
      await this.ec2.send(new StopInstancesCommand({ InstanceIds: [rt.id], Hibernate: true }));
      log.dim("hibernando (RAM → EBS): o próximo resume volta com os serviços quentes");
    } catch (e: any) {
      log.warn(`hibernação indisponível (${errCode(e) || e?.message}) — stop normal`);
      await this.ec2.send(new StopInstancesCommand({ InstanceIds: [rt.id] }));
    }
    return await this.waitForState(rt.id, "stopped", 10 * 60_000);
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

  /** Reivindica uma instância parada do pool: retag + ajusta tipo/disco + start. */
  private async claimFromPool(spec: CreateSpec): Promise<Runtime | null> {
    const idle = (await this.listPool()).filter((p) => p.state === "stopped");
    const inst = idle[0];
    if (!inst) return null;
    log.step(`reivindicando instância do warm pool (${inst.id}) — start ≫ create`);
    await this.ec2.send(new CreateTagsCommand({ Resources: [inst.id], Tags: this.envTags(spec) }));
    await this.ec2.send(
      new DeleteTagsCommand({ Resources: [inst.id], Tags: [{ Key: "runo:role" }] }),
    );
    if (inst.instanceType !== spec.instanceType) {
      log.dim(`ajustando tipo ${inst.instanceType} → ${spec.instanceType} (instância parada)`);
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
      log.dim(`crescendo disco ${root.Size}GB → ${spec.diskGb}GB (cloud-init expande o fs no boot)`);
      await this.ec2.send(new ModifyVolumeCommand({ VolumeId: root.VolumeId, Size: spec.diskGb }));
    }
    await this.ec2.send(new StartInstancesCommand({ InstanceIds: [inst.id] }));
    return await this.waitForState(inst.id, "running", 5 * 60_000, true);
  }

  async poolScale(target: number): Promise<void> {
    if (target < 0 || target > 3 || !Number.isInteger(target))
      throw new RunoError("runo pool aceita tamanho de 0 a 3");
    await this.ensureKeyPair();
    const sgId = await this.ensureSecurityGroup();
    const poolTags: Tag[] = [
      { Key: "Name", Value: `runo-${HASH6}-pool` },
      { Key: "runo:managed", Value: "true" },
      { Key: "runo:home-hash", Value: HASH6 },
      { Key: "runo:role", Value: "pool" },
    ];

    let pool = await this.listPool();
    // encolher: termina paradas excedentes
    const excess = pool.filter((p) => p.state === "stopped").slice(0, Math.max(0, pool.length - target));
    for (const p of excess) {
      log.step(`removendo ${p.id} do pool…`);
      await this.ec2.send(new TerminateInstancesCommand({ InstanceIds: [p.id] }));
    }
    // crescer: provisiona e para
    while ((pool = await this.listPool()).length < target) {
      await this.guardrail();
      log.step(`provisionando instância ${pool.length + 1}/${target} do pool…`);
      const id = await this.launchInstance({
        instanceType: "t3.medium",
        diskGb: 30,
        tags: poolTags,
        sgId,
      });
      const rt = await this.waitForState(id, "running", 5 * 60_000, true);
      await this.waitReady(rt, { firstBoot: true });
      // auto-suspend desligado enquanto está no pool (o claim escreve o valor da recipe)
      await this.exec(rt, "sudo mkdir -p /etc/runo && echo 0 | sudo tee /etc/runo/idle-limit >/dev/null");
      await this.ec2.send(new StopInstancesCommand({ InstanceIds: [id] }));
      await this.waitForState(id, "stopped", 10 * 60_000);
      log.ok(`${id} pronta e parada no pool (custo: só EBS)`);
    }
  }

  async resume(rt: Runtime): Promise<Runtime> {
    try {
      await this.ec2.send(new StartInstancesCommand({ InstanceIds: [rt.id] }));
    } catch (e: any) {
      if (errCode(e) === "InsufficientInstanceCapacity")
        throw new RunoError(
          "Sem capacidade spot disponível agora para religar a instância",
          "Tente de novo em alguns minutos, ou `runo destroy` + recrie sem `limits.spot` (on-demand)",
        );
      throw e;
    }
    return await this.waitForState(rt.id, "running", 5 * 60_000, true);
  }

  async destroy(rt: Runtime): Promise<void> {
    // spot persistente: cancelar a request ANTES de terminar, senão a AWS
    // relança outra instância no lugar (respawn = custo vazando)
    try {
      const fresh = await this.describe(rt.id);
      if (fresh.spotRequestId) {
        await this.ec2.send(
          new CancelSpotInstanceRequestsCommand({ SpotInstanceRequestIds: [fresh.spotRequestId] }),
        );
        log.dim(`spot request ${fresh.spotRequestId} cancelada`);
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

  // ---------- exec / arquivos ----------

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

  async upload(rt: Runtime, localPath: string, remotePath: string): Promise<void> {
    const dir = path.posix.dirname(remotePath);
    if (dir && dir !== "." && dir !== "/") await this.exec(rt, `mkdir -p ${shq(dir)}`);
    const res = await scpUpload(this.target(rt), localPath, remotePath);
    if (res.exitCode !== 0)
      throw new RunoError(`Upload de ${localPath} falhou: ${res.stderr.trim()}`);
  }

  async uploadDir(
    rt: Runtime,
    localPath: string,
    remotePath: string,
    excludes: string[] = [],
  ): Promise<void> {
    const res = await rsyncPush(this.target(rt), localPath, remotePath, excludes);
    if (res.exitCode !== 0)
      throw new RunoError(`Push de ${localPath} falhou: ${res.stderr.trim()}`);
  }

  async download(
    rt: Runtime,
    remotePath: string,
    localPath: string,
    excludes: string[] = [],
  ): Promise<void> {
    const res = await rsyncPull(this.target(rt), remotePath, localPath, excludes);
    if (res.exitCode !== 0)
      throw new RunoError(`Download de ${remotePath} falhou: ${res.stderr.trim()}`);
  }

  serviceUrls(rt: Runtime, ports: number[]): string[] {
    if (!rt.ip) return [];
    return ports.map((p) => `http://${rt.ip}:${p}`);
  }

  async logs(rt: Runtime, command: string, opts: { cwd?: string } = {}): Promise<number> {
    return await this.execInteractive(rt, command, opts);
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
        `SSH não respondeu em ${rt.ip} após 5min`,
        "Confira o security group (porta 22) e o estado da instância com `runo ls`",
      );
    if (opts.firstBoot)
      log.step("aguardando provisionamento (cloud-init) — primeiro boot leva alguns minutos…");
    const ci = await this.exec(rt, "cloud-init status --wait || true; cloud-init status", {
      timeoutMs: 20 * 60_000,
    });
    const out = ci.stdout + ci.stderr;
    if (!/status:\s*(done|degraded)/.test(out)) {
      const tail = await this.exec(rt, "tail -n 40 /var/log/cloud-init-output.log");
      throw new RunoError(
        `cloud-init não terminou com sucesso (${out.trim().split("\n").pop()})`,
        `Últimas linhas do log de provisionamento:\n${tail.stdout}`,
      );
    }
    if (/status:\s*degraded/.test(out))
      log.warn("cloud-init terminou 'degraded' — validando o tooling essencial mesmo assim");
  }

  // ---------- imagem base (runo bake) ----------

  async prepareBootImage(): Promise<string> {
    await this.guardrail();
    await this.ensureKeyPair();
    const sgId = await this.ensureSecurityGroup();
    const { amiId, rootDevice } = await this.canonicalAmi();
    const cloudInitPath = new URL("../../image/cloud-init.yaml", import.meta.url).pathname;
    const userData = Buffer.from(readFileSync(cloudInitPath, "utf8")).toString("base64");
    const baseTags = [
      { Key: "Name", Value: `runo-base-${HASH6}` },
      { Key: "runo:managed", Value: "true" },
      { Key: "runo:home-hash", Value: HASH6 },
      { Key: "runo:role", Value: "bake" },
    ];

    log.step("subindo VM temporária para assar a imagem base (cloud-init completo)…");
    const res = await this.ec2.send(
      new RunInstancesCommand({
        ImageId: amiId,
        InstanceType: "t3.medium",
        KeyName: this.keyName,
        MinCount: 1,
        MaxCount: 1,
        UserData: userData,
        NetworkInterfaces: [{ DeviceIndex: 0, AssociatePublicIpAddress: true, Groups: [sgId] }],
        BlockDeviceMappings: [
          { DeviceName: rootDevice, Ebs: { VolumeSize: 30, VolumeType: "gp3", DeleteOnTermination: true } },
        ],
        InstanceInitiatedShutdownBehavior: "stop",
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
          "Tooling incompleto na VM de bake — imagem NÃO foi criada",
          check.stderr.trim().split("\n").pop(),
        );
      // estado do cloud-init limpo: o próximo boot da imagem re-executa só o
      // essencial (ssh keys/hostname) em segundos
      await this.exec(rt, "sudo cloud-init clean --logs");
      log.step("parando a VM e criando a imagem (CreateImage)…");
      await this.ec2.send(new StopInstancesCommand({ InstanceIds: [id] }));
      await this.waitForState(id, "stopped", 10 * 60_000);
      const img = await this.ec2.send(
        new CreateImageCommand({
          InstanceId: id,
          Name: `runo-base-${HASH6}-${Date.now()}`,
          Description: "runo baked base image (docker, node22, bun, pnpm, claude, codex)",
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
        if (state === "failed") throw new RunoError(`CreateImage falhou (${imageId})`);
        if (Date.now() > deadline)
          throw new RunoError(`Timeout esperando a imagem ${imageId} ficar disponível`);
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
      log.warn("nenhuma imagem assada para remover (runo bake não foi rodado)");
      return;
    }
    await this.deregisterImage(baked.imageId);
    rmSync(this.bakedImagePath, { force: true });
    log.ok(`imagem ${baked.imageId} e snapshot removidos`);
  }

  // ---------- inventário / limpeza ----------

  async listManaged(): Promise<Runtime[]> {
    // Escopado por runo:home-hash: instalações paralelas do runo na mesma conta
    // (RUNO_HOMEs distintos) não podem contar/destruir instâncias umas das outras.
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
      log.dim(`keypair ${this.keyName} removido da AWS`);
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
        log.dim(`security group ${this.sgName} removido`);
        return;
      } catch (e: any) {
        if (errCode(e) === "DependencyViolation") {
          await sleep(10_000); // instâncias ainda terminando
          continue;
        }
        throw e;
      }
    }
    log.warn(
      `security group ${this.sgName} ainda tem dependências — remova depois com: aws ec2 delete-security-group --group-id ${sgId}`,
    );
  }
}

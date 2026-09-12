/**
 * Runtime interface: nothing outside the provider may know the concrete cloud.
 * The engine speaks only these methods.
 */
export interface CreateSpec {
  envName: string;
  slug: string;
  instanceType: string;
  diskGb: number;
  repo: string;
  branch: string;
  /** Spot capacity (interruption = stop, data survives; on-demand fallback). */
  spot?: boolean;
}

export type RuntimeState =
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "shutting-down"
  | "terminated"
  | "unknown";

export interface Runtime {
  id: string;
  ip: string | null;
  state: RuntimeState;
  instanceType?: string;
  launchedAt?: string;
  name?: string;
  /** "spot" when the instance is spot (affects suspend/destroy). */
  lifecycle?: string;
  spotRequestId?: string;
  [extra: string]: unknown;
}

export interface ExecOpts {
  cwd?: string;
  stream?: boolean;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeProvider {
  readonly name: string;

  /** Validates credentials/access; actionable error otherwise. */
  preflight(): Promise<void>;

  /** Creates the env's VM (includes the simultaneous-instances guardrail). */
  create(spec: CreateSpec): Promise<Runtime>;

  /** Waits until the VM accepts exec and provisioning (cloud-init) finishes. */
  waitReady(rt: Runtime, opts?: { firstBoot?: boolean }): Promise<void>;

  status(rt: Runtime): Promise<Runtime>;
  suspend(rt: Runtime): Promise<Runtime>;
  resume(rt: Runtime): Promise<Runtime>;
  destroy(rt: Runtime): Promise<void>;

  /** Opens the env's public ports to the world (idempotent). */
  ensurePorts(ports: number[]): Promise<void>;

  exec(rt: Runtime, command: string, opts?: ExecOpts): Promise<ExecResult>;
  /** Inherited stdio (agent session, runo exec, logs -f). */
  execInteractive(rt: Runtime, command: string, opts?: { cwd?: string }): Promise<number>;
  /** Chunked exec used by the control plane to forward live output. */
  execStream?(
    rt: Runtime,
    command: string,
    opts: ExecOpts,
    sink: (chunk: { t: "out" | "err"; d: string }) => void,
  ): Promise<number>;

  upload(rt: Runtime, localPath: string, remotePath: string): Promise<void>;
  /** Local→VM directory sync (runo push). */
  uploadDir(rt: Runtime, localPath: string, remotePath: string, excludes?: string[]): Promise<void>;
  download(rt: Runtime, remotePath: string, localPath: string, excludes?: string[]): Promise<void>;

  serviceUrls(rt: Runtime, ports: number[]): string[];

  /** Streams a remote log command (tail -f, docker compose logs...). */
  logs(rt: Runtime, command: string, opts?: { cwd?: string }): Promise<number>;

  /**
   * Foreground local→VM port forwarding (runo tunnel): localhost:<port> maps
   * to the VM's <port> so browser/frontends behave exactly like local dev.
   */
  tunnel?(rt: Runtime, ports: number[]): Promise<number>;

  /** Tells the control plane which services/ports this env serves (ingress). */
  registerServices?(rt: Runtime, services: { name: string; port: number }[]): Promise<void>;

  /**
   * Bakes a base boot image with provisioning done (runo bake) —
   * subsequent ups boot in ~1-2min instead of running full cloud-init.
   */
  prepareBootImage(): Promise<string>;
  /** Removes the baked base image (runo bake --rm). */
  removeBootImage(): Promise<void>;

  /** Warm pool: provisioned, stopped instances ready to be claimed on create. */
  poolStatus(): Promise<Runtime[]>;
  poolScale(target: number): Promise<void>;

  /**
   * The env's instance located by its tags — lets a machine with no local
   * registry (a CI runner) find the env its branch already has.
   */
  findByTags?(repo: string, branch: string): Promise<Runtime | null>;

  /** All runo-managed instances still alive (guardrail + audit). */
  listManaged(): Promise<Runtime[]>;

  /** Removes shared resources (keypair, security group) — runo destroy --all. */
  cleanupShared(): Promise<void>;
}

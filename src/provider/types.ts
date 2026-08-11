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

  upload(rt: Runtime, localPath: string, remotePath: string): Promise<void>;
  /** Local→VM directory sync (runo push). */
  uploadDir(rt: Runtime, localPath: string, remotePath: string, excludes?: string[]): Promise<void>;
  download(rt: Runtime, remotePath: string, localPath: string, excludes?: string[]): Promise<void>;

  serviceUrls(rt: Runtime, ports: number[]): string[];

  /** Streams a remote log command (tail -f, docker compose logs...). */
  logs(rt: Runtime, command: string, opts?: { cwd?: string }): Promise<number>;

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

  /** All runo-managed instances still alive (guardrail + audit). */
  listManaged(): Promise<Runtime[]>;

  /** Removes shared resources (keypair, security group) — runo destroy --all. */
  cleanupShared(): Promise<void>;
}

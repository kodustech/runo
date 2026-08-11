/**
 * Interface do runtime (decisão 1): nada fora do provider pode conhecer o
 * provedor de nuvem concreto. O engine fala apenas estes métodos.
 */
export interface CreateSpec {
  envName: string;
  slug: string;
  instanceType: string;
  diskGb: number;
  repo: string;
  branch: string;
  /** Capacidade spot (interrupção = stop, dados sobrevivem; fallback on-demand). */
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
  /** "spot" quando a instância é spot (afeta suspend/destroy). */
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

  /** Valida credenciais/acesso; erro acionável se não der. */
  preflight(): Promise<void>;

  /** Cria a VM do env (inclui guardrail de instâncias simultâneas). */
  create(spec: CreateSpec): Promise<Runtime>;

  /** Espera a VM aceitar exec e o provisionamento (cloud-init) terminar. */
  waitReady(rt: Runtime, opts?: { firstBoot?: boolean }): Promise<void>;

  status(rt: Runtime): Promise<Runtime>;
  suspend(rt: Runtime): Promise<Runtime>;
  resume(rt: Runtime): Promise<Runtime>;
  destroy(rt: Runtime): Promise<void>;

  /** Abre as portas públicas do env para o mundo (idempotente). */
  ensurePorts(ports: number[]): Promise<void>;

  exec(rt: Runtime, command: string, opts?: ExecOpts): Promise<ExecResult>;
  /** stdio herdado (sessão de agente, runo exec, logs -f). */
  execInteractive(rt: Runtime, command: string, opts?: { cwd?: string }): Promise<number>;

  upload(rt: Runtime, localPath: string, remotePath: string): Promise<void>;
  /** Sync de diretório local→VM (runo push). */
  uploadDir(rt: Runtime, localPath: string, remotePath: string, excludes?: string[]): Promise<void>;
  download(rt: Runtime, remotePath: string, localPath: string, excludes?: string[]): Promise<void>;

  serviceUrls(rt: Runtime, ports: number[]): string[];

  /** Streama um comando de log remoto (tail -f, docker compose logs...). */
  logs(rt: Runtime, command: string, opts?: { cwd?: string }): Promise<number>;

  /**
   * Assa uma imagem base de boot com o provisionamento pronto (runo bake) —
   * ups seguintes bootam em ~1-2min em vez de rodar o cloud-init inteiro.
   */
  prepareBootImage(): Promise<string>;

  /** Warm pool: instâncias provisionadas e paradas, prontas para claim no create. */
  poolStatus(): Promise<Runtime[]>;
  poolScale(target: number): Promise<void>;
  /** Remove a imagem base assada (runo bake --rm). */
  removeBootImage(): Promise<void>;

  /** Todas as instâncias gerenciadas pelo runo ainda vivas (guardrail + auditoria). */
  listManaged(): Promise<Runtime[]>;

  /** Remove recursos compartilhados (keypair, security group) — runo destroy --all. */
  cleanupShared(): Promise<void>;
}

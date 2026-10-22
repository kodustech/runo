import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HASH6, REMOTE_USER, SSH_DIR } from "../config";
import { RunoError } from "../errors";
import { log } from "../log";
import { rsyncPull, rsyncPush, scpUpload, shq, sshBaseArgs, sshCloseMaster, sshExec, sshInteractive, type SshTarget } from "../ssh";
import type { ExecOpts, ExecResult, Runtime } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Everything a provider does once its VM has a public IP and runo's key:
 * exec, file transfer, tunnels and readiness all go over SSH, whatever cloud
 * created the machine. A provider only has to create, find and stop VMs.
 */
export abstract class SshVmProvider {
  protected get keyName(): string {
    return `runo-${HASH6}`;
  }
  protected get keyPath(): string {
    return path.join(SSH_DIR, this.keyName);
  }

  /**
   * Writes RUNO_SSH_KEY to disk if it is not there yet. Every ssh operation
   * goes through target(), including the ones that create nothing — adopting
   * an existing env skips key setup entirely, and without the key on disk
   * that env looks unreachable and gets rebuilt from scratch.
   */
  protected materializeInjectedKey(): void {
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

  /**
   * The local key pair, generated on first use. Returns true when it was just
   * created, so a provider that registers the public key in the cloud knows
   * any copy registered before is stale.
   */
  protected ensureLocalKey(): boolean {
    mkdirSync(SSH_DIR, { recursive: true });
    // RUNO_SSH_KEY: the private key as a value instead of a file. An ephemeral
    // CI runner has no ~/.runo, so without this every job would generate a new
    // key and lock itself out of the environment the previous job created for
    // the same branch.
    this.materializeInjectedKey();
    if (existsSync(this.keyPath)) return false;
    const gen = Bun.spawnSync(
      ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", this.keyName, "-f", this.keyPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (gen.exitCode !== 0)
      throw new RunoError(`Failed to generate SSH key: ${gen.stderr.toString()}`);
    return true;
  }

  protected target(rt: Runtime): SshTarget {
    this.materializeInjectedKey();
    if (!rt.ip)
      throw new RunoError(
        `Environment ${rt.name ?? rt.id} has no public IP (state: ${rt.state})`,
        "If it is stopped, run `runo resume`",
      );
    return { ip: rt.ip, user: REMOTE_USER, keyPath: this.keyPath };
  }

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

  /** Where port 22 is opened, for the hint when SSH never answers. */
  protected abstract readonly firewallHint: string;

  async waitReady(rt: Runtime, opts?: { firstBoot?: boolean } | null): Promise<void> {
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
        `Check the ${this.firewallHint} (port 22) and the instance state with \`runo ls\``,
      );
    if (opts?.firstBoot)
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
}

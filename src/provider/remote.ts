/**
 * RemoteProvider — the CLI side of the control plane.
 *
 * Activated by RUNO_SERVER + RUNO_TOKEN: every RuntimeProvider operation goes
 * over HTTP/WS to runo-server, which holds the AWS credentials and SSH keys.
 * Developer laptops need ZERO cloud credentials.
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { TMP_DIR } from "../config";
import { RunoError } from "../errors";
import { log } from "../log";
import { shq } from "../ssh";
import type {
  CreateSpec,
  ExecOpts,
  ExecResult,
  Runtime,
  RuntimeProvider,
} from "./types";

export class RemoteProvider implements RuntimeProvider {
  readonly name = "remote";
  private base: string;
  private token: string;

  constructor(server: string, token: string) {
    this.base = server.replace(/\/+$/, "");
    this.token = token;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, "content-type": "application/json" };
  }

  private async post(pathname: string, body: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${pathname}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      throw new RunoError(
        `Could not reach runo-server at ${this.base} (${e?.message ?? e})`,
        "Check RUNO_SERVER and that the server is running",
      );
    }
    return res;
  }

  private async rpc<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const res = await this.post("/v1/rpc", { method, args });
    const data = (await res.json()) as any;
    if (!res.ok || data.error)
      throw new RunoError(data.error?.message ?? `server error (${res.status})`, data.error?.hint);
    return data.result as T;
  }

  async preflight(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/v1/health`, { headers: this.headers() });
    } catch (e: any) {
      throw new RunoError(
        `Could not reach runo-server at ${this.base} (${e?.message ?? e})`,
        "Check RUNO_SERVER and that the server is running",
      );
    }
    if (res.status === 401)
      throw new RunoError("runo-server rejected the token", "Check RUNO_TOKEN");
    if (!res.ok) throw new RunoError(`runo-server unhealthy (${res.status})`);
  }

  create(spec: CreateSpec): Promise<Runtime> {
    return this.rpc("create", spec);
  }
  waitReady(rt: Runtime, opts?: { firstBoot?: boolean }): Promise<void> {
    return this.rpc("waitReady", rt, opts);
  }
  status(rt: Runtime): Promise<Runtime> {
    return this.rpc("status", rt);
  }
  suspend(rt: Runtime): Promise<Runtime> {
    return this.rpc("suspend", rt);
  }
  resume(rt: Runtime): Promise<Runtime> {
    return this.rpc("resume", rt);
  }
  destroy(rt: Runtime): Promise<void> {
    return this.rpc("destroy", rt);
  }
  ensurePorts(ports: number[]): Promise<void> {
    return this.rpc("ensurePorts", ports);
  }
  listManaged(): Promise<Runtime[]> {
    return this.rpc("listManaged");
  }
  poolStatus(): Promise<Runtime[]> {
    return this.rpc("poolStatus");
  }
  poolScale(target: number): Promise<void> {
    return this.rpc("poolScale", target);
  }
  prepareBootImage(): Promise<string> {
    return this.rpc("prepareBootImage");
  }
  removeBootImage(): Promise<void> {
    return this.rpc("removeBootImage");
  }
  async registerServices(rt: Runtime, services: { name: string; port: number }[]): Promise<void> {
    const res = await this.post("/v1/register-services", { rt, services });
    const data = (await res.json()) as any;
    if (!res.ok || data.error)
      throw new RunoError(data.error?.message ?? `register-services failed (${res.status})`);
  }

  async cleanupShared(): Promise<void> {
    // shared resources (keypair/SG) belong to the server operator
    log.warn(
      "keypair/SG cleanup is a server-side operation — ask the runo-server operator if needed",
    );
  }

  serviceUrls(rt: Runtime, ports: number[]): string[] {
    if (!rt.ip) return [];
    return ports.map((p) => `http://${rt.ip}:${p}`);
  }

  async exec(rt: Runtime, command: string, opts: ExecOpts = {}): Promise<ExecResult> {
    if (!opts.stream) {
      const res = await this.post("/v1/exec", { rt, command, opts });
      const data = (await res.json()) as any;
      if (!res.ok || data.error)
        throw new RunoError(data.error?.message ?? `server error (${res.status})`, data.error?.hint);
      return data.result as ExecResult;
    }
    // streaming: ndjson chunks forwarded to the local terminal
    const res = await this.post("/v1/exec", { rt, command, opts: { ...opts, stream: true } });
    if (!res.ok || !res.body) throw new RunoError(`server error on streaming exec (${res.status})`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let exitCode = 1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.t === "out") process.stdout.write(msg.d);
        else if (msg.t === "err") process.stderr.write(msg.d);
        else if (msg.t === "exit") exitCode = msg.code;
      }
    }
    return { exitCode, stdout: "", stderr: "" };
  }

  async execInteractive(rt: Runtime, command: string, opts: { cwd?: string } = {}): Promise<number> {
    const wrapped = opts.cwd ? `cd ${shq(opts.cwd)} && { ${command} ; }` : command;
    if (!process.stdin.isTTY) {
      // headless: streaming exec is enough (no stdin in v0 remote mode)
      const r = await this.exec(rt, wrapped, { stream: true });
      return r.exitCode;
    }
    // experimental: raw byte pipe over WebSocket to `ssh -tt` on the server
    const full = `bash -lc ${shq(wrapped)}`;
    const wsUrl =
      this.base.replace(/^http/, "ws") +
      `/v1/tty?token=${encodeURIComponent(this.token)}&rt=${encodeURIComponent(JSON.stringify(rt))}&cmd=${encodeURIComponent(
        Buffer.from(full).toString("base64"),
      )}`;
    return await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      let exitCode = 0;
      const stdin = process.stdin;
      const onData = (chunk: Buffer) =>
        ws.readyState === WebSocket.OPEN && ws.send(new Uint8Array(chunk));
      ws.onopen = () => {
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.on("data", onData);
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.t === "exit") exitCode = msg.code;
          } catch {}
          return;
        }
        process.stdout.write(new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onclose = () => {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.off("data", onData);
        resolve(exitCode);
      };
      ws.onerror = () => reject(new RunoError("WebSocket tunnel to runo-server failed"));
    });
  }

  async logs(rt: Runtime, command: string, opts: { cwd?: string } = {}): Promise<number> {
    return await this.execInteractive(rt, command, opts);
  }

  async upload(rt: Runtime, localPath: string, remotePath: string): Promise<void> {
    const body = await Bun.file(localPath).arrayBuffer();
    const res = await fetch(
      `${this.base}/v1/upload?rt=${encodeURIComponent(JSON.stringify(rt))}&path=${encodeURIComponent(remotePath)}`,
      { method: "POST", headers: { authorization: `Bearer ${this.token}` }, body },
    );
    const data = (await res.json()) as any;
    if (!res.ok || data.error)
      throw new RunoError(data.error?.message ?? `upload failed (${res.status})`, data.error?.hint);
  }

  async uploadDir(
    rt: Runtime,
    localPath: string,
    remotePath: string,
    excludes: string[] = [],
  ): Promise<void> {
    // tar the local dir (applying excludes) and extract it remotely via exec
    mkdirSync(TMP_DIR, { recursive: true });
    const tarPath = path.join(TMP_DIR, `push-${Date.now()}.tar.gz`);
    const args = ["tar", "-czf", tarPath, ...excludes.map((e) => `--exclude=${e}`), "-C", localPath, "."];
    const proc = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0)
      throw new RunoError(`local tar failed: ${proc.stderr.toString().trim()}`);
    try {
      const remoteTmp = `/tmp/runo-push-${Date.now()}.tar.gz`;
      await this.upload(rt, tarPath, remoteTmp);
      const r = await this.exec(
        rt,
        `mkdir -p ${shq(remotePath)} && tar -xzf ${shq(remoteTmp)} -C ${shq(remotePath)} && rm -f ${shq(remoteTmp)}`,
      );
      if (r.exitCode !== 0) throw new RunoError(`remote extraction failed: ${r.stderr.trim()}`);
    } finally {
      rmSync(tarPath, { force: true });
    }
  }

  async download(
    rt: Runtime,
    remotePath: string,
    localPath: string,
    excludes: string[] = [],
  ): Promise<void> {
    const res = await this.post("/v1/download", { rt, remotePath, excludes });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => null) as any;
      throw new RunoError(data?.error?.message ?? `download failed (${res.status})`, data?.error?.hint);
    }
    mkdirSync(TMP_DIR, { recursive: true });
    const tarPath = path.join(TMP_DIR, `pull-${Date.now()}.tar.gz`);
    await Bun.write(tarPath, res);
    try {
      mkdirSync(localPath.endsWith("/") ? localPath : path.dirname(localPath), { recursive: true });
      const dest = localPath.endsWith("/") ? localPath : path.dirname(localPath) + "/";
      const proc = Bun.spawnSync(["tar", "-xzf", tarPath, "-C", dest], { stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode !== 0)
        throw new RunoError(`local extraction failed: ${proc.stderr.toString().trim()}`);
    } finally {
      rmSync(tarPath, { force: true });
    }
  }
}

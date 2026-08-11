import path from "node:path";
import { SSH_DIR } from "./config";

export interface SshTarget {
  ip: string;
  user: string;
  keyPath: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Escapa para uso como argumento único em shell POSIX. */
export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export function sshBaseArgs(t: SshTarget): string[] {
  return [
    "-i", t.keyPath,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${path.join(SSH_DIR, "known_hosts")}`,
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=8",
    "-o", "LogLevel=ERROR",
  ];
}

export async function sshExec(
  t: SshTarget,
  command: string,
  opts: { stream?: boolean; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const cmd = ["ssh", ...sshBaseArgs(t), `${t.user}@${t.ip}`, command];
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: opts.stream ? "inherit" : "pipe",
    stderr: opts.stream ? "inherit" : "pipe",
  });
  let timedOut = false;
  let timer: Timer | undefined;
  if (opts.timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, opts.timeoutMs);
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    opts.stream ? Promise.resolve("") : new Response(proc.stdout as ReadableStream).text(),
    opts.stream ? Promise.resolve("") : new Response(proc.stderr as ReadableStream).text(),
  ]);
  if (timer) clearTimeout(timer);
  return { exitCode: timedOut ? 124 : exitCode, stdout, stderr };
}

/** Sessão com stdio herdado (agente interativo, logs -f, exec). TTY se o terminal local for TTY. */
export async function sshInteractive(t: SshTarget, command: string): Promise<number> {
  const tty = process.stdin.isTTY === true;
  const cmd = ["ssh", ...(tty ? ["-t"] : []), ...sshBaseArgs(t), `${t.user}@${t.ip}`, command];
  const proc = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

export async function scpUpload(t: SshTarget, localPath: string, remotePath: string): Promise<ExecResult> {
  const cmd = ["scp", "-q", ...sshBaseArgs(t), localPath, `${t.user}@${t.ip}:${remotePath}`];
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** rsync local→remoto (runo push: worktree → VM). */
export async function rsyncPush(
  t: SshTarget,
  localPath: string,
  remotePath: string,
  excludes: string[] = [],
): Promise<ExecResult> {
  const sshCmd = ["ssh", ...sshBaseArgs(t)].map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
  const cmd = [
    "rsync",
    "-az",
    "-e", sshCmd,
    ...excludes.map((e) => `--exclude=${e}`),
    localPath,
    `${t.user}@${t.ip}:${remotePath}`,
  ];
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** rsync remoto→local (runo pull, download de evidência). */
export async function rsyncPull(
  t: SshTarget,
  remotePath: string,
  localPath: string,
  excludes: string[] = [],
): Promise<ExecResult> {
  const sshCmd = ["ssh", ...sshBaseArgs(t)].map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
  const cmd = [
    "rsync",
    "-az",
    "-e", sshCmd,
    ...excludes.map((e) => `--exclude=${e}`),
    `${t.user}@${t.ip}:${remotePath}`,
    localPath,
  ];
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  return { exitCode, stdout, stderr };
}

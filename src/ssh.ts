import path from "node:path";
import { mkdirSync } from "node:fs";
import { HASH6, SSH_DIR } from "./config";

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

/** Escapes a string for use as a single POSIX shell argument. */
export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Multiplexing socket path. Unix sockets cap at ~104 bytes, and %C expands to
 * 40 more: a deep RUNO_HOME turns EVERY ssh call into "ControlPath too long",
 * which surfaces as "SSH did not respond" and sends you looking at security
 * groups. Fall back to a short path under the system temp dir, still scoped by
 * the install hash.
 */
function controlPath(): string {
  // %C expands to a 40-char hash, and ssh binds the socket at
  // "<path>.<16 random chars>" before renaming it — both count against the
  // ~104-byte sun_path limit.
  const EXPANDED = 40 - "%C".length;
  const TEMP_SUFFIX = 17;
  const LIMIT = 104;
  const natural = path.join(SSH_DIR, "cm-%C");
  if (natural.length + EXPANDED + TEMP_SUFFIX < LIMIT) return natural;
  // deliberately /tmp and not tmpdir(): on macOS the per-user temp dir is
  // itself ~50 bytes, which does not fit either
  const dir = `/tmp/runo-${HASH6}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "cm-%C");
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
    // connection multiplexing: the first call opens a master, the rest reuse
    // it — repeated exec/push drop from ~300-500ms of handshake to ~ms
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPath()}`,
    "-o", "ControlPersist=60s",
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

/**
 * Drops the multiplexing master for this host. Needed after provisioning:
 * sessions reuse the master's credentials from auth time, so group changes
 * (usermod docker) only apply on a FRESH connection.
 */
export async function sshCloseMaster(t: SshTarget): Promise<void> {
  const proc = Bun.spawn(["ssh", ...sshBaseArgs(t), "-O", "exit", `${t.user}@${t.ip}`], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

/** Session with inherited stdio (interactive agent, logs -f, exec). TTY when the local terminal is a TTY. */
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

/** rsync local→remote (runo push: worktree → VM). */
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

/** rsync remote→local (runo pull, evidence download). */
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

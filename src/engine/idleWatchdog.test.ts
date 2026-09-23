import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  IDLE_CHECK_PATH,
  IDLE_CHECK_SCRIPT,
  IDLE_CRON_CONTENT,
  IDLE_CRON_PATH,
  ensureIdleWatchdog,
} from "./idleWatchdog";
import type { ExecResult, Runtime, RuntimeProvider } from "../provider/types";

const rt = { id: "i-test", ip: null, state: "running" } as Runtime;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Minimal fake: canned probe output, records every command. */
function fakeProvider(probeStdout: string, probeExit = 0) {
  const commands: string[] = [];
  const provider = {
    exec: async (_rt: Runtime, command: string): Promise<ExecResult> => {
      commands.push(command);
      if (command.includes("sha256sum")) return { exitCode: probeExit, stdout: probeStdout, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  } as unknown as RuntimeProvider;
  return { provider, commands };
}

/** Extracts every `echo <b64> | ... tee <path>` payload from a write command. */
function payloadsFor(command: string, dest: string): string[] {
  return command
    .split("\n")
    .filter((l) => l.includes(`tee ${dest}`))
    .map((l) => Buffer.from(l.split(" ")[1]!, "base64").toString("utf8"));
}

// Guards the two homes of the watchdog against drift: image/cloud-init.yaml
// (first boot) and idleWatchdog.ts (every `runo up`).
test("watchdog content matches image/cloud-init.yaml", () => {
  const yamlPath = path.join(import.meta.dir, "../../image/cloud-init.yaml");
  const doc = parse(readFileSync(yamlPath, "utf8"));
  const files = Object.fromEntries(
    (doc.write_files as { path: string; content: string }[]).map((f) => [f.path, f.content]),
  );
  expect(files[IDLE_CHECK_PATH]).toBe(IDLE_CHECK_SCRIPT);
  expect(files[IDLE_CRON_PATH]).toBe(IDLE_CRON_CONTENT);
});

test("skips writes when the watchdog is already in place", async () => {
  const probe = `${sha(IDLE_CHECK_SCRIPT)}  ${IDLE_CHECK_PATH}\n${sha(IDLE_CRON_CONTENT)}  ${IDLE_CRON_PATH}\n`;
  const { provider, commands } = fakeProvider(probe);
  await ensureIdleWatchdog(provider, rt);
  expect(commands.length).toBe(1); // probe only, no writes
});

test("installs only the missing file with byte-exact content", async () => {
  const probe = `${sha(IDLE_CHECK_SCRIPT)}  ${IDLE_CHECK_PATH}\n${IDLE_CRON_PATH} missing\n`;
  const { provider, commands } = fakeProvider(probe);
  await ensureIdleWatchdog(provider, rt);
  expect(commands.length).toBe(2);
  const write = commands[1]!;
  expect(write).not.toContain(`tee ${IDLE_CHECK_PATH}`); // script untouched
  expect(write).toContain(`tee ${IDLE_CRON_PATH}`);
  expect(write).toContain("chmod 644");
  expect(payloadsFor(write, IDLE_CRON_PATH)).toEqual([IDLE_CRON_CONTENT]);
});

test("rewrites a drifted script", async () => {
  const probe = `deadbeef  ${IDLE_CHECK_PATH}\n${sha(IDLE_CRON_CONTENT)}  ${IDLE_CRON_PATH}\n`;
  const { provider, commands } = fakeProvider(probe);
  await ensureIdleWatchdog(provider, rt);
  expect(commands.length).toBe(2);
  expect(payloadsFor(commands[1]!, IDLE_CHECK_PATH)).toEqual([IDLE_CHECK_SCRIPT]);
});

test("tolerates a failed probe without throwing", async () => {
  const { provider, commands } = fakeProvider("", 1);
  await ensureIdleWatchdog(provider, rt);
  expect(commands.length).toBe(1); // no writes attempted
});

// Runs the real script against a fake /etc/runo and /run by rewriting its paths.
test("idle-signals without net: traffic no longer keeps the VM awake", () => {
  const root = mkdtempSync(path.join(tmpdir(), "runo-idle-"));
  try {
    mkdirSync(path.join(root, "etc"));
    mkdirSync(path.join(root, "state"));
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "etc/idle-limit"), "60\n");
    writeFileSync(path.join(root, "state/last-active"), String(Math.floor(Date.now() / 1000) - 3600));
    // stubs: an ssh-less box with heavy traffic; poweroff only leaves a mark
    writeFileSync(path.join(root, "bin/ss"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(root, "bin/ip"), "#!/bin/sh\necho 'default via 10.0.0.1 dev eth0'\n", { mode: 0o755 });
    writeFileSync(path.join(root, "bin/logger"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(root, "bin/pgrep"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(path.join(root, "bin/systemctl"), `#!/bin/sh\ntouch ${root}/powered-off\n`, { mode: 0o755 });
    let rx = 0;
    const netdev = path.join(root, "netdev");
    const script = IDLE_CHECK_SCRIPT.replaceAll("/etc/runo", path.join(root, "etc"))
      .replaceAll("/run/runo-idle", path.join(root, "state"))
      .replaceAll("/proc/net/dev", netdev);
    const run = () => {
      rx += 50_000_000; // 50MB since the last minute
      writeFileSync(netdev, `h1\nh2\n  eth0: ${rx} 0 0 0 0 0 0 0 1000 0 0 0 0 0 0 0\n`);
      Bun.spawnSync(["bash", "-c", script], { env: { PATH: `${root}/bin:${process.env.PATH}` } });
      return existsSync(path.join(root, "powered-off"));
    };
    run(); // first sample only records the byte counter
    expect(run()).toBe(false); // default signals: traffic is activity
    writeFileSync(path.join(root, "etc/idle-signals"), "ssh agent\n");
    writeFileSync(path.join(root, "state/last-active"), String(Math.floor(Date.now() / 1000) - 3600));
    expect(run()).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

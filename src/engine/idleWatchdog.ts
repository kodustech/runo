import { createHash } from "node:crypto";
import { log } from "../log";
import type { Runtime, RuntimeProvider } from "../provider/types";

/**
 * Idle auto-suspend watchdog — the on-VM cron that shuts the instance down
 * after `limits.idle_suspend` without activity (SSH, external traffic, agent CPU).
 *
 * `image/cloud-init.yaml` installs this on first boot, but baked/pool/old VMs
 * can miss it (baked images skip user-data; files can also go missing later —
 * one env stayed up 13 days with the script present and the cron entry gone).
 * `ensureIdleWatchdog()` re-installs it on every `runo up`, so those VMs
 * self-heal instead of burning compute forever.
 *
 * `idleWatchdog.test.ts` fails if this drifts from `image/cloud-init.yaml`.
 */

export const IDLE_CHECK_PATH = "/usr/local/bin/runo-idle-check";
export const IDLE_CRON_PATH = "/etc/cron.d/runo-idle";

export const IDLE_CHECK_SCRIPT = `#!/usr/bin/env bash
set -u
LIMIT=$(cat /etc/runo/idle-limit 2>/dev/null || echo 600)
case "$LIMIT" in (*[!0-9]*|"") exit 0;; esac
[ "$LIMIT" -le 0 ] && exit 0
# which activity counts (idle-signals, default all): a public preview gets
# enough bot and outbound traffic to never look idle, so it drops "net"
SIGNALS=" $(cat /etc/runo/idle-signals 2>/dev/null || echo ssh net agent) "
STATE=/run/runo-idle; mkdir -p "$STATE"
now=$(date +%s); active=""
[[ $SIGNALS == *" ssh "* ]] && ss -Htn state established '( sport = :22 )' 2>/dev/null | grep -q . && active=ssh
if [ -z "$active" ] && [[ $SIGNALS == *" net "* ]]; then
  # default-route interface only: container-to-container chatter and
  # watch-mode rebuild loops must not count as user activity
  IFACE=$(ip route show default 2>/dev/null | awk '{print $5; exit}')
  if [ -n "\${IFACE:-}" ]; then
    bytes=$(awk -F'[: ]+' -v ifc="$IFACE" 'NR>2 && $2 == ifc { print $3+$11; exit }' /proc/net/dev)
    prev=$(cat "$STATE/netbytes" 2>/dev/null || echo 0)
    echo "\${bytes:-0}" > "$STATE/netbytes"
    [ $(( \${bytes:-0} - prev )) -gt 102400 ] && active=net
  fi
fi
if [ -z "$active" ] && [[ $SIGNALS == *" agent "* ]]; then
  for pid in $(pgrep -x claude; pgrep -x codex); do
    t=$(awk '{ print $14+$15 }' "/proc/$pid/stat" 2>/dev/null) || continue
    prev=$(cat "$STATE/agent-$pid" 2>/dev/null || echo -1)
    echo "$t" > "$STATE/agent-$pid"
    if [ "$t" != "$prev" ]; then active=agent; break; fi
  done
fi
if [ -n "$active" ] || [ ! -f "$STATE/last-active" ]; then
  echo "$now" > "$STATE/last-active"; exit 0
fi
last=$(cat "$STATE/last-active")
if [ $((now - last)) -ge "$LIMIT" ]; then
  logger -t runo "auto-suspend: idle for $((now - last))s (limit \${LIMIT}s)"
  systemctl poweroff
fi
`;

/**
 * Restarts the idle clock. Every up/resume is use, and a VM resumed from
 * hibernation comes back with the old clock in /run: without this, one whose
 * signals exclude "net" would power off again within a minute.
 */
export const IDLE_MARK_ACTIVE = "sudo mkdir -p /run/runo-idle && date +%s | sudo tee /run/runo-idle/last-active >/dev/null";

export const IDLE_CRON_CONTENT = `* * * * * root /usr/local/bin/runo-idle-check
`;

const SPECS = [
  { path: IDLE_CHECK_PATH, content: IDLE_CHECK_SCRIPT, mode: "755" },
  { path: IDLE_CRON_PATH, content: IDLE_CRON_CONTENT, mode: "644" },
];

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Idempotent: one cheap check per `up`, writes only what is missing or differs. */
export async function ensureIdleWatchdog(provider: RuntimeProvider, rt: Runtime): Promise<void> {
  const probe = SPECS.map((s) => `(sha256sum ${s.path} 2>/dev/null || echo "${s.path} missing")`).join(" && ");
  const r = await provider.exec(rt, probe, { timeoutMs: 30_000 });
  if (r.exitCode !== 0) {
    log.warn("could not verify the idle watchdog — auto-suspend may not trigger");
    return;
  }
  const lines = r.stdout.trim().split("\n");
  const stale = SPECS.filter((s, i) => !(lines[i] ?? "").startsWith(sha(s.content)));
  if (stale.length === 0) return;
  const writes = stale.map((s) => {
    const b64 = Buffer.from(s.content, "utf8").toString("base64");
    return `echo ${b64} | base64 -d | sudo tee ${s.path} >/dev/null && sudo chmod ${s.mode} ${s.path}`;
  });
  const w = await provider.exec(rt, writes.join("\n"), { timeoutMs: 60_000 });
  if (w.exitCode !== 0) log.warn("could not install the idle watchdog — auto-suspend may not trigger");
  else log.dim(`idle watchdog (re)installed: ${stale.map((s) => s.path).join(", ")}`);
}

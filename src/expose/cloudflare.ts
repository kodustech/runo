import { RunoError } from "../errors";
import { log } from "../log";
import { REMOTE_RUNO_DIR } from "../config";
import type { ExposeDef } from "../recipe";
import { CloudflareApi } from "./cloudflare-api";
import type { ExposeContext, ExposeProvider, ExposeService } from "./types";

/**
 * Cloudflare Tunnel expose.
 *
 * The VM dials OUT to Cloudflare, so the env gets an HTTPS URL with a real
 * certificate and WebSockets, and NO inbound port has to be opened on the
 * security group (SSH stays the only way in).
 *
 * Quick mode (no credentials at all): each service gets a random
 * `https://<words>.trycloudflare.com`. Zero setup, but the hostname is
 * re-drawn whenever cloudflared restarts (so, on every suspend/resume) and
 * plenty of corporate resolvers blackhole the whole zone — quick tunnels are
 * abused for phishing, so filters block them.
 *
 * Named mode (recipe `expose.domain` + CLOUDFLARE_API_TOKEN): the env keeps
 * ONE hostname on a domain the team owns, which is what a link pasted into a
 * pull request needs. Note Cloudflare's free Universal SSL only covers one
 * level of subdomain: `pr-1.acme.com` is served, `pr-1.preview.acme.com`
 * needs Advanced Certificate Manager.
 */

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function unitName(svc: string): string {
  return `runo-tunnel-${svc.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

function logPath(svc: string): string {
  return `${REMOTE_RUNO_DIR}/tunnel-${svc.replace(/[^a-zA-Z0-9_.-]/g, "-")}.log`;
}

/** Installs cloudflared if the image does not carry it yet (idempotent). */
function installScript(): string {
  return [
    "BIN=$(command -v cloudflared || true)",
    'if [ -z "$BIN" ]; then',
    "  ARCH=$(dpkg --print-architecture)",
    '  curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb"',
    "  sudo dpkg -i /tmp/cloudflared.deb >/dev/null 2>&1",
    "  rm -f /tmp/cloudflared.deb",
    "  BIN=$(command -v cloudflared || true)",
    "fi",
    '[ -n "$BIN" ] || { echo "cloudflared install failed" >&2; exit 1; }',
    `mkdir -p ${REMOTE_RUNO_DIR}`,
  ].join("\n");
}

/** systemd unit + restart + wait for the URL cloudflared prints on startup. */
function serviceScript(svc: ExposeService): string {
  const unit = unitName(svc.name);
  const logFile = logPath(svc.name);
  return [
    `sudo tee /etc/systemd/system/${unit}.service >/dev/null <<UNIT`,
    "[Unit]",
    `Description=runo quick tunnel (${svc.name})`,
    "After=network-online.target",
    "",
    "[Service]",
    "User=ubuntu",
    `ExecStartPre=/bin/rm -f ${logFile}`,
    `ExecStart=$BIN tunnel --no-autoupdate --logfile ${logFile} --url http://127.0.0.1:${svc.port}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    "sudo systemctl daemon-reload",
    `sudo systemctl enable ${unit} >/dev/null 2>&1 || true`,
    `sudo systemctl restart ${unit}`,
    "url=''",
    "for i in $(seq 1 60); do",
    `  url=$(grep -oE 'https://[a-z0-9-]+\\.trycloudflare\\.com' ${logFile} 2>/dev/null | head -1 || true)`,
    '  [ -n "$url" ] && break',
    "  sleep 1",
    "done",
    `echo "RUNO_TUNNEL ${svc.name} \${url:-none}"`,
  ].join("\n");
}

function labelFor(cfg: ExposeDef, slug: string): string {
  const raw = (cfg.hostname ?? "${RUNO_SLUG}").replaceAll("${RUNO_SLUG}", slug);
  const label = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  if (!label) throw new RunoError(`expose.hostname resolved to an empty DNS label (slug: ${slug})`);
  return label;
}

function namedHost(cfg: ExposeDef, slug: string, svc: ExposeService): string {
  const base = labelFor(cfg, slug);
  return svc.primary ? `${base}.${cfg.domain}` : `${svc.name}--${base}.${cfg.domain}`;
}

/** One cloudflared for every service: routing lives in the tunnel config. */
function namedRunScript(): string {
  return [
    installScript(),
    "sudo mkdir -p /etc/runo",
    // the token never reaches argv (ps is world-readable) — systemd reads it
    // from a root-only env file
    "sudo tee /etc/systemd/system/runo-tunnel.service >/dev/null <<UNIT",
    "[Unit]",
    "Description=runo named tunnel",
    "After=network-online.target",
    "",
    "[Service]",
    "EnvironmentFile=/etc/runo/cf-tunnel.env",
    "ExecStart=$BIN tunnel --no-autoupdate run",
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    "sudo systemctl daemon-reload",
    "sudo systemctl enable runo-tunnel >/dev/null 2>&1 || true",
    "sudo systemctl restart runo-tunnel",
    "for i in $(seq 1 60); do",
    "  sudo journalctl -u runo-tunnel --since '-2 min' --no-pager 2>/dev/null | grep -q 'Registered tunnel connection' && { echo RUNO_TUNNEL_READY; break; }",
    "  sleep 1",
    "done",
  ].join("\n");
}

async function upNamed(ctx: ExposeContext, cfg: ExposeDef): Promise<Record<string, string>> {
  const api = CloudflareApi.fromEnv();
  const accountId = await api.accountId();
  const zone = await api.zoneIdFor(cfg.domain!);
  const tunnelName = `runo-${ctx.slug}`;

  log.step(`publishing over a named Cloudflare tunnel on ${cfg.domain} (zone ${zone.name})…`);
  const { id, token } = await api.ensureTunnel(accountId, tunnelName);
  const rules = ctx.services.map((s) => ({ hostname: namedHost(cfg, ctx.slug, s), port: s.port }));
  await api.setIngress(accountId, id, rules);
  for (const r of rules) await api.upsertCname(zone.id, r.hostname, id);

  // token to the VM first (600, root), then the unit that reads it
  const tokenFile = "/etc/runo/cf-tunnel.env";
  const write = await ctx.provider.exec(
    ctx.rt,
    [
      "sudo mkdir -p /etc/runo",
      `sudo tee ${tokenFile} >/dev/null <<'ENVEOF'`,
      `TUNNEL_TOKEN=${token}`,
      "ENVEOF",
      `sudo chmod 600 ${tokenFile}`,
    ].join("\n"),
    { timeoutMs: 60_000 },
  );
  if (write.exitCode !== 0)
    throw new RunoError("Could not install the tunnel token on the VM", write.stderr.trim());

  const r = await ctx.provider.exec(ctx.rt, namedRunScript(), { timeoutMs: 5 * 60_000 });
  if (r.exitCode !== 0)
    throw new RunoError(
      "Could not start the named Cloudflare tunnel on the VM",
      r.stderr.trim().split("\n").slice(-5).join("\n"),
    );
  if (!r.stdout.includes("RUNO_TUNNEL_READY"))
    log.warn("the tunnel did not report a registered connection yet — the health check will tell");

  return Object.fromEntries(rules.map((r2, i) => [ctx.services[i]!.name, `https://${r2.hostname}`]));
}

async function downNamed(ctx: Omit<ExposeContext, "services">, cfg: ExposeDef): Promise<void> {
  const api = CloudflareApi.fromEnv();
  const accountId = await api.accountId();
  const tunnelId = await api.findTunnel(accountId, `runo-${ctx.slug}`);
  if (!tunnelId) return;
  const zone = await api.zoneIdFor(cfg.domain!);
  // DNS first: a record pointing at a deleted tunnel is a dead hostname
  await api.deleteDnsForTunnel(zone.id, tunnelId);
  await api.deleteTunnel(accountId, `runo-${ctx.slug}`);
}

export function cloudflareExpose(cfg: ExposeDef): ExposeProvider {
  return {
  name: cfg.domain ? "tunnel" : "tunnel (quick)",

  async up(ctx: ExposeContext): Promise<Record<string, string>> {
    if (ctx.services.length === 0) return {};
    if (cfg.domain) return await upNamed(ctx, cfg);
    log.step(
      `opening Cloudflare tunnel(s) for ${ctx.services.map((s) => `${s.name}:${s.port}`).join(", ")}…`,
    );
    const script = [installScript(), ...ctx.services.map(serviceScript)].join("\n");
    const r = await ctx.provider.exec(ctx.rt, script, { timeoutMs: 5 * 60_000 });
    if (r.exitCode !== 0)
      throw new RunoError(
        "Could not start the Cloudflare tunnel on the VM",
        r.stderr.trim().split("\n").slice(-5).join("\n") ||
          "Check connectivity from the VM to cloudflare.com",
      );

    const urls: Record<string, string> = {};
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/^RUNO_TUNNEL (\S+) (\S+)$/);
      if (!m) continue;
      const [, name, url] = m;
      if (url && url !== "none" && QUICK_URL_RE.test(url)) urls[name!] = url;
    }
    const missing = ctx.services.filter((s) => !urls[s.name]).map((s) => s.name);
    if (missing.length > 0)
      throw new RunoError(
        `Cloudflare did not hand out a URL for: ${missing.join(", ")}`,
        `Inspect on the VM: runo exec -- sudo journalctl -u ${unitName(missing[0]!)} -n 40`,
      );
    return urls;
  },

  async down(ctx: Omit<ExposeContext, "services">): Promise<void> {
    // Named mode owns real resources off the VM (a tunnel and DNS records) —
    // those outlive the instance and must be released explicitly.
    if (cfg.domain) return await downNamed(ctx, cfg);
    // Quick mode: nothing exists outside the VM; this only matters when the
    // caller wants the env unpublished while the instance keeps running.
    const script = [
      "for u in $(systemctl list-unit-files --no-legend 'runo-tunnel-*.service' | awk '{print $1}'); do",
      '  sudo systemctl disable --now "$u" >/dev/null 2>&1 || true',
      '  sudo rm -f "/etc/systemd/system/$u"',
      "done",
      "sudo systemctl daemon-reload || true",
    ].join("\n");
    try {
      await ctx.provider.exec(ctx.rt, script, { timeoutMs: 60_000 });
    } catch {
      // the VM may already be gone — nothing to release off-VM in quick mode
    }
  },
  };
}

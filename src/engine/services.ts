import { mkdirSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import path from "node:path";
import { stringify } from "yaml";
import { REMOTE_RUNO_DIR, TMP_DIR } from "../config";
import { RunoError } from "../errors";
import { log } from "../log";
import type { NormalizedRecipe } from "../recipe";
import { shq } from "../ssh";
import type { Runtime, RuntimeProvider } from "../provider/types";
import type { PublicService } from "../registry";

const REMOTE_COMPOSE = `${REMOTE_RUNO_DIR}/compose.yaml`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ServicePlan {
  publicServices: PublicService[]; // name + port + health path (becomes URL/SG)
  internalPorts: number[]; // ports to wait for on the VM itself
}

export function tmuxSession(svc: string): string {
  return `runo-${svc}`;
}

function envVarName(prefix: string, service: string): string {
  return `${prefix}${service.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** Strips the scheme (and any trailing slash) — apps usually want a bare host. */
function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * docker compose prefix for passthrough mode: env vars for interpolation
 * (with ${RUNO_PUBLIC_IP} / ${RUNO_PUBLIC_URL} substituted), -f overlays in
 * order, profiles.
 *
 * The URL vars are why expose runs BEFORE `compose up`: an app that has to
 * emit absolute links (auth callbacks, a frontend calling its own API) needs
 * its public address in the environment it boots with.
 */
export function composePrefix(
  recipe: NormalizedRecipe,
  publicIp?: string | null,
  urls: Record<string, string> = {},
  primary?: string,
): string {
  const c = recipe.compose!;
  const primaryUrl = (primary && urls[primary]) ?? Object.values(urls)[0] ?? "";
  const env = Object.entries(c.env ?? {})
    .map(([k, v]) => {
      let val = v
        .replaceAll("${RUNO_PUBLIC_IP}", publicIp ?? "")
        // dashed form for wildcard-DNS services (nip.io/sslip.io) where dotted
        // IPs are ambiguous next to other numeric labels
        .replaceAll("${RUNO_PUBLIC_IP_DASHED}", (publicIp ?? "").replaceAll(".", "-"))
        .replaceAll("${RUNO_PUBLIC_URL}", primaryUrl)
        .replaceAll("${RUNO_PUBLIC_HOST}", primaryUrl ? hostOf(primaryUrl) : "");
      for (const [svc, url] of Object.entries(urls)) {
        val = val
          .replaceAll(`\${${envVarName("RUNO_URL_", svc)}}`, url)
          .replaceAll(`\${${envVarName("RUNO_HOST_", svc)}}`, hostOf(url));
      }
      return `${k}=${shq(val)} `;
    })
    .join("");
  const files = c.files.map((f) => ` -f ${shq(f)}`).join("");
  const profiles = c.profiles.map((p) => ` --profile ${shq(p)}`).join("");
  return `${env}docker compose${files}${profiles}`;
}

function generatedComposeYaml(recipe: NormalizedRecipe): string {
  const services: Record<string, unknown> = {};
  for (const [name, svc] of Object.entries(recipe.services)) {
    if (!svc.image) continue;
    services[name] = {
      image: svc.image,
      container_name: `runo-${name}`,
      restart: "unless-stopped",
      ...(svc.port ? { ports: [`${svc.port}:${svc.port}`] } : {}),
      ...(svc.env ? { environment: svc.env } : {}),
    };
  }
  return stringify({ services });
}

/**
 * Resolves WHAT will run and on which ports — starting nothing.
 *
 * Split out of startServices because the expose layer (tunnels, DNS) needs the
 * port plan BEFORE the services boot, and the services need their public URLs
 * in the environment they boot with.
 */
export async function planServices(
  provider: RuntimeProvider,
  rt: Runtime,
  recipe: NormalizedRecipe,
  remoteDir: string,
): Promise<ServicePlan> {
  if (recipe.mode === "compose") return await planCompose(provider, rt, recipe, remoteDir);
  const publicServices: PublicService[] = Object.entries(recipe.services)
    .filter(([, s]) => s.public && s.port)
    .map(([name, s]) => ({
      name,
      port: s.port!,
      health: s.health,
      healthTimeoutSec: s.healthTimeoutSec,
    }));
  const internalPorts = Object.values(recipe.services)
    .filter((s) => s.port)
    .map((s) => s.port!);
  return { publicServices, internalPorts };
}

/**
 * Starts the recipe's services ON the VM.
 * Idempotent — used by up, resume and reconcile.
 */
export async function startServices(
  provider: RuntimeProvider,
  rt: Runtime,
  recipe: NormalizedRecipe,
  remoteDir: string,
  plan: ServicePlan,
  urls: Record<string, string> = {},
): Promise<void> {
  if (recipe.mode === "compose") return await composeUp(provider, rt, recipe, remoteDir, plan, urls);

  const imageSvcs = Object.entries(recipe.services).filter(([, s]) => s.image);
  const runSvcs = Object.entries(recipe.services).filter(([, s]) => s.run);

  if (imageSvcs.length > 0) {
    log.step(`starting ${imageSvcs.length} image service(s) (docker compose)…`);
    mkdirSync(TMP_DIR, { recursive: true });
    const localCompose = path.join(TMP_DIR, "runo-compose.yaml");
    writeFileSync(localCompose, generatedComposeYaml(recipe));
    await provider.upload(rt, localCompose, REMOTE_COMPOSE);
    const up = await provider.exec(
      rt,
      `docker compose -p runo -f ${shq(REMOTE_COMPOSE)} up -d --remove-orphans`,
      { stream: true, timeoutMs: 10 * 60_000 },
    );
    if (up.exitCode !== 0) throw new RunoError("docker compose up failed for the image services");
    // postgres: wait for real readiness (the published TCP port answers before the db accepts queries)
    for (const [name, svc] of imageSvcs) {
      if (svc.image!.startsWith("postgres")) {
        const wait = await provider.exec(
          rt,
          `timeout 120 bash -c 'until docker exec runo-${name} pg_isready -q 2>/dev/null; do sleep 2; done'`,
          { timeoutMs: 130_000 },
        );
        if (wait.exitCode !== 0)
          throw new RunoError(`Postgres for service "${name}" did not become ready within 120s`);
      }
    }
  }

  for (const [name, svc] of runSvcs) {
    log.step(`starting service "${name}" (tmux): ${svc.run}`);
    // the env's own public URLs are exported too, so a process service can
    // build absolute links without knowing how it was exposed
    const envExports = Object.entries({ ...urlEnv(urls, plan), ...(svc.env ?? {}) })
      .map(([k, v]) => `export ${k}=${shq(v)}; `)
      .join("");
    const inner = `cd ${shq(remoteDir)} && ${envExports}exec ${svc.run}`;
    const wrapped = `bash -lc ${shq(inner)} >> ${REMOTE_RUNO_DIR}/logs/${name}.log 2>&1`;
    const cmd =
      `mkdir -p ${REMOTE_RUNO_DIR}/logs && ` +
      `tmux kill-session -t ${tmuxSession(name)} 2>/dev/null; ` +
      `tmux new-session -d -s ${tmuxSession(name)} ${shq(wrapped)}`;
    const r = await provider.exec(rt, cmd);
    if (r.exitCode !== 0)
      throw new RunoError(`Failed to start service "${name}" via tmux: ${r.stderr.trim()}`);
  }
}

/** RUNO_PUBLIC_URL / RUNO_URL_<SERVICE> for non-compose (process) services. */
function urlEnv(urls: Record<string, string>, plan: ServicePlan): Record<string, string> {
  const out: Record<string, string> = {};
  const primary = plan.publicServices[0]?.name;
  const primaryUrl = (primary && urls[primary]) ?? Object.values(urls)[0];
  if (primaryUrl) {
    out.RUNO_PUBLIC_URL = primaryUrl;
    out.RUNO_PUBLIC_HOST = hostOf(primaryUrl);
  }
  for (const [svc, url] of Object.entries(urls)) {
    out[envVarName("RUNO_URL_", svc)] = url;
    out[envVarName("RUNO_HOST_", svc)] = hostOf(url);
  }
  return out;
}

/** Resolves the effective compose ON the VM and maps public services to ports. */
async function planCompose(
  provider: RuntimeProvider,
  rt: Runtime,
  recipe: NormalizedRecipe,
  remoteDir: string,
): Promise<ServicePlan> {
  const c = recipe.compose!;
  const filesLabel = c.files.join(" + ");
  // interpolation uses the uploaded .env; URLs are not known yet and are not
  // needed to resolve the port map
  const cfg = await provider.exec(rt, `${composePrefix(recipe, rt.ip)} config --format json`, {
    cwd: remoteDir,
    timeoutMs: 120_000,
  });
  if (cfg.exitCode !== 0)
    throw new RunoError(
      `docker compose config failed for ${filesLabel}`,
      cfg.stderr.trim().split("\n").slice(-5).join("\n"),
    );
  let parsed: any;
  try {
    parsed = JSON.parse(cfg.stdout);
  } catch {
    throw new RunoError(`docker compose config output is not valid JSON (${filesLabel})`);
  }

  const services: Record<string, any> = parsed.services ?? {};
  const publishedOf = (svc: any): number[] =>
    (svc?.ports ?? [])
      .map((p: any) => Number(p.published))
      .filter((n: number) => Number.isFinite(n) && n > 0);

  let names = [...c.public];
  if (names.length === 0) {
    const inferred = Object.keys(services).find((n) => publishedOf(services[n]).length > 0);
    if (inferred) {
      log.warn(`recipe has no "public:" — using "${inferred}" as the public service`);
      names = [inferred];
    }
  }
  if (names.length === 0)
    throw new RunoError(
      `No public service resolved from ${filesLabel}`,
      `Set services.compose.public — available services: ${Object.keys(services).join(", ")}`,
    );

  const publicServices: PublicService[] = names.map((name, idx) => {
    if (!services[name])
      throw new RunoError(
        `Public service "${name}" does not exist in the effective compose (${filesLabel})`,
        `Available services: ${Object.keys(services).join(", ")}`,
      );
    const ports = publishedOf(services[name]);
    if (ports.length === 0)
      throw new RunoError(`Public service "${name}" publishes no ports in ${filesLabel}`);
    const primary = idx === 0;
    const port = primary && c.port ? c.port : ports[0]!;
    if (primary && c.port && !ports.includes(c.port))
      log.warn(`public_port ${c.port} is not among ${name}'s published ports — proceeding anyway`);
    // health: only the primary carries the recipe's HTTP path; the others are
    // checked for "answers at all"
    return {
      name,
      port,
      health: primary ? c.health : undefined,
      healthTimeoutSec: primary ? c.healthTimeoutSec : c.healthTimeoutSec,
    };
  });

  // with an explicit public_port, skip sweeping every published port (a
  // shared-netns service can publish dozens; docker-proxy binds them instantly)
  const internalPorts = c.port ? [c.port] : Object.values(services).flatMap((s) => publishedOf(s));
  return { publicServices, internalPorts };
}

async function composeUp(
  provider: RuntimeProvider,
  rt: Runtime,
  recipe: NormalizedRecipe,
  remoteDir: string,
  plan: ServicePlan,
  urls: Record<string, string>,
): Promise<void> {
  const c = recipe.compose!;
  const filesLabel = c.files.join(" + ");
  const prefix = composePrefix(recipe, rt.ip, urls, plan.publicServices[0]?.name);
  log.step(
    `starting the repo's compose (${filesLabel}${c.profiles.length ? `, profiles: ${c.profiles.join(",")}` : ""}) — the first up builds images and can take a while…`,
  );
  const up = await provider.exec(rt, `${prefix} up -d`, {
    cwd: remoteDir,
    stream: true,
    timeoutMs: 45 * 60_000,
  });
  if (up.exitCode !== 0)
    throw new RunoError(
      `docker compose up failed (${filesLabel})`,
      `Check the logs: runo logs — or on the VM: ${filesLabel}`,
    );
}

/** Waits for ports to answer ON the VM (via nc local to the VM). */
export async function waitInternalPorts(
  provider: RuntimeProvider,
  rt: Runtime,
  ports: number[],
): Promise<void> {
  const uniq = [...new Set(ports)];
  for (const port of uniq) {
    const r = await provider.exec(
      rt,
      `timeout 120 bash -c 'until nc -z 127.0.0.1 ${port}; do sleep 2; done'`,
      { timeoutMs: 130_000 },
    );
    if (r.exitCode !== 0)
      throw new RunoError(
        `Port ${port} did not answer on the VM within 120s`,
        "Check the service logs with `runo logs <service>`",
      );
  }
}

/** Does this machine's resolver know the name at all? */
async function resolves(host: string): Promise<boolean> {
  try {
    await lookup(host);
    return true;
  } catch {
    return false;
  }
}

async function tcpOk(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(s) {
          clearTimeout(timer);
          s.end();
          finish(true);
        },
        data() {},
        error() {
          clearTimeout(timer);
          finish(false);
        },
        connectError() {
          clearTimeout(timer);
          finish(false);
        },
        close() {},
      },
    }).catch(() => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

async function httpOk(url: string, timeoutMs = 5000, anyStatus = false): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    // A service with no declared health path only has to prove it is THERE:
    // a 302 to /sign-in or a 404 still means the request reached the app
    // (and, in tunnel mode, that the whole tunnel path works).
    return anyStatus ? res.status < 500 : res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

/** Where to reach a service from outside: its expose URL, else the raw IP. */
function externalTarget(
  svc: PublicService,
  ip: string | null,
  urls: Record<string, string>,
): { url: string | null; label: string; anyStatus: boolean } {
  const base = urls[svc.name];
  const suffix = svc.health ? (svc.health.startsWith("/") ? svc.health : `/${svc.health}`) : "/";
  if (base) return { url: `${base.replace(/\/+$/, "")}${suffix}`, label: `${base}${svc.health ? suffix : ""}`, anyStatus: !svc.health };
  if (!ip) return { url: null, label: `${svc.name} (no address)`, anyStatus: !svc.health };
  if (svc.health) return { url: `http://${ip}:${svc.port}${suffix}`, label: `http://${ip}:${svc.port}${suffix}`, anyStatus: false };
  return { url: null, label: `${ip}:${svc.port} (TCP)`, anyStatus: false }; // TCP probe
}

/**
 * Quick probe: are all public services answering? Used on resume to detect a
 * hot return from hibernation (in which case nothing gets restarted).
 */
export async function probeServices(
  rt: Runtime,
  publicServices: PublicService[],
  urls: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<boolean> {
  if (publicServices.length === 0) return false;
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(publicServices);
  while (Date.now() < deadline && pending.size > 0) {
    for (const svc of [...pending]) {
      const t = externalTarget(svc, rt.ip, urls);
      const ok = t.url
        ? await httpOk(t.url, 4000, t.anyStatus)
        : rt.ip
          ? await tcpOk(rt.ip, svc.port, 4000)
          : false;
      if (ok) pending.delete(svc);
    }
    if (pending.size > 0) await sleep(2000);
  }
  return pending.size === 0;
}

/**
 * Health check executed FROM OUTSIDE (the laptop) — validates SG + service in
 * one shot. Per-service timeout (default 120s); failure fails the up.
 */
export async function healthcheckPublic(
  provider: RuntimeProvider,
  rt: Runtime,
  recipe: NormalizedRecipe,
  remoteDir: string,
  publicServices: PublicService[],
  urls: Record<string, string> = {},
): Promise<void> {
  for (const svc of publicServices) {
    const timeoutSec = svc.healthTimeoutSec ?? 120;
    const t = externalTarget(svc, rt.ip, urls);
    log.step(`external health check for "${svc.name}" → ${t.label} (timeout ${timeoutSec}s)`);
    const deadline = Date.now() + timeoutSec * 1000;
    let ok = false;
    while (Date.now() < deadline && !ok) {
      ok = t.url ? await httpOk(t.url, 5000, t.anyStatus) : await tcpOk(rt.ip!, svc.port);
      if (!ok) await sleep(3000);
    }
    if (!ok) {
      // A tunnel hostname that does not resolve HERE is not a broken env:
      // resolvers routinely blackhole *.trycloudflare.com (quick tunnels are
      // abused for phishing, so filters block the whole zone). Say that
      // instead of dumping app logs that show a perfectly healthy service.
      const exposeUrl = urls[svc.name];
      if (exposeUrl) {
        const host = hostOf(exposeUrl).split("/")[0]!;
        if (!(await resolves(host)))
          throw new RunoError(
            `"${svc.name}" is up on the VM, but ${host} does not resolve from this machine`,
            "Your DNS resolver is blocking the tunnel domain. Check with `dig @1.1.1.1 " +
              host +
              "` — if that answers, use a named tunnel (recipe `expose.domain`) on a domain your network trusts.",
          );
      }
      const tail = await serviceLogTail(provider, rt, recipe, remoteDir, svc.name);
      throw new RunoError(
        `Health check for "${svc.name}" failed after ${timeoutSec}s (${t.label})`,
        tail ? `Last log lines:\n${tail}` : "See `runo logs`",
      );
    }
    log.ok(`"${svc.name}" answering at ${urls[svc.name] ?? `http://${rt.ip}:${svc.port}`}`);
  }
}

async function serviceLogTail(
  provider: RuntimeProvider,
  rt: Runtime,
  recipe: NormalizedRecipe,
  remoteDir: string,
  svcName: string,
): Promise<string> {
  try {
    if (recipe.mode === "compose") {
      const r = await provider.exec(rt, `${composePrefix(recipe, rt.ip)} logs --tail 30 ${shq(svcName)}`, {
        cwd: remoteDir,
        timeoutMs: 30_000,
      });
      return r.stdout.trim();
    }
    const svc = recipe.services[svcName];
    if (svc?.run) {
      const r = await provider.exec(rt, `tail -n 30 ${REMOTE_RUNO_DIR}/logs/${svcName}.log`);
      return r.stdout.trim();
    }
    const r = await provider.exec(rt, `docker logs --tail 30 runo-${svcName} 2>&1`);
    return r.stdout.trim();
  } catch {
    return "";
  }
}

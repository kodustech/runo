import { mkdirSync, writeFileSync } from "node:fs";
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

/** docker compose prefix for passthrough mode (repo's file + profiles). */
export function composePrefix(recipe: NormalizedRecipe): string {
  const c = recipe.compose!;
  const profiles = c.profiles.map((p) => ` --profile ${shq(p)}`).join("");
  return `docker compose -f ${shq(c.file)}${profiles}`;
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
 * Starts the recipe's services ON the VM and returns the port plan.
 * Idempotent — used by up, resume and reconcile.
 */
export async function startServices(
  provider: RuntimeProvider,
  rt: Runtime,
  recipe: NormalizedRecipe,
  remoteDir: string,
): Promise<ServicePlan> {
  if (recipe.mode === "compose") return await startComposePassthrough(provider, rt, recipe, remoteDir);

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
    const envExports = Object.entries(svc.env ?? {})
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

  const publicServices: PublicService[] = Object.entries(recipe.services)
    .filter(([, s]) => s.public && s.port)
    .map(([name, s]) => ({ name, port: s.port!, health: s.health, healthTimeoutSec: s.healthTimeoutSec }));
  const internalPorts = Object.values(recipe.services)
    .filter((s) => s.port)
    .map((s) => s.port!);
  return { publicServices, internalPorts };
}

async function startComposePassthrough(
  provider: RuntimeProvider,
  rt: Runtime,
  recipe: NormalizedRecipe,
  remoteDir: string,
): Promise<ServicePlan> {
  const c = recipe.compose!;
  const prefix = composePrefix(recipe);

  // Resolve the effective compose ON the VM (interpolation uses the uploaded .env)
  const cfg = await provider.exec(rt, `${prefix} config --format json`, {
    cwd: remoteDir,
    timeoutMs: 120_000,
  });
  if (cfg.exitCode !== 0)
    throw new RunoError(
      `docker compose config failed for ${c.file}`,
      cfg.stderr.trim().split("\n").slice(-5).join("\n"),
    );
  let parsed: any;
  try {
    parsed = JSON.parse(cfg.stdout);
  } catch {
    throw new RunoError(`docker compose config output is not valid JSON (${c.file})`);
  }

  const services: Record<string, any> = parsed.services ?? {};
  const publishedOf = (svc: any): number[] =>
    (svc?.ports ?? [])
      .map((p: any) => Number(p.published))
      .filter((n: number) => Number.isFinite(n) && n > 0);

  let publicName = c.public;
  if (!publicName) {
    publicName = Object.keys(services).find((n) => publishedOf(services[n]).length > 0);
    if (publicName) log.warn(`recipe has no "public:" — using "${publicName}" as the public service`);
  }
  if (!publicName || !services[publicName])
    throw new RunoError(
      `Public service "${c.public ?? "?"}" does not exist in the effective compose (${c.file})`,
      `Available services: ${Object.keys(services).join(", ")}`,
    );
  const publicPorts = publishedOf(services[publicName]);
  if (publicPorts.length === 0)
    throw new RunoError(`Public service "${publicName}" publishes no ports in ${c.file}`);
  const publicPort = publicPorts[0]!;

  log.step(`starting the repo's compose (${c.file}${c.profiles.length ? `, profiles: ${c.profiles.join(",")}` : ""}) — the first up builds images and can take a while…`);
  const up = await provider.exec(rt, `${prefix} up -d`, {
    cwd: remoteDir,
    stream: true,
    timeoutMs: 45 * 60_000,
  });
  if (up.exitCode !== 0)
    throw new RunoError(
      `docker compose up failed (${c.file})`,
      `Check the logs: runo logs — or on the VM: ${c.file}`,
    );

  const internalPorts = Object.values(services).flatMap((s) => publishedOf(s));
  return {
    publicServices: [
      { name: publicName, port: publicPort, health: c.health, healthTimeoutSec: c.healthTimeoutSec },
    ],
    internalPorts,
  };
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

async function httpOk(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

/**
 * Quick probe: are all public services answering? Used on resume to detect a
 * hot return from hibernation (in which case nothing gets restarted).
 */
export async function probeServices(
  rt: Runtime,
  publicServices: PublicService[],
  timeoutMs = 20_000,
): Promise<boolean> {
  if (publicServices.length === 0 || !rt.ip) return false;
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(publicServices);
  while (Date.now() < deadline && pending.size > 0) {
    for (const svc of [...pending]) {
      const ok = svc.health
        ? await httpOk(`http://${rt.ip}:${svc.port}${svc.health.startsWith("/") ? svc.health : `/${svc.health}`}`, 4000)
        : await tcpOk(rt.ip, svc.port, 4000);
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
): Promise<void> {
  for (const svc of publicServices) {
    const timeoutSec = svc.healthTimeoutSec ?? 120;
    const target = svc.health
      ? `http://${rt.ip}:${svc.port}${svc.health.startsWith("/") ? svc.health : `/${svc.health}`}`
      : `${rt.ip}:${svc.port} (TCP)`;
    log.step(`external health check for "${svc.name}" → ${target} (timeout ${timeoutSec}s)`);
    const deadline = Date.now() + timeoutSec * 1000;
    let ok = false;
    while (Date.now() < deadline && !ok) {
      ok = svc.health
        ? await httpOk(`http://${rt.ip}:${svc.port}${svc.health.startsWith("/") ? svc.health : `/${svc.health}`}`)
        : await tcpOk(rt.ip!, svc.port);
      if (!ok) await sleep(3000);
    }
    if (!ok) {
      const tail = await serviceLogTail(provider, rt, recipe, remoteDir, svc.name);
      throw new RunoError(
        `Health check for "${svc.name}" failed after ${timeoutSec}s (${target})`,
        tail ? `Last log lines:\n${tail}` : "See `runo logs`",
      );
    }
    log.ok(`"${svc.name}" answering at http://${rt.ip}:${svc.port}`);
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
      const r = await provider.exec(rt, `${composePrefix(recipe)} logs --tail 30 ${shq(svcName)}`, {
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

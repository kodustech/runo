import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { RunoError } from "./errors";

export interface ServiceDef {
  image?: string;
  run?: string;
  port?: number;
  public?: boolean;
  env?: Record<string, string>;
  health?: string;
  healthTimeoutSec?: number; // yaml: health_timeout (default 120)
}

export interface ComposeDef {
  files: string[]; // yaml: file (string) or files (list) — overlay order preserved
  profiles: string[];
  env?: Record<string, string>; // interpolation vars; ${RUNO_PUBLIC_IP} is substituted at up time
  public: string[]; // services whose published ports become public URLs (first = primary)
  port?: number; // yaml: public_port — explicit port for the primary service when it publishes many
  health?: string; // HTTP path on the public service
  healthTimeoutSec?: number; // yaml: health_timeout (default 120; heavy apps need more on first boot)
}

export interface ExposeDef {
  /**
   * How the env is reachable from outside.
   * - "https": Caddy + sslip.io — real certificate on the VM's IP, zero setup
   * - "tunnel": Cloudflare Tunnel — no inbound port at all; add `domain` for a
   *   hostname that survives suspend/resume
   * - "ip": plain http://<ip>:<port>, the original behavior (still the default
   *   for recipes written before expose existed)
   */
  mode: "ip" | "https" | "tunnel";
  /**
   * Zone-owned domain for named tunnels ("preview.acme.com"): the env keeps
   * ONE hostname across suspend/resume, which is what a link in a PR needs.
   * Without it, tunnels are Cloudflare's zero-setup quick tunnels — free and
   * credential-less, but the hostname is random and many corporate resolvers
   * blackhole *.trycloudflare.com.
   */
  domain?: string;
  /** Hostname label under `domain` (default: the env slug). ${RUNO_SLUG} allowed. */
  hostname?: string;
}

export interface NormalizedRecipe {
  version: 1;
  setup: string[];
  filesCopy: string[];
  mode: "services" | "compose";
  services: Record<string, ServiceDef>;
  compose?: ComposeDef;
  data: { migrate?: string; seed?: string };
  validate: { name: string; run: string }[];
  expose: ExposeDef;
  limits: {
    instance: string;
    diskGb: number;
    idleSuspendSec: number; // 0 = auto-suspend off
    idleActivity: IdleSignal[];
    spot: boolean;
  };
}

const RECIPE_REL_PATH = path.join(".kodus", "workspace.yaml");

/** What keeps a VM awake: an SSH session, external traffic, a coding agent using CPU. */
export const IDLE_SIGNALS = ["ssh", "net", "agent"] as const;
export type IdleSignal = (typeof IDLE_SIGNALS)[number];

export function parseRecipe(yamlText: string, source: string): NormalizedRecipe {
  let raw: any;
  try {
    raw = parse(yamlText);
  } catch (e: any) {
    throw new RunoError(`Invalid recipe (${source}): YAML does not parse — ${e.message}`);
  }
  if (!raw || typeof raw !== "object")
    throw new RunoError(`Invalid recipe (${source}): file is empty or not a YAML map`);
  if (raw.version !== 1)
    throw new RunoError(
      `Invalid recipe (${source}): "version: ${raw.version}" is not supported`,
      "This runo only supports version: 1",
    );
  const services = raw.services;
  if (!services || typeof services !== "object" || Object.keys(services).length === 0)
    throw new RunoError(`Invalid recipe (${source}): "services" section missing or empty`);

  const setup: string[] = Array.isArray(raw.setup) ? raw.setup.map(String) : [];
  const filesCopy: string[] = Array.isArray(raw.files?.copy) ? raw.files.copy.map(String) : [];
  const data = {
    migrate: raw.data?.migrate ? String(raw.data.migrate) : undefined,
    seed: raw.data?.seed ? String(raw.data.seed) : undefined,
  };
  const validate: { name: string; run: string }[] = [];
  for (const v of Array.isArray(raw.validate) ? raw.validate : []) {
    if (!v?.name || !v?.run)
      throw new RunoError(`Invalid recipe (${source}): every "validate" item needs name + run`);
    validate.push({ name: String(v.name), run: String(v.run) });
  }

  const diskRaw = String(raw.limits?.disk ?? "30gb");
  const diskMatch = diskRaw.match(/^(\d+)\s*gb$/i);
  if (!diskMatch)
    throw new RunoError(`Invalid recipe (${source}): limits.disk "${diskRaw}" — use e.g. "30gb"`);

  // idle_suspend: "10m" | "2h" | "90s" | "off" (default 10m)
  const idleRaw = String(raw.limits?.idle_suspend ?? "10m").toLowerCase();
  let idleSuspendSec: number;
  if (idleRaw === "off" || idleRaw === "0") idleSuspendSec = 0;
  else {
    const m = idleRaw.match(/^(\d+)\s*(s|m|h)$/);
    if (!m)
      throw new RunoError(
        `Invalid recipe (${source}): limits.idle_suspend "${idleRaw}" — use e.g. "10m", "2h" or "off"`,
      );
    idleSuspendSec = Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1);
  }

  // idle_activity: which signals count as use (default all). A public preview
  // drops "net": bots and its own outbound calls never let it look idle, so
  // the clock runs from the last `runo up` instead.
  const activityRaw = raw.limits?.idle_activity ?? [...IDLE_SIGNALS];
  const idleActivity = (Array.isArray(activityRaw) ? activityRaw : [activityRaw]).map((a: unknown) =>
    String(a).toLowerCase(),
  );
  const unknownSignal = idleActivity.find((a) => !(IDLE_SIGNALS as readonly string[]).includes(a));
  if (unknownSignal !== undefined)
    throw new RunoError(
      `Invalid recipe (${source}): limits.idle_activity "${unknownSignal}" — use any of ${IDLE_SIGNALS.join(", ")}`,
    );

  const exposeMode = String(raw.expose?.mode ?? "ip").toLowerCase();
  if (!["ip", "https", "tunnel"].includes(exposeMode))
    throw new RunoError(
      `Invalid recipe (${source}): expose.mode "${exposeMode}" — use "https", "tunnel" or "ip"`,
    );
  const exposeDomain = raw.expose?.domain ? String(raw.expose.domain).trim() : undefined;
  if (exposeDomain && exposeMode !== "tunnel")
    throw new RunoError(
      `Invalid recipe (${source}): expose.domain requires expose.mode "tunnel"`,
    );
  const expose: ExposeDef = {
    mode: exposeMode as ExposeDef["mode"],
    domain: exposeDomain,
    hostname: raw.expose?.hostname ? String(raw.expose.hostname).trim() : undefined,
  };

  const limits = {
    instance: String(raw.limits?.instance ?? "t3.medium"),
    diskGb: Number(diskMatch[1]),
    idleSuspendSec,
    idleActivity: [...new Set(idleActivity)] as IdleSignal[],
    spot: raw.limits?.spot === true, // ~70% cheaper; interruption becomes "stop" (= suspend)
  };

  // Passthrough mode: services.compose is mutually exclusive with image:/run:
  if ("compose" in services) {
    const others = Object.keys(services).filter((k) => k !== "compose");
    if (others.length > 0)
      throw new RunoError(
        `Invalid recipe (${source}): "services.compose" is mutually exclusive with other services (found: ${others.join(", ")})`,
      );
    const c = services.compose;
    const files: string[] = Array.isArray(c?.files)
      ? c.files.map(String)
      : c?.file
        ? [String(c.file)]
        : [];
    if (files.length === 0)
      throw new RunoError(`Invalid recipe (${source}): services.compose needs "file" or "files"`);
    // public: one service or a list — every entry gets a URL, the first one is
    // the env's primary entry point (runo url prints it first)
    const publicNames: string[] = Array.isArray(c.public)
      ? c.public.map(String)
      : c.public
        ? [String(c.public)]
        : [];
    if (c.public_port !== undefined && publicNames.length > 1)
      throw new RunoError(
        `Invalid recipe (${source}): services.compose.public_port cannot be used with a list of public services`,
        "Each service's published port is resolved from the compose file",
      );
    return {
      version: 1,
      setup,
      filesCopy,
      mode: "compose",
      services: {},
      compose: {
        files,
        profiles: Array.isArray(c.profiles) ? c.profiles.map(String) : [],
        env: c.env
          ? Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, String(v)]))
          : undefined,
        public: publicNames,
        port: c.public_port !== undefined ? Number(c.public_port) : undefined,
        health: c.health ? String(c.health) : undefined,
        healthTimeoutSec: c.health_timeout !== undefined ? Number(c.health_timeout) : undefined,
      },
      data,
      validate,
      expose,
      limits,
    };
  }

  const normalized: Record<string, ServiceDef> = {};
  for (const [name, def] of Object.entries<any>(services)) {
    const hasImage = typeof def?.image === "string";
    const hasRun = typeof def?.run === "string";
    if (hasImage === hasRun)
      throw new RunoError(
        `Invalid recipe (${source}): service "${name}" needs exactly one of "image" or "run"`,
      );
    const svc: ServiceDef = {
      image: hasImage ? String(def.image) : undefined,
      run: hasRun ? String(def.run) : undefined,
      port: def.port !== undefined ? Number(def.port) : undefined,
      public: def.public === true,
      env: def.env
        ? Object.fromEntries(Object.entries(def.env).map(([k, v]) => [k, String(v)]))
        : undefined,
      health: def.health ? String(def.health) : undefined,
      healthTimeoutSec: def.health_timeout !== undefined ? Number(def.health_timeout) : undefined,
    };
    if (svc.public && !svc.port)
      throw new RunoError(`Invalid recipe (${source}): public service "${name}" needs "port"`);
    if (svc.health && !svc.port)
      throw new RunoError(`Invalid recipe (${source}): "health" on service "${name}" requires "port"`);
    normalized[name] = svc;
  }

  return {
    version: 1,
    setup,
    filesCopy,
    mode: "services",
    services: normalized,
    data,
    validate,
    expose,
    limits,
  };
}

/**
 * Which recipe files to try, in order. One repo can describe more than one
 * kind of environment — a developer box and a PR preview are not the same
 * machine — so `--recipe` (RUNO_RECIPE) picks the shape without touching the
 * default. A `--profile` (RUNO_PROFILE) without an explicit recipe looks for
 * `.kodus/workspace.<profile>.yaml` first and falls back to the default, so a
 * profile that only changes the compose overlay does not need its own file.
 */
export function recipeCandidates(remembered?: string): string[] {
  const override = process.env.RUNO_RECIPE?.trim();
  if (override) return [override];
  if (remembered) return [remembered];
  const profile = process.env.RUNO_PROFILE?.trim();
  return profile ? [`.kodus/workspace.${profile}.yaml`, RECIPE_REL_PATH] : [RECIPE_REL_PATH];
}

/** Loads the recipe from the first directory that has it. */
export function loadRecipe(...dirs: string[]): { recipe: NormalizedRecipe; path: string } {
  return loadRecipeFrom(undefined, dirs);
}

/**
 * Same, for a caller that knows which recipe this env was built from (the
 * registry records it): a later `push`/`url` must not silently fall back to
 * the default recipe and reconcile the env with a different shape.
 * An explicit --recipe still wins.
 */
export function loadRecipeFrom(
  remembered: string | undefined,
  dirs: string[],
): { recipe: NormalizedRecipe; path: string } {
  const candidates = recipeCandidates(remembered);
  for (const rel of candidates) {
    if (path.isAbsolute(rel)) {
      if (!existsSync(rel)) throw new RunoError(`Recipe not found: ${rel}`);
      return { recipe: parseRecipe(readFileSync(rel, "utf8"), rel), path: rel };
    }
    for (const dir of dirs) {
      const p = path.join(dir, rel);
      if (existsSync(p)) return { recipe: parseRecipe(readFileSync(p, "utf8"), p), path: p };
    }
  }
  throw new RunoError(
    `No recipe found (${candidates.join(" or ")}) in: ${dirs.join(", ")}`,
    process.env.RUNO_RECIPE
      ? "Check the --recipe path (it is relative to the repo root)"
      : "Run `runo init` at the repo root to generate a proposal",
  );
}

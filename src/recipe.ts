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
  file: string;
  profiles: string[];
  public?: string; // nome do serviço cuja porta publicada vira a URL pública
  health?: string; // path HTTP no serviço público
  healthTimeoutSec?: number; // yaml: health_timeout (default 120; apps pesados no 1º boot precisam de mais)
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
  limits: { instance: string; diskGb: number; idleSuspendSec: number; spot: boolean }; // idle 0 = auto-suspend off
}

const RECIPE_REL_PATH = path.join(".kodus", "workspace.yaml");

export function parseRecipe(yamlText: string, source: string): NormalizedRecipe {
  let raw: any;
  try {
    raw = parse(yamlText);
  } catch (e: any) {
    throw new RunoError(`Recipe inválida (${source}): YAML não parseia — ${e.message}`);
  }
  if (!raw || typeof raw !== "object")
    throw new RunoError(`Recipe inválida (${source}): arquivo vazio ou não é um mapa YAML`);
  if (raw.version !== 1)
    throw new RunoError(
      `Recipe inválida (${source}): "version: ${raw.version}" não suportada`,
      "Este runo suporta apenas version: 1",
    );
  const services = raw.services;
  if (!services || typeof services !== "object" || Object.keys(services).length === 0)
    throw new RunoError(`Recipe inválida (${source}): seção "services" ausente ou vazia`);

  const setup: string[] = Array.isArray(raw.setup) ? raw.setup.map(String) : [];
  const filesCopy: string[] = Array.isArray(raw.files?.copy) ? raw.files.copy.map(String) : [];
  const data = {
    migrate: raw.data?.migrate ? String(raw.data.migrate) : undefined,
    seed: raw.data?.seed ? String(raw.data.seed) : undefined,
  };
  const validate: { name: string; run: string }[] = [];
  for (const v of Array.isArray(raw.validate) ? raw.validate : []) {
    if (!v?.name || !v?.run)
      throw new RunoError(`Recipe inválida (${source}): cada item de "validate" precisa de name + run`);
    validate.push({ name: String(v.name), run: String(v.run) });
  }

  const diskRaw = String(raw.limits?.disk ?? "30gb");
  const diskMatch = diskRaw.match(/^(\d+)\s*gb$/i);
  if (!diskMatch)
    throw new RunoError(`Recipe inválida (${source}): limits.disk "${diskRaw}" — use ex.: "30gb"`);

  // idle_suspend: "10m" | "2h" | "90s" | "off" (default 10m — PLAN §3.3)
  const idleRaw = String(raw.limits?.idle_suspend ?? "10m").toLowerCase();
  let idleSuspendSec: number;
  if (idleRaw === "off" || idleRaw === "0") idleSuspendSec = 0;
  else {
    const m = idleRaw.match(/^(\d+)\s*(s|m|h)$/);
    if (!m)
      throw new RunoError(
        `Recipe inválida (${source}): limits.idle_suspend "${idleRaw}" — use ex.: "10m", "2h" ou "off"`,
      );
    idleSuspendSec = Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1);
  }

  const limits = {
    instance: String(raw.limits?.instance ?? "t3.medium"),
    diskGb: Number(diskMatch[1]),
    idleSuspendSec,
    spot: raw.limits?.spot === true, // ~70% mais barato; interrupção vira "stop" (= suspend)
  };

  // Modo passthrough: services.compose é mutuamente exclusivo com image:/run:
  if ("compose" in services) {
    const others = Object.keys(services).filter((k) => k !== "compose");
    if (others.length > 0)
      throw new RunoError(
        `Recipe inválida (${source}): "services.compose" é mutuamente exclusivo com outros serviços (encontrado: ${others.join(", ")})`,
      );
    const c = services.compose;
    if (!c?.file)
      throw new RunoError(`Recipe inválida (${source}): services.compose.file é obrigatório`);
    return {
      version: 1,
      setup,
      filesCopy,
      mode: "compose",
      services: {},
      compose: {
        file: String(c.file),
        profiles: Array.isArray(c.profiles) ? c.profiles.map(String) : [],
        public: c.public ? String(c.public) : undefined,
        health: c.health ? String(c.health) : undefined,
        healthTimeoutSec: c.health_timeout !== undefined ? Number(c.health_timeout) : undefined,
      },
      data,
      validate,
      limits,
    };
  }

  const normalized: Record<string, ServiceDef> = {};
  for (const [name, def] of Object.entries<any>(services)) {
    const hasImage = typeof def?.image === "string";
    const hasRun = typeof def?.run === "string";
    if (hasImage === hasRun)
      throw new RunoError(
        `Recipe inválida (${source}): serviço "${name}" precisa de exatamente um de "image" ou "run"`,
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
      throw new RunoError(`Recipe inválida (${source}): serviço público "${name}" precisa de "port"`);
    if (svc.health && !svc.port)
      throw new RunoError(`Recipe inválida (${source}): "health" no serviço "${name}" exige "port"`);
    normalized[name] = svc;
  }

  return { version: 1, setup, filesCopy, mode: "services", services: normalized, data, validate, limits };
}

/** Carrega a recipe do primeiro diretório que tiver .kodus/workspace.yaml. */
export function loadRecipe(...dirs: string[]): { recipe: NormalizedRecipe; path: string } {
  for (const dir of dirs) {
    const p = path.join(dir, RECIPE_REL_PATH);
    if (existsSync(p)) return { recipe: parseRecipe(readFileSync(p, "utf8"), p), path: p };
  }
  throw new RunoError(
    `Nenhuma recipe encontrada (${RECIPE_REL_PATH}) em: ${dirs.join(", ")}`,
    "Rode `runo init` na raiz do repo para gerar uma proposta",
  );
}

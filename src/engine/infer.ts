import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";

/**
 * `runo init` inference: inspects the repo and proposes .kodus/workspace.yaml.
 * Simple, transparent heuristics — the dev reviews before the first up.
 */

const COMPOSE_CANDIDATES = [
  "docker-compose.dev.yml",
  "docker-compose.dev.yaml",
  "compose.dev.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yaml",
];

// cheaper suites first — the full suite is usually too heavy for the loop
const TEST_PREFERENCE = ["test:unit", "test:rbac", "test:fast", "test:quick", "test"];
const MIGRATE_PREFERENCE = ["migration:run", "db:migrate", "migrate:run", "migrate"];
const SEED_PREFERENCE = ["db:seed", "seed"];

function detectPm(repo: string): string {
  if (existsSync(path.join(repo, "bun.lock")) || existsSync(path.join(repo, "bun.lockb"))) return "bun";
  if (existsSync(path.join(repo, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(repo, "yarn.lock"))) return "yarn";
  try {
    const scripts: Record<string, string> =
      JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).scripts ?? {};
    if (Object.values(scripts).some((s) => /^bun( |$)/.test(s))) return "bun";
  } catch {}
  return "npm";
}

function pickScript(scripts: Record<string, string>, prefs: string[]): string | undefined {
  return prefs.find((p) => scripts[p]);
}

export function inferRecipe(repoPath: string): { yaml: string; notes: string[] } {
  const notes: string[] = [];
  const pm = detectPm(repoPath);
  let scripts: Record<string, string> = {};
  try {
    scripts = JSON.parse(readFileSync(path.join(repoPath, "package.json"), "utf8")).scripts ?? {};
  } catch {
    notes.push("package.json missing/unreadable — minimal recipe proposed, review by hand");
  }

  const runScript = (name: string) => `${pm} run ${name}`;
  const doc: any = { version: 1, setup: [`${pm} install`] };

  if (existsSync(path.join(repoPath, ".env"))) doc.files = { copy: [".env"] };

  const composeFile = COMPOSE_CANDIDATES.find((f) => existsSync(path.join(repoPath, f)));
  let heavy = false;

  if (composeFile) {
    // ---- passthrough mode: the repo's compose runs as-is on the VM ----
    let composeDoc: any = {};
    try {
      composeDoc = parse(readFileSync(path.join(repoPath, composeFile), "utf8")) ?? {};
    } catch {
      notes.push(`${composeFile} did not parse — passthrough proposed without service inspection`);
    }
    const services: Record<string, any> = composeDoc.services ?? {};
    const names = Object.keys(services);
    heavy = names.length >= 5 || pm === "pnpm";

    const allProfiles = new Set<string>();
    for (const s of Object.values(services))
      for (const p of (s as any)?.profiles ?? []) allProfiles.add(p);
    // prefer a "local*" profile (e.g. local-db); without one, the compose's
    // profile-less services are already the default environment
    const profile =
      [...allProfiles].find((p) => p === "local-db") ??
      [...allProfiles].find((p) => p.includes("local"));
    if (!profile && allProfiles.size > 0)
      notes.push(
        `compose has profiles (${[...allProfiles].join(", ")}) but no "local*" one — starting only the default services`,
      );

    const activeNames = names.filter((n) => {
      const profs: string[] = services[n]?.profiles ?? [];
      return profs.length === 0 || (profile ? profs.includes(profile) : false);
    });
    const hasPorts = (n: string) => (services[n]?.ports ?? []).length > 0;
    const publicSvc =
      activeNames.find((n) => n.includes("api") && hasPorts(n)) ??
      activeNames.find((n) => hasPorts(n) && services[n]?.build) ??
      activeNames.find(hasPorts);
    if (!publicSvc) notes.push("no service publishes a port — set `public:` by hand");

    doc.services = {
      compose: {
        file: composeFile,
        ...(profile ? { profiles: [profile] } : {}),
        ...(publicSvc ? { public: publicSvc } : {}),
      },
    };
  } else {
    // ---- services mode: the app runs directly on the VM ----
    const dev = ["dev", "start:dev", "serve", "start"].find((s) => scripts[s]);
    const app: any = { run: dev ? runScript(dev) : "echo 'set your app command'", port: 3000, public: true };
    if (!dev) notes.push("no dev/start script — set services.app.run by hand");
    notes.push("port 3000 assumed — adjust services.app.port if the app uses another one");
    doc.services = { app };
    let deps: Record<string, string> = {};
    try {
      const pkg = JSON.parse(readFileSync(path.join(repoPath, "package.json"), "utf8"));
      deps = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {}
    const usesPg =
      Boolean(deps["pg"] || deps["postgres"] || deps["typeorm"] || deps["prisma"] || deps["drizzle-orm"]) ||
      scripts["db:migrate"] !== undefined;
    if (usesPg)
      doc.services = {
        db: { image: "postgres:16", port: 5432, env: { POSTGRES_PASSWORD: "runo" } },
        app,
      };
  }

  const migrate = pickScript(scripts, MIGRATE_PREFERENCE);
  const seed = pickScript(scripts, SEED_PREFERENCE);
  if (migrate || seed)
    doc.data = {
      ...(migrate ? { migrate: runScript(migrate) } : {}),
      ...(seed ? { seed: runScript(seed) } : {}),
    };

  const validate: any[] = [];
  if (scripts["lint"]) validate.push({ name: "lint", run: runScript("lint") });
  const test = pickScript(scripts, TEST_PREFERENCE);
  if (test) validate.push({ name: test.replace(/:/g, "-"), run: runScript(test) });
  if (validate.length > 0) doc.validate = validate;

  doc.limits = heavy
    ? { instance: "t3.xlarge", disk: "100gb" }
    : { instance: "t3.medium", disk: "30gb" };
  if (heavy) notes.push("heavy repo (monorepo/large compose) — t3.xlarge + 100gb proposed");

  const header =
    "# Generated by `runo init` — review before the first `runo up`.\n" +
    "# Schema docs: https://github.com/kodustech/runo\n";
  return { yaml: header + stringify(doc), notes };
}

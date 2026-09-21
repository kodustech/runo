/**
 * runo-server — control plane v0.
 *
 * Holds the AWS credentials, the SSH keys and the provider; devs authenticate
 * with a bearer token and the CLI talks HTTP/WS. Zero cloud credentials on
 * developer laptops.
 *
 * Run (on a machine/instance that has AWS credentials):
 *   RUNO_HOME=~/.runo-server \
 *   RUNO_SERVER_TOKENS="alice:tok1,bob:tok2" \
 *   bun server/main.ts [--port 7777]
 *
 * Single process. server-envs.json is the live registry; server.db (SQLite)
 * is history, users, sessions and tokens. People log into the panel with
 * GitHub OAuth (see docs/control-plane-panel.md). Put TLS in front
 * (ALB/caddy/tailscale) before exposing beyond localhost/VPN.
 */
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { AWS_REGION, RUNO_HOME } from "../src/config";
import { RunoError } from "../src/errors";
import { log } from "../src/log";
import { Ec2Provider } from "../src/provider/aws";
import type { CreateSpec, ExecOpts, Runtime } from "../src/provider/types";
import { enforceCreate, loadPolicies } from "./policies";
import { AccessDenied, canAccess, requireAccess } from "./access";
import { Auth, authConfigFromEnv, ReauthRequired, readCookie, safeEqual, sessionMayCall, SESSION_RPC, Throttle, type Identity } from "./auth";
import { handlePanelApi } from "./panelApi";
import { Store } from "./store";
import { sampleFleet } from "./usage";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.RUNO_SERVER_PORT || argValue("--port") || 7777);
const provider = new Ec2Provider();

// ---------- auth ----------

mkdirSync(RUNO_HOME, { recursive: true });
const store = new Store(path.join(RUNO_HOME, "server.db"));
let auth: Auth;
try {
  auth = new Auth(authConfigFromEnv(process.env), store);
} catch (e: any) {
  console.error(e.message + (e.hint ? `\n  ${e.hint}` : ""));
  process.exit(1);
}
if (auth.config.envTokens.size === 0 && !auth.config.github && store.liveTokenCount() === 0) {
  console.error(
    "Nobody could log in: set RUNO_SERVER_TOKENS (format: \"alice:token1,bob:token2\") and/or GitHub login (RUNO_GITHUB_CLIENT_ID, RUNO_GITHUB_CLIENT_SECRET, RUNO_GITHUB_ALLOWED_ORGS, RUNO_PUBLIC_URL)",
  );
  process.exit(1);
}
const loginThrottle = new Throttle();

// ---------- server-side env registry (the platform team's view) ----------

interface ServerEnv {
  envName: string;
  slug: string;
  owner: string;
  repo: string;
  branch: string;
  instanceId: string;
  instanceType: string;
  spot: boolean;
  createdAt: string;
  members?: string[];
  recipe?: string;
  urls?: Record<string, string>;
  /** filled by /v1/register-services once the env's pipeline finishes */
  services?: { name: string; port: number }[];
}

const ENVS_PATH = path.join(RUNO_HOME, "server-envs.json");

function loadEnvs(): Record<string, ServerEnv> {
  try {
    return JSON.parse(readFileSync(ENVS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveEnvs(envs: Record<string, ServerEnv>): void {
  mkdirSync(RUNO_HOME, { recursive: true });
  writeFileSync(ENVS_PATH, JSON.stringify(envs, null, 2) + "\n");
}

// ---------- helpers ----------

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errResponse(e: any): Response {
  if (e instanceof ReauthRequired) return json({ error: { message: e.message, code: "reauth" } }, 401);
  if (e instanceof AccessDenied) return json({ error: { message: e.message } }, 403);
  if (e instanceof RunoError) return json({ error: { message: e.message, hint: e.hint } }, 400);
  return json({ error: { message: e?.message ?? String(e) } }, 500);
}

/** RPC methods the CLI may call 1:1 on the provider. */
const RPC_ALLOWED = new Set([
  "preflight",
  "create",
  "waitReady",
  "status",
  "suspend",
  "resume",
  "destroy",
  "ensurePorts",
  "listManaged",
  "poolStatus",
  "poolScale",
  "prepareBootImage",
  "removeBootImage",
]);

async function handleRpc(who: Identity, body: any): Promise<Response> {
  const user = who.user;
  const { method, args = [] } = body;
  if (!RPC_ALLOWED.has(method)) return json({ error: { message: `unknown method: ${method}` } }, 400);
  if (who.via === "session" && !SESSION_RPC.has(method))
    throw new AccessDenied("This operation needs a CLI token, not a browser session");
  const envsBefore = Object.values(loadEnvs());
  let target: ServerEnv | undefined;
  if (["waitReady", "status", "suspend", "resume", "destroy"].includes(method)) {
    // admins manage any machine's lifecycle (cost control) but waitReady execs on the VM
    target = requireAccess(user, args[0]?.id, envsBefore, method !== "status", who.admin && method !== "waitReady");
    args[0] = await provider.status({ id: target.instanceId, ip: null, state: "unknown" });
  }
  if (["poolScale", "prepareBootImage", "removeBootImage", "ensurePorts"].includes(method) && !who.admin)
    throw new AccessDenied("This operation requires an admin");
  if (method === "listManaged") {
    const visible = envsBefore.filter(e => canAccess(user, e));
    return json({ result: await Promise.all(visible.map(e => provider.status({ id: e.instanceId, ip: null, state: "unknown" }))) });
  }

  // org policies: enforced at the boundary devs use, before touching the cloud
  if (method === "create") {
    const pol = loadPolicies();
    const spec = args[0] as CreateSpec;
    if (envsBefore.some(e => e.envName === spec.envName || (e.repo === spec.repo && e.branch === spec.branch)))
      throw new RunoError("Environment already exists; attach to it first");
    const userEnvCount = Object.values(loadEnvs()).filter((e) => e.owner === user).length;
    let runningTotal = 0;
    if (pol.max_running_total !== undefined)
      runningTotal = (await provider.listManaged()).filter(
        (m) => m.state === "running" || m.state === "pending",
      ).length;
    enforceCreate(pol, spec, { user, userEnvCount, runningTotal });
  }

  const startedAt = Date.now();
  const result = await (provider as any)[method](...args);

  // bookkeeping for the platform view
  if (method === "suspend" || method === "resume") {
    store.addEvent({ actor: user, action: method, envName: target!.envName, instanceId: target!.instanceId });
    void sampleNow();
  }
  if (method === "poolScale") store.addEvent({ actor: user, action: "pool.scale", detail: { target: args[0] } });
  if (method === "create") {
    const spec = args[0];
    const rt = result as Runtime;
    store.addMachine({
      instanceId: rt.id, envName: spec.envName, slug: spec.slug, owner: user, repo: spec.repo, branch: spec.branch,
      instanceType: rt.instanceType ?? spec.instanceType, spot: Boolean(spec.spot), diskGb: spec.diskGb, createdAt: startedAt,
    });
    store.openRun(rt.id, startedAt);
    store.addEvent({
      actor: user, action: "create", envName: spec.envName, instanceId: rt.id,
      detail: { repo: spec.repo, branch: spec.branch, instanceType: rt.instanceType ?? spec.instanceType, diskGb: spec.diskGb, spot: Boolean(spec.spot) },
    });
    const envs = loadEnvs();
    envs[spec.envName] = {
      envName: spec.envName,
      slug: spec.slug,
      owner: user,
      repo: spec.repo,
      branch: spec.branch,
      instanceId: rt.id,
      instanceType: rt.instanceType ?? spec.instanceType,
      spot: Boolean(spec.spot),
      createdAt: new Date().toISOString(),
    };
    saveEnvs(envs);
    log.step(`[${user}] created ${spec.envName} (${rt.id})`);
  }
  if (method === "destroy") {
    const rt = args[0] as Runtime;
    const envs = loadEnvs();
    for (const [name, e] of Object.entries(envs)) if (e.instanceId === rt.id) delete envs[name];
    saveEnvs(envs);
    store.endMachine(rt.id, user, "destroy");
    store.addEvent({ actor: user, action: "destroy", envName: target!.envName, instanceId: rt.id });
    log.step(`[${user}] destroyed ${rt.name ?? rt.id}`);
  }
  return json({ result: result ?? null });
}

// ---------- streaming exec ----------

async function handleExec(user: string, body: any): Promise<Response> {
  const { command, opts = {} } = body as { command: string; opts: ExecOpts };
  const rt = await authorizedRuntime(user, body.rt);
  if (!opts.stream) {
    const result = await provider.exec(rt, command, { ...opts, stream: false });
    return json({ result });
  }
  // ndjson stream: {t:"out"|"err",d} ... {t:"exit",code}
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      try {
        const code = await provider.execStream(rt, command, opts, send);
        send({ t: "exit", code });
      } catch (e: any) {
        send({ t: "err", d: `${e?.message ?? e}\n` });
        send({ t: "exit", code: 1 });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
}

// ---------- upload / download (tar over HTTP) ----------

async function authorizedRuntime(user: string, requested: Runtime): Promise<Runtime> {
  const env = requireAccess(user, requested?.id, Object.values(loadEnvs()));
  // Resolve the address ourselves: never SSH to a client-supplied host.
  return provider.status({ id: env.instanceId, ip: null, state: "unknown" });
}

async function handleUpload(user: string, req: Request, url: URL): Promise<Response> {
  const rt = await authorizedRuntime(user, JSON.parse(url.searchParams.get("rt")!));
  const remotePath = url.searchParams.get("path")!;
  const tmpRoot = path.join(RUNO_HOME, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(path.join(tmpRoot, "upload-"));
  const tmp = path.join(dir, "payload");
  try {
    if (!req.body) throw new RunoError("Upload body is required");
    await pipeline(Readable.fromWeb(req.body as any), createWriteStream(tmp, { mode: 0o600 }));
    await provider.upload(rt, tmp, remotePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return json({ result: null });
}

async function handleDownload(user: string, req: Request): Promise<Response> {
  const { rt: requested, remotePath, excludes = [] } = (await req.json()) as {
    rt: Runtime;
    remotePath: string;
    excludes: string[];
  };
  const rt = await authorizedRuntime(user, requested);
  // tar the remote path (dir/ → its contents; otherwise dirname + basename glob)
  const isDir = remotePath.endsWith("/");
  const base = isDir ? remotePath : path.posix.dirname(remotePath);
  const items = isDir ? "." : path.posix.basename(remotePath);
  const ex = excludes.map((e) => `--exclude=${e}`).join(" ");
  const cmd = `cd ${JSON.stringify(base)} && tar -czf - ${ex} ${items}`;

  const stream = new ReadableStream({
    async start(controller) {
      const code = await provider.execStreamRaw(rt, cmd, (chunk) => controller.enqueue(chunk));
      if (code !== 0) controller.error(new Error(`remote tar failed (exit ${code})`));
      else controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/gzip" } });
}

// ---------- ingress: one hostname per env ----------
//
// RUNO_INGRESS_DOMAIN=envs.example.com + wildcard DNS (*.envs.example.com →
// this server) gives every env a URL: http://<slug>.envs.example.com[:port].
// Extra services: http://<service>--<slug>.envs.example.com (single label —
// wildcard-cert friendly). v0 is HTTP proxying only (no WebSocket upgrade);
// terminate TLS in front (Caddy/ALB/Cloudflare).

const INGRESS_DOMAIN = (process.env.RUNO_INGRESS_DOMAIN ?? "").toLowerCase() || null;
const ipCache = new Map<string, { ip: string | null; state: string; ts: number }>();

async function envAddress(instanceId: string): Promise<{ ip: string | null; state: string }> {
  const hit = ipCache.get(instanceId);
  if (hit && Date.now() - hit.ts < 15_000) return hit;
  const rt = await provider.status({ id: instanceId, ip: null, state: "unknown" });
  const entry = { ip: rt.ip, state: rt.state, ts: Date.now() };
  ipCache.set(instanceId, entry);
  return entry;
}

function ingressUrlFor(e: ServerEnv): string | null {
  if (!INGRESS_DOMAIN || !e.services?.length) return null;
  return `http://${e.slug}.${INGRESS_DOMAIN}:${PORT}`;
}

async function handleIngress(req: Request, hostname: string): Promise<Response> {
  const label = hostname.slice(0, hostname.length - (INGRESS_DOMAIN!.length + 1));
  let svcName: string | undefined;
  let slug = label;
  const sep = label.indexOf("--");
  if (sep > 0) {
    svcName = label.slice(0, sep);
    slug = label.slice(sep + 2);
  }
  const env = Object.values(loadEnvs()).find((e) => e.slug === slug);
  if (!env) return new Response(`no environment for "${slug}"`, { status: 404 });
  const services = env.services ?? [];
  const svc = svcName ? services.find((s) => s.name === svcName) : services[0];
  if (!svc)
    return new Response(`environment "${slug}" has no ${svcName ? `service "${svcName}"` : "registered services"}`, {
      status: 404,
    });
  const addr = await envAddress(env.instanceId);
  if (addr.state !== "running" || !addr.ip)
    return new Response(
      `environment "${slug}" is ${addr.state} — resume it with: runo resume`,
      { status: 503 },
    );
  const url = new URL(req.url);
  const target = `http://${addr.ip}:${svc.port}${url.pathname}${url.search}`;
  const headers = new Headers(req.headers);
  headers.set("host", `${addr.ip}:${svc.port}`);
  headers.set("x-forwarded-host", hostname);
  headers.set("x-forwarded-proto", "http");
  try {
    const res = await fetch(target, {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch (e: any) {
    return new Response(`upstream unreachable (${e?.message ?? e})`, { status: 502 });
  }
}

// ---------- web panel + login ----------

const PANEL_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};
// no inline script, no third-party origin: an XSS in the panel has nowhere to load code from
const PANEL_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://avatars.githubusercontent.com; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};
const TOO_MANY = { error: { message: "too many failed logins — wait a few minutes" } };

/** Behind the local reverse proxy (Caddy) the peer is loopback; the proxy appends the real client last. */
function clientAddress(req: Request, srv: { requestIP(req: Request): { address: string } | null }): string {
  const peer = srv.requestIP(req)?.address ?? "unknown";
  const forwarded = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  return forwarded && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) ? forwarded : peer;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

async function handleAuth(req: Request, url: URL, client: string): Promise<Response> {
  if (url.pathname === "/auth/config" && req.method === "GET")
    return json({ result: { github: Boolean(auth.config.github), githubUrl: auth.config.github?.url ?? null } });

  if (url.pathname === "/auth/github" && req.method === "GET") {
    if (!auth.config.github) return json({ error: { message: "GitHub login is not configured" } }, 404);
    const state = randomBytes(24).toString("base64url");
    return redirect(auth.githubAuthorizeUrl(state), [auth.cookie(auth.stateCookie, state, 600)]);
  }

  if (url.pathname === "/auth/github/callback" && req.method === "GET") {
    if (!auth.config.github) return json({ error: { message: "GitHub login is not configured" } }, 404);
    const clearState = auth.cookie(auth.stateCookie, "", 0);
    const fail = (message: string) => redirect(`/#login-error=${encodeURIComponent(message)}`, [clearState]);
    const expected = readCookie(req, auth.stateCookie);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    // the state cookie binds the callback to the browser that started the login
    if (!expected || !state || !code || !safeEqual(expected, state)) return fail("Login expired — try again");
    try {
      const profile = await auth.githubLogin(code);
      // a service account must not be claimable by registering its name on GitHub
      if ((store.user(profile.login)?.source ?? "github") !== "github")
        return fail(`@${profile.login} collides with a service account on this server`);
      store.upsertUser({
        login: profile.login, source: "github", name: profile.name, avatar: profile.avatar, loggedIn: true,
        role: auth.config.envAdmins.includes(profile.login) ? "admin" : "member",
      });
      if (store.user(profile.login)!.disabled) return fail(`@${profile.login} is disabled on this server`);
      store.addEvent({ actor: profile.login, action: "login", detail: { via: "github", from: client } });
      return redirect("/", [clearState, auth.startSession(profile.login)]);
    } catch (e: any) {
      log.warn(`github login refused: ${e?.message ?? e}`);
      return fail(e instanceof RunoError ? e.message : "GitHub login failed");
    }
  }

  // token -> session: the panel never keeps a token in the browser's storage
  if (url.pathname === "/auth/token" && req.method === "POST") {
    if (loginThrottle.blocked(client)) return json(TOO_MANY, 429);
    if (!auth.csrfOk(req, url)) return json({ error: { message: "forbidden" } }, 403);
    const { token } = (await req.json()) as { token?: string };
    const who = typeof token === "string" && token ? auth.fromToken(token.trim()) : null;
    if (!who) {
      loginThrottle.fail(client);
      return json({ error: { message: "invalid token" } }, 401);
    }
    store.addEvent({ actor: who.user, action: "login", detail: { via: "token", from: client } });
    return new Response(JSON.stringify({ result: { user: who.user } }), {
      headers: { "content-type": "application/json", "set-cookie": auth.startSession(who.user) },
    });
  }

  if (url.pathname === "/auth/logout" && req.method === "POST") {
    if (!auth.csrfOk(req, url)) return json({ error: { message: "forbidden" } }, 403);
    return new Response(JSON.stringify({ result: null }), {
      headers: { "content-type": "application/json", "set-cookie": auth.endSession(req) },
    });
  }
  return json({ error: { message: "not found" } }, 404);
}

// ---------- fleet sampler (history, cost, peaks) ----------

let sampling = false;
async function sampleNow(): Promise<void> {
  if (sampling) return;
  sampling = true;
  try {
    await sampleFleet(store, await provider.listManaged(), Object.values(loadEnvs()), async (id) => {
      const rt = await provider.status({ id, ip: null, state: "unknown" });
      return rt.state === "terminated" || rt.state === "shutting-down";
    });
  } catch (e: any) {
    log.warn(`fleet sample failed: ${e?.message ?? e}`);
  } finally {
    sampling = false;
  }
}

// ---------- websocket tty (experimental) ----------

interface TtyData {
  proc: ReturnType<typeof Bun.spawn>;
}

if (process.env.RUNO_EXPECTED_AWS_ARN || process.env.RUNO_EXPECTED_AWS_REGION)
  await provider.preflight();

const server = Bun.serve<TtyData>({
  port: PORT,
  hostname: process.env.RUNO_SERVER_HOST ?? "127.0.0.1",
  maxRequestBodySize: 1024 * 1024 * 1024,
  idleTimeout: 0,
  async fetch(req, srv) {
    const url = new URL(req.url);
    // ingress: requests addressed to <slug>.<INGRESS_DOMAIN> are proxied to the env
    const reqHostname = (req.headers.get("host") ?? "").split(":")[0].toLowerCase();
    if (INGRESS_DOMAIN && reqHostname.endsWith("." + INGRESS_DOMAIN)) {
      try {
        return await handleIngress(req, reqHostname);
      } catch (e) {
        return errResponse(e);
      }
    }
    // web panel: static files, the data itself still requires a session or token
    const asset = req.method === "GET" || req.method === "HEAD" ? PANEL_FILES[url.pathname] : undefined;
    if (asset) {
      const body = readFileSync(new URL(`./panel/${asset.file}`, import.meta.url).pathname);
      return new Response(body, { headers: { "content-type": asset.type, "cache-control": "no-cache", ...PANEL_HEADERS } });
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    const client = clientAddress(req, srv);
    if (url.pathname.startsWith("/auth/")) {
      try {
        return await handleAuth(req, url, client);
      } catch (e) {
        return errResponse(e);
      }
    }

    // guessing is only worth throttling where the secret may be human-chosen (RUNO_SERVER_TOKENS)
    const presentsToken = req.headers.has("authorization") || url.searchParams.has("token");
    if (presentsToken && loginThrottle.blocked(client)) return json(TOO_MANY, 429);
    const who = auth.identify(req, url);
    if (!who) {
      if (presentsToken) loginThrottle.fail(client);
      return json({ error: { message: "unauthorized" } }, 401);
    }
    if (who.via === "session" && (!sessionMayCall(url.pathname) || !auth.csrfOk(req, url)))
      return json({ error: { message: "This operation needs a CLI token, not a browser session" } }, 403);
    const user = who.user;
    if (url.pathname === "/v1/health" && req.method === "GET") return json({ ok: true, name: "runo-server", user });

    try {
      const panel = await handlePanelApi({ store, auth, provider, region: AWS_REGION, ingressDomain: INGRESS_DOMAIN }, req, url, who);
      if (panel) return panel;
      if (url.pathname === "/v1/rpc" && req.method === "POST")
        return await handleRpc(who, await req.json());
      if (url.pathname === "/v1/exec" && req.method === "POST")
        return await handleExec(user, await req.json());
      if (url.pathname === "/v1/upload" && req.method === "POST") return await handleUpload(user, req, url);
      if (url.pathname === "/v1/download" && req.method === "POST") return await handleDownload(user, req);
      if (url.pathname === "/v1/share" && req.method === "POST") {
        const { id, members } = await req.json() as { id: string; members: string[] };
        const envs = loadEnvs();
        const env = requireAccess(user, id, Object.values(envs), true);
        const known = auth.knownUsers();
        if (!Array.isArray(members) || members.some(m => typeof m !== "string" || !known.has(m)))
          throw new RunoError("members must contain registered user names");
        env.members = [...new Set(members)];
        saveEnvs(envs);
        store.addEvent({ actor: user, action: "share", envName: env.envName, instanceId: env.instanceId, detail: { members: env.members } });
        return json({ result: null });
      }
      if (url.pathname === "/v1/register-services" && req.method === "POST") {
        const { rt, services, recipe, urls } = (await req.json()) as {
          rt: Runtime;
          services: { name: string; port: number }[];
          recipe?: string;
          urls?: Record<string, string>;
        };
        const envs = loadEnvs();
        requireAccess(user, rt?.id, Object.values(envs), true);
        for (const e of Object.values(envs))
          if (e.instanceId === rt.id) {
            e.services = services;
            e.recipe = recipe;
            e.urls = urls;
            saveEnvs(envs);
            return json({ result: null });
          }
        return json({ error: { message: `no registered env for instance ${rt.id}` } }, 404);
      }
      if (url.pathname === "/v1/envs" && req.method === "GET") {
        // all=1: the platform view — admins see every env (metadata and lifecycle, not the VM)
        const everything = who.admin && url.searchParams.get("all") === "1";
        const envs = Object.values(loadEnvs()).filter(e => everything || canAccess(user, e));
        if (url.searchParams.get("live") !== "1") return json({ result: envs });
        // enrich with live instance state for the panel
        const live = await Promise.all(
          envs.map(async (e) => {
            try {
              const rt = await provider.status({ id: e.instanceId, ip: null, state: "unknown" });
              return { ...e, state: rt.state, ip: rt.ip, url: ingressUrlFor(e) };
            } catch {
              return { ...e, state: "unknown", ip: null, url: ingressUrlFor(e) };
            }
          }),
        );
        return json({ result: live });
      }
      if (url.pathname === "/v1/tty") {
        const rt = await authorizedRuntime(user, JSON.parse(url.searchParams.get("rt")!));
        const command = Buffer.from(url.searchParams.get("cmd")!, "base64").toString();
        const proc = provider.spawnTty(rt, command);
        const ok = srv.upgrade(req, { data: { proc } });
        if (ok) return undefined as unknown as Response;
        proc.kill();
        return json({ error: { message: "websocket upgrade failed" } }, 400);
      }
      return json({ error: { message: "not found" } }, 404);
    } catch (e) {
      return errResponse(e);
    }
  },
  websocket: {
    idleTimeout: 0,
    async open(ws) {
      const { proc } = ws.data;
      const pump = async (stream: ReadableStream) => {
        const reader = stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          ws.send(value);
        }
      };
      Promise.all([pump(proc.stdout as ReadableStream), pump(proc.stderr as ReadableStream)]).then(
        async () => {
          const code = await proc.exited;
          try {
            ws.send(JSON.stringify({ t: "exit", code }));
            ws.close();
          } catch {}
        },
      );
    },
    message(ws, message) {
      const stdin = ws.data.proc.stdin as { write(d: Uint8Array | string): void };
      if (typeof message === "string") stdin.write(message);
      else stdin.write(message as Uint8Array);
    },
    close(ws) {
      try {
        ws.data.proc.kill();
      } catch {}
    },
  },
});

// ---------- TTL sweeper (policy env_ttl_days) ----------

async function sweepTtl(): Promise<void> {
  let pol;
  try {
    pol = loadPolicies();
  } catch {
    return; // broken policies.yaml already errors on create; don't crash the sweeper
  }
  if (!pol.env_ttl_days) return;
  const cutoff = Date.now() - pol.env_ttl_days * 86_400_000;
  for (const e of Object.values(loadEnvs())) {
    if (new Date(e.createdAt).getTime() >= cutoff) continue;
    log.warn(
      `policy TTL (${pol.env_ttl_days}d): destroying ${e.envName} (owner ${e.owner}, created ${e.createdAt})`,
    );
    try {
      await provider.destroy({ id: e.instanceId, ip: null, state: "unknown" });
      const cur = loadEnvs();
      delete cur[e.envName];
      saveEnvs(cur);
      store.endMachine(e.instanceId, "system", "ttl");
      store.addEvent({ actor: "system", action: "ttl-destroy", envName: e.envName, instanceId: e.instanceId, detail: { owner: e.owner, ttlDays: pol.env_ttl_days } });
    } catch (err: any) {
      log.warn(`TTL destroy failed for ${e.envName}: ${err?.message ?? err}`);
    }
  }
}
setInterval(sweepTtl, 10 * 60_000);
void sweepTtl();

setInterval(sampleNow, 60_000);
setInterval(() => {
  store.pruneSessions();
  store.pruneSamples(Date.now() - 400 * 86_400_000);
}, 3_600_000);
void sampleNow();

const gh = auth.config.github;
log.ok(`runo-server listening on :${server.port} (token users: ${[...auth.config.envTokens.keys()].join(", ") || "none"})`);
if (gh) log.dim(`GitHub login: ${[...gh.allowedOrgs.map((o) => `org ${o}`), ...gh.allowedUsers.map((u) => `@${u}`)].join(", ")}`);
log.dim(`state: ${RUNO_HOME} — put TLS/VPN in front before exposing this beyond localhost`);

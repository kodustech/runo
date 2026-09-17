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
 * v0 scope: single process, token auth, JSON file state. Put TLS in front
 * (ALB/caddy/tailscale) before exposing beyond localhost/VPN.
 */
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { RUNO_HOME } from "../src/config";
import { RunoError } from "../src/errors";
import { log } from "../src/log";
import { Ec2Provider } from "../src/provider/aws";
import type { CreateSpec, ExecOpts, Runtime } from "../src/provider/types";
import { enforceCreate, loadPolicies } from "./policies";
import { AccessDenied, canAccess, requireAccess } from "./access";

const PORT = Number(process.env.RUNO_SERVER_PORT || argValue("--port") || 7777);
const provider = new Ec2Provider();

// ---------- auth ----------

const tokens = new Map<string, string>(); // token -> user
for (const pair of (process.env.RUNO_SERVER_TOKENS ?? "").split(",")) {
  const [user, token] = pair.split(":").map((s) => s?.trim());
  if (user && token) tokens.set(token, user);
}
if (tokens.size === 0) {
  console.error("RUNO_SERVER_TOKENS is required (format: \"alice:token1,bob:token2\")");
  process.exit(1);
}

function authUser(req: Request, url: URL): string | null {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = bearer ?? url.searchParams.get("token");
  return token ? tokens.get(token) ?? null : null;
}

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

async function handleRpc(user: string, body: any): Promise<Response> {
  const { method, args = [] } = body;
  if (!RPC_ALLOWED.has(method)) return json({ error: { message: `unknown method: ${method}` } }, 400);
  const envsBefore = Object.values(loadEnvs());
  if (["waitReady", "status", "suspend", "resume", "destroy"].includes(method)) {
    const env = requireAccess(user, args[0]?.id, envsBefore, method !== "status");
    args[0] = await provider.status({ id: env.instanceId, ip: null, state: "unknown" });
  }
  if (["poolScale", "prepareBootImage", "removeBootImage", "ensurePorts"].includes(method) &&
      !(process.env.RUNO_SERVER_ADMINS ?? "").split(",").includes(user))
    throw new AccessDenied("This operation requires RUNO_SERVER_ADMINS membership");
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

  const result = await (provider as any)[method](...args);

  // bookkeeping for the platform view
  if (method === "create") {
    const spec = args[0];
    const rt = result as Runtime;
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
    // web panel: static page, data itself still requires the token
    if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") {
      const html = readFileSync(new URL("./panel.html", import.meta.url).pathname, "utf8");
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/v1/health" && req.method === "GET") {
      const user = authUser(req, url);
      if (!user) return json({ error: { message: "unauthorized" } }, 401);
      return json({ ok: true, name: "runo-server", user });
    }
    const user = authUser(req, url);
    if (!user) return json({ error: { message: "unauthorized" } }, 401);

    try {
      if (url.pathname === "/v1/rpc" && req.method === "POST")
        return await handleRpc(user, await req.json());
      if (url.pathname === "/v1/exec" && req.method === "POST")
        return await handleExec(user, await req.json());
      if (url.pathname === "/v1/upload" && req.method === "POST") return await handleUpload(user, req, url);
      if (url.pathname === "/v1/download" && req.method === "POST") return await handleDownload(user, req);
      if (url.pathname === "/v1/share" && req.method === "POST") {
        const { id, members } = await req.json() as { id: string; members: string[] };
        const envs = loadEnvs();
        const env = requireAccess(user, id, Object.values(envs), true);
        const known = new Set(tokens.values());
        if (!Array.isArray(members) || members.some(m => typeof m !== "string" || !known.has(m)))
          throw new RunoError("members must contain registered user names");
        env.members = [...new Set(members)];
        saveEnvs(envs);
        return json({ result: null });
      }
      if (url.pathname === "/v1/policies" && req.method === "GET")
        return json({ result: loadPolicies() });
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
        const envs = Object.values(loadEnvs()).filter(e => canAccess(user, e));
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
    } catch (err: any) {
      log.warn(`TTL destroy failed for ${e.envName}: ${err?.message ?? err}`);
    }
  }
}
setInterval(sweepTtl, 10 * 60_000);
void sweepTtl();

log.ok(`runo-server listening on :${server.port} (users: ${[...new Set(tokens.values())].join(", ")})`);
log.dim(`state: ${RUNO_HOME} — put TLS/VPN in front before exposing this beyond localhost`);

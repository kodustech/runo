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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUNO_HOME } from "../src/config";
import { RunoError } from "../src/errors";
import { log } from "../src/log";
import { Ec2Provider } from "../src/provider/aws";
import type { ExecOpts, Runtime } from "../src/provider/types";

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
  owner: string;
  repo: string;
  branch: string;
  instanceId: string;
  instanceType: string;
  spot: boolean;
  createdAt: string;
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

  const result = await (provider as any)[method](...args);

  // bookkeeping for the platform view
  if (method === "create") {
    const spec = args[0];
    const rt = result as Runtime;
    const envs = loadEnvs();
    envs[spec.envName] = {
      envName: spec.envName,
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
  const { rt, command, opts = {} } = body as { rt: Runtime; command: string; opts: ExecOpts };
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

async function handleUpload(req: Request, url: URL): Promise<Response> {
  const rt = JSON.parse(url.searchParams.get("rt")!) as Runtime;
  const remotePath = url.searchParams.get("path")!;
  const tmp = path.join(RUNO_HOME, "tmp", `upload-${Date.now()}`);
  mkdirSync(path.dirname(tmp), { recursive: true });
  await Bun.write(tmp, await req.arrayBuffer());
  try {
    await provider.upload(rt, tmp, remotePath);
  } finally {
    rmSync(tmp, { force: true });
  }
  return json({ result: null });
}

async function handleDownload(req: Request): Promise<Response> {
  const { rt, remotePath, excludes = [] } = (await req.json()) as {
    rt: Runtime;
    remotePath: string;
    excludes: string[];
  };
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

// ---------- websocket tty (experimental) ----------

interface TtyData {
  proc: ReturnType<typeof Bun.spawn>;
}

const server = Bun.serve<TtyData, {}>({
  port: PORT,
  idleTimeout: 0,
  async fetch(req, srv) {
    const url = new URL(req.url);
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
      if (url.pathname === "/v1/upload" && req.method === "POST") return await handleUpload(req, url);
      if (url.pathname === "/v1/download" && req.method === "POST") return await handleDownload(req);
      if (url.pathname === "/v1/envs" && req.method === "GET") {
        const envs = Object.values(loadEnvs());
        if (url.searchParams.get("live") !== "1") return json({ result: envs });
        // enrich with live instance state for the panel
        const live = await Promise.all(
          envs.map(async (e) => {
            try {
              const rt = await provider.status({ id: e.instanceId, ip: null, state: "unknown" });
              return { ...e, state: rt.state, ip: rt.ip };
            } catch {
              return { ...e, state: "unknown", ip: null };
            }
          }),
        );
        return json({ result: live });
      }
      if (url.pathname === "/v1/tty") {
        const rt = JSON.parse(url.searchParams.get("rt")!) as Runtime;
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

log.ok(`runo-server listening on :${server.port} (users: ${[...new Set(tokens.values())].join(", ")})`);
log.dim(`state: ${RUNO_HOME} — put TLS/VPN in front before exposing this beyond localhost`);

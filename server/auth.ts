/**
 * Who is calling. Two kinds of credential, deliberately not equivalent:
 *
 *  - bearer token (CLI, CI, agents): full API. Either RUNO_SERVER_TOKENS
 *    (bootstrap/service identities) or a token minted in the panel.
 *  - session cookie (the web panel, after GitHub OAuth or a token exchange):
 *    panel API only. A browser session cannot exec, upload, download or open
 *    a shell on a VM. The one bridge between the two worlds — minting a CLI
 *    token — and changing who is admin need a session younger than
 *    FRESH_SESSION_MS, so a cookie lifted hours after login cannot escalate.
 *
 * Everything secret is compared/stored as SHA-256; nothing here logs a token.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { RunoError } from "../src/errors";
import type { Store } from "./store";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface Identity {
  user: string;
  via: "token" | "session";
  admin: boolean;
  /** session only: when the user proved who they are */
  loggedInAt?: number;
}

export const FRESH_SESSION_MS = 15 * 60_000;

/** Thrown for sensitive panel actions on an old session; the panel answers by sending the user through login again. */
export class ReauthRequired extends RunoError {}

export function requireFresh(who: Identity, now = Date.now()): void {
  if (who.via === "session" && now - (who.loggedInAt ?? 0) > FRESH_SESSION_MS)
    throw new ReauthRequired("Confirm it is you: log in again to do this");
}

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  /** https://github.com, or a GitHub Enterprise Server base URL */
  url: string;
  allowedOrgs: string[];
  allowedUsers: string[];
}

export interface AuthConfig {
  /** RUNO_SERVER_TOKENS: name -> token */
  envTokens: Map<string, string>;
  /** RUNO_SERVER_ADMINS */
  envAdmins: string[];
  /** External origin of the panel, e.g. https://runo.example.com — required for OAuth. */
  publicUrl: string | null;
  github: GithubConfig | null;
  sessionHours: number;
}

const list = (raw: string | undefined) =>
  (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function authConfigFromEnv(env: Record<string, string | undefined>): AuthConfig {
  const envTokens = new Map<string, string>();
  for (const pair of list(env.RUNO_SERVER_TOKENS)) {
    const sep = pair.indexOf(":");
    const user = pair.slice(0, sep).trim();
    const token = pair.slice(sep + 1).trim();
    if (sep > 0 && user && token) envTokens.set(user, token);
  }
  const publicUrl = env.RUNO_PUBLIC_URL?.trim().replace(/\/+$/, "") || null;
  let github: GithubConfig | null = null;
  if (env.RUNO_GITHUB_CLIENT_ID || env.RUNO_GITHUB_CLIENT_SECRET) {
    if (!env.RUNO_GITHUB_CLIENT_ID || !env.RUNO_GITHUB_CLIENT_SECRET)
      throw new RunoError("GitHub login needs both RUNO_GITHUB_CLIENT_ID and RUNO_GITHUB_CLIENT_SECRET");
    if (!publicUrl)
      throw new RunoError("GitHub login needs RUNO_PUBLIC_URL", "Set it to the panel's external URL, e.g. https://runo.example.com");
    github = {
      clientId: env.RUNO_GITHUB_CLIENT_ID,
      clientSecret: env.RUNO_GITHUB_CLIENT_SECRET,
      url: (env.RUNO_GITHUB_URL?.trim() || "https://github.com").replace(/\/+$/, ""),
      allowedOrgs: list(env.RUNO_GITHUB_ALLOWED_ORGS).map((s) => s.toLowerCase()),
      allowedUsers: list(env.RUNO_GITHUB_ALLOWED_USERS).map((s) => s.toLowerCase()),
    };
    // fail closed: without an allowlist every GitHub account on earth could log in
    if (!github.allowedOrgs.length && !github.allowedUsers.length)
      throw new RunoError(
        "GitHub login is configured without an allowlist",
        "Set RUNO_GITHUB_ALLOWED_ORGS (e.g. your-org) and/or RUNO_GITHUB_ALLOWED_USERS",
      );
  }
  const hours = Number(env.RUNO_SESSION_HOURS || 24);
  if (!Number.isFinite(hours) || hours <= 0) throw new RunoError("RUNO_SESSION_HOURS must be a positive number");
  return { envTokens, envAdmins: list(env.RUNO_SERVER_ADMINS), publicUrl, github, sessionHours: hours };
}

/** Session routes: what a browser cookie may reach. Everything else is bearer-only. */
const SESSION_ROUTES = new Set([
  "/v1/me", "/v1/overview", "/v1/machines", "/v1/events", "/v1/costs", "/v1/policies", "/v1/pricing",
  "/v1/users", "/v1/tokens", "/v1/server", "/v1/envs", "/v1/share", "/v1/rpc", "/v1/health",
]);
export const SESSION_RPC = new Set(["status", "suspend", "resume", "destroy", "listManaged", "poolStatus", "poolScale"]);

export function sessionMayCall(pathname: string): boolean {
  return SESSION_ROUTES.has(pathname) || pathname.startsWith("/v1/users/") || pathname.startsWith("/v1/tokens/");
}

export class Auth {
  private envTokenHashes = new Map<string, string>(); // sha256(token) -> user
  readonly cookieName: string;
  private secure: boolean;

  constructor(readonly config: AuthConfig, private store: Store) {
    for (const [user, token] of config.envTokens) this.envTokenHashes.set(sha256(token), user);
    this.secure = Boolean(config.publicUrl?.startsWith("https://"));
    // __Host-: the browser refuses it unless Secure + Path=/ + no Domain, so an
    // env served on a sibling subdomain (ingress) cannot plant or override it
    this.cookieName = this.secure ? "__Host-runo_session" : "runo_session";
  }

  isAdmin(user: string): boolean {
    return this.config.envAdmins.includes(user) || this.store.user(user)?.role === "admin";
  }

  /** Names that can own/share environments. */
  knownUsers(): Set<string> {
    const out = new Set(this.config.envTokens.keys());
    for (const u of this.store.users()) if (!u.disabled) out.add(u.login);
    return out;
  }

  isServiceName(login: string): boolean {
    return this.config.envTokens.has(login);
  }

  private identity(user: string, via: Identity["via"], loggedInAt?: number): Identity | null {
    if (this.store.user(user)?.disabled) return null;
    return { user, via, admin: this.isAdmin(user), loggedInAt };
  }

  fromToken(token: string): Identity | null {
    const hash = sha256(token);
    const user = this.envTokenHashes.get(hash) ?? this.store.tokenUser(hash);
    return user ? this.identity(user, "token") : null;
  }

  identify(req: Request, url: URL): Identity | null {
    const header = req.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : url.searchParams.get("token");
    if (token) return this.fromToken(token);
    const sid = readCookie(req, this.cookieName);
    if (!sid) return null;
    const session = this.store.session(sha256(sid));
    return session ? this.identity(session.user, "session", session.createdAt) : null;
  }

  /**
   * Cookie requests that change state must come from the panel's own origin
   * and carry a header no cross-origin form/fetch can add without a CORS
   * preflight (which this server never grants).
   */
  csrfOk(req: Request, url: URL): boolean {
    if (req.method === "GET" || req.method === "HEAD") return true;
    if (req.headers.get("x-runo-panel") !== "1") return false;
    const origin = req.headers.get("origin");
    if (!origin) return true;
    if (this.config.publicUrl) return origin === new URL(this.config.publicUrl).origin;
    // no RUNO_PUBLIC_URL: TLS ends at the proxy, so only the host is comparable
    try {
      return new URL(origin).host === req.headers.get("host");
    } catch {
      return false;
    }
  }

  startSession(user: string): string {
    const sid = randomBytes(32).toString("base64url");
    this.store.addSession(sha256(sid), user, Date.now() + this.config.sessionHours * 3_600_000);
    return this.cookie(this.cookieName, sid, this.config.sessionHours * 3600);
  }

  endSession(req: Request): string {
    const sid = readCookie(req, this.cookieName);
    if (sid) this.store.deleteSession(sha256(sid));
    return this.cookie(this.cookieName, "", 0);
  }

  cookie(name: string, value: string, maxAgeSeconds: number): string {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${this.secure ? "; Secure" : ""}`;
  }

  /** Mints a CLI token. The plaintext is returned once and never stored. */
  mintToken(user: string, name: string, createdBy: string): { id: number; token: string } {
    const token = "runo_" + randomBytes(32).toString("base64url");
    const id = this.store.addToken({ user, name, hash: sha256(token), prefix: token.slice(0, 10), createdBy });
    return { id, token };
  }

  // ---------- GitHub OAuth ----------

  get stateCookie(): string {
    return this.secure ? "__Host-runo_oauth" : "runo_oauth";
  }

  githubAuthorizeUrl(state: string): string {
    const gh = this.config.github!;
    const q = new URLSearchParams({
      client_id: gh.clientId,
      redirect_uri: `${this.config.publicUrl}/auth/github/callback`,
      // read:org — org membership is invisible to the API without it when the membership is private
      scope: gh.allowedOrgs.length ? "read:org" : "",
      state,
    });
    return `${gh.url}/login/oauth/authorize?${q}`;
  }

  /**
   * Finishes the OAuth dance and returns the GitHub login allowed in.
   * The GitHub access token is used for these calls and then dropped.
   */
  async githubLogin(code: string, fetcher: typeof fetch = fetch): Promise<{ login: string; name: string | null; avatar: string | null }> {
    const gh = this.config.github!;
    const api = gh.url === "https://github.com" ? "https://api.github.com" : `${gh.url}/api/v3`;
    const tokenRes = await fetcher(`${gh.url}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: gh.clientId, client_secret: gh.clientSecret, code,
        redirect_uri: `${this.config.publicUrl}/auth/github/callback`,
      }),
    });
    const accessToken = ((await tokenRes.json()) as any)?.access_token;
    if (!accessToken) throw new RunoError("GitHub did not accept the login code", "Start the login again");
    const headers = { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "runo-server" };
    const profile = (await (await fetcher(`${api}/user`, { headers })).json()) as any;
    const login = String(profile?.login ?? "").toLowerCase();
    if (!login) throw new RunoError("GitHub did not return a user profile");

    let allowed = gh.allowedUsers.includes(login);
    for (const org of allowed ? [] : gh.allowedOrgs) {
      const res = await fetcher(`${api}/user/memberships/orgs/${encodeURIComponent(org)}`, { headers });
      if (res.ok && ((await res.json()) as any)?.state === "active") {
        allowed = true;
        break;
      }
    }
    if (!allowed)
      throw new RunoError(
        `@${login} is not allowed on this runo server`,
        "Ask an admin to add you to an allowed GitHub organization (the org may also need to approve this OAuth app)",
      );
    // a GitHub account named like a service identity would inherit its environments and admin rights
    if (this.isServiceName(login))
      throw new RunoError(`@${login} collides with a service identity in RUNO_SERVER_TOKENS`);
    return { login, name: profile.name ?? null, avatar: profile.avatar_url ?? null };
  }
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(sha256(a));
  const y = Buffer.from(sha256(b));
  return timingSafeEqual(x, y);
}

/** Failed-login throttle, per client address. In-memory: a restart forgives. */
export class Throttle {
  private hits = new Map<string, number[]>();
  constructor(private max = 10, private windowMs = 5 * 60_000) {}

  blocked(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, recent);
    return recent.length >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    const recent = this.hits.get(key) ?? [];
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear();
  }
}

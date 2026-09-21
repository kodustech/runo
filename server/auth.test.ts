import { expect, test } from "bun:test";
import { Auth, authConfigFromEnv, FRESH_SESSION_MS, requireFresh, sessionMayCall, Throttle } from "./auth";
import { Store } from "./store";

const githubEnv = {
  RUNO_PUBLIC_URL: "https://runo.example.com", RUNO_GITHUB_CLIENT_ID: "id", RUNO_GITHUB_CLIENT_SECRET: "secret",
  RUNO_GITHUB_ALLOWED_ORGS: "Acme", RUNO_SERVER_TOKENS: "preview-ci:ci-secret", RUNO_SERVER_ADMINS: "preview-ci",
};

/** A GitHub that knows one user and which orgs they actively belong to. */
const github = (login: string, orgs: string[]) => (async (input: any) => {
  const url = String(input);
  if (url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "gho_x" });
  if (url.endsWith("/user")) return Response.json({ login, name: "Some One", avatar_url: "https://avatars.githubusercontent.com/u/1" });
  const org = url.match(/memberships\/orgs\/(.+)$/)?.[1];
  return org && orgs.includes(org) ? Response.json({ state: "active" }) : new Response("{}", { status: 404 });
}) as typeof fetch;

test("GitHub login fails closed: no allowlist, no public URL or half a client means no server", () => {
  expect(() => authConfigFromEnv({ ...githubEnv, RUNO_GITHUB_ALLOWED_ORGS: "" })).toThrow(/allowlist/);
  expect(() => authConfigFromEnv({ ...githubEnv, RUNO_PUBLIC_URL: "" })).toThrow(/RUNO_PUBLIC_URL/);
  expect(() => authConfigFromEnv({ ...githubEnv, RUNO_GITHUB_CLIENT_SECRET: "" })).toThrow();
  expect(authConfigFromEnv({ ...githubEnv, RUNO_GITHUB_ALLOWED_ORGS: "", RUNO_GITHUB_ALLOWED_USERS: "Bob" }).github?.allowedUsers).toEqual(["bob"]);
});

test("only active members of an allowed org (or listed users) get in; service names cannot be claimed", async () => {
  const auth = new Auth(authConfigFromEnv(githubEnv), new Store(":memory:"));
  expect((await auth.githubLogin("code", github("Alice", ["acme"]))).login).toBe("alice");
  await expect(auth.githubLogin("code", github("mallory", ["other-org"]))).rejects.toThrow(/not allowed/);
  await expect(auth.githubLogin("code", github("preview-ci", ["acme"]))).rejects.toThrow(/service identity/);
  const authorize = new URL(auth.githubAuthorizeUrl("st4te"));
  expect(authorize.searchParams.get("redirect_uri")).toBe("https://runo.example.com/auth/github/callback");
  expect(authorize.searchParams.get("scope")).toBe("read:org");
});

test("sessions and minted tokens authenticate, are stored hashed, and die with the user", () => {
  const store = new Store(":memory:");
  const auth = new Auth(authConfigFromEnv(githubEnv), store);
  store.upsertUser({ login: "alice", source: "github" });

  const cookie = auth.startSession("alice");
  expect(cookie).toMatch(/^__Host-runo_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure$/);
  const sid = cookie.split(";")[0];
  const viaCookie = () => auth.identify(new Request("https://runo.example.com/v1/me", { headers: { cookie: sid } }), new URL("https://runo.example.com/v1/me"));
  expect(viaCookie()).toMatchObject({ user: "alice", via: "session", admin: false });

  const { token } = auth.mintToken("alice", "laptop", "alice");
  expect(auth.fromToken(token)).toMatchObject({ user: "alice", via: "token" });
  expect(JSON.stringify(store.tokens())).not.toContain(token.slice(10));
  expect(auth.fromToken("ci-secret")).toMatchObject({ user: "preview-ci", admin: true });
  expect(auth.fromToken("nope")).toBeNull();

  store.updateUser("alice", { disabled: true });
  expect(viaCookie()).toBeNull();
  expect(auth.fromToken(token)).toBeNull();
});

test("browser sessions are fenced: no VM routes, same-origin writes only, fresh login for escalation", () => {
  const auth = new Auth(authConfigFromEnv(githubEnv), new Store(":memory:"));
  for (const route of ["/v1/exec", "/v1/upload", "/v1/download", "/v1/tty", "/v1/register-services"]) expect(sessionMayCall(route)).toBe(false);
  expect(sessionMayCall("/v1/tokens/3")).toBe(true);

  const post = (headers: Record<string, string>) => {
    const req = new Request("https://runo.example.com/v1/policies", { method: "PUT", headers });
    return auth.csrfOk(req, new URL(req.url));
  };
  expect(post({ "x-runo-panel": "1", origin: "https://runo.example.com" })).toBe(true);
  expect(post({ origin: "https://runo.example.com" })).toBe(false); // plain form/fetch cannot add the header
  expect(post({ "x-runo-panel": "1", origin: "https://pr-1.envs.example.com" })).toBe(false); // same-site env app

  const now = Date.now();
  expect(() => requireFresh({ user: "a", via: "session", admin: true, loggedInAt: now - FRESH_SESSION_MS - 1 }, now)).toThrow();
  requireFresh({ user: "a", via: "session", admin: true, loggedInAt: now - 1000 }, now);
  requireFresh({ user: "a", via: "token", admin: true }, now);
});

test("failed logins are throttled per address", () => {
  const throttle = new Throttle(3, 1000);
  for (let i = 0; i < 3; i++) throttle.fail("1.2.3.4", 0);
  expect(throttle.blocked("1.2.3.4", 500)).toBe(true);
  expect(throttle.blocked("5.6.7.8", 500)).toBe(false);
  expect(throttle.blocked("1.2.3.4", 1500)).toBe(false);
});

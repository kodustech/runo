/**
 * The web panel's API: history, cost, peaks and everything an admin can
 * configure without SSH-ing into the server.
 *
 * Visibility: admins see the whole fleet; everyone else sees machines they
 * own or that are shared with them. Fleet-size numbers (running now, peak) are
 * counts, not machines, and are shown to every logged-in user.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { MAX_INSTANCES, RUNO_HOME } from "../src/config";
import { RunoError } from "../src/errors";
import type { RuntimeProvider } from "../src/provider/types";
import { AccessDenied } from "./access";
import { requireFresh, type Auth, type Identity } from "./auth";
import { loadPolicies, parsePolicies, savePolicies } from "./policies";
import { defaultPricing, parsePricing, type Pricing } from "./pricing";
import type { Store } from "./store";
import { breakdown, dailyCost, monthEstimate, usageBetween, type MachineUsage } from "./usage";

export interface PanelContext {
  store: Store;
  auth: Auth;
  provider: Pick<RuntimeProvider, "poolStatus">;
  region: string;
  ingressDomain: string | null;
}

const DAY = 86_400_000;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function requireAdmin(who: Identity): void {
  if (!who.admin) throw new AccessDenied("This operation requires an admin");
}

export function pricingFor(ctx: Pick<PanelContext, "store" | "region">): Pricing {
  return ctx.store.setting<Pricing>("pricing") ?? defaultPricing(ctx.region);
}

function windowOf(url: URL, now: number): { from: number; to: number; days: number } {
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 400);
  return { from: now - days * DAY, to: now, days };
}

/** Instances shared with the user right now (the registry; history only knows owners). */
function sharedIds(user: string): Set<string> {
  try {
    const envs = JSON.parse(readFileSync(path.join(RUNO_HOME, "server-envs.json"), "utf8")) as Record<string, any>;
    return new Set(Object.values(envs).filter((e) => e.members?.includes(user)).map((e) => e.instanceId));
  } catch {
    return new Set();
  }
}

function visible(who: Identity, usage: MachineUsage[]): MachineUsage[] {
  if (who.admin) return usage;
  const shared = sharedIds(who.user);
  return usage.filter((m) => m.owner === who.user || shared.has(m.instanceId));
}

export async function handlePanelApi(ctx: PanelContext, req: Request, url: URL, who: Identity): Promise<Response | null> {
  const { store, auth } = ctx;
  const p = url.pathname;
  const now = Date.now();

  if (p === "/v1/me" && req.method === "GET") {
    const profile = store.user(who.user);
    return json({ result: { user: who.user, admin: who.admin, via: who.via, name: profile?.name ?? null, avatar: profile?.avatar ?? null } });
  }

  if (p === "/v1/overview" && req.method === "GET") {
    const { from, to, days } = windowOf(url, now);
    const pricing = pricingFor(ctx);
    const usage = visible(who, usageBetween(store, pricing, from, to, now));
    const month = who.admin ? monthEstimate(store, pricing, now) : null;
    return json({
      result: {
        scope: who.admin ? "all" : "mine",
        days,
        now: store.latestSample(),
        peak: store.peak(from, to),
        limit: loadPolicies().max_running_total ?? null,
        concurrency: store.concurrency(from, to, days <= 7 ? 3_600_000 : days <= 45 ? 6 * 3_600_000 : DAY),
        cost: usage.reduce((sum, m) => sum + m.cost, 0),
        runningHours: usage.reduce((sum, m) => sum + m.runningHours, 0),
        machines: usage.length,
        month,
        unpriced: [...new Set(usage.filter((m) => !m.priced && m.instanceType).map((m) => m.instanceType))],
      },
    });
  }

  if (p === "/v1/machines" && req.method === "GET") {
    const { from, to } = windowOf(url, now);
    let usage = visible(who, usageBetween(store, pricingFor(ctx), from, to, now));
    const owner = url.searchParams.get("owner");
    const repo = url.searchParams.get("repo");
    const status = url.searchParams.get("status");
    if (owner) usage = usage.filter((m) => m.owner === owner);
    if (repo) usage = usage.filter((m) => m.repo === repo);
    if (status === "alive") usage = usage.filter((m) => m.endedAt === null);
    if (status === "ended") usage = usage.filter((m) => m.endedAt !== null);
    return json({ result: usage });
  }

  if (p === "/v1/costs" && req.method === "GET") {
    const { from, to } = windowOf(url, now);
    const pricing = pricingFor(ctx);
    const usage = visible(who, usageBetween(store, pricing, from, to, now));
    return json({
      result: {
        scope: who.admin ? "all" : "mine",
        total: usage.reduce((sum, m) => sum + m.cost, 0),
        compute: usage.reduce((sum, m) => sum + m.computeCost, 0),
        storage: usage.reduce((sum, m) => sum + m.storageCost, 0),
        byOwner: breakdown(usage, (m) => m.owner),
        byRepo: breakdown(usage, (m) => m.repo),
        byType: breakdown(usage, (m) => m.instanceType),
        // per-day totals are fleet-wide, so only the platform view gets them
        daily: who.admin ? dailyCost(store, pricing, from, to, now) : null,
      },
    });
  }

  if (p === "/v1/events" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit")) || 100;
    const before = Number(url.searchParams.get("before")) || undefined;
    if (who.admin) return json({ result: store.events({ limit, before, actor: url.searchParams.get("actor") || undefined }) });
    const mine = visible(who, usageBetween(store, pricingFor(ctx), 0, now, now)).map((m) => m.instanceId);
    return json({ result: store.events({ limit, before, instanceIds: mine }) });
  }

  // ---------- configuration ----------

  if (p === "/v1/policies" && req.method === "GET") return json({ result: loadPolicies() });
  if (p === "/v1/policies" && req.method === "PUT") {
    requireAdmin(who);
    const before = loadPolicies();
    const after = parsePolicies(await req.json());
    savePolicies(after);
    store.addEvent({ actor: who.user, action: "policies.update", detail: { before, after } });
    return json({ result: after });
  }

  if (p === "/v1/pricing" && req.method === "GET")
    return json({ result: { pricing: pricingFor(ctx), custom: store.setting("pricing") !== null, region: ctx.region } });
  if (p === "/v1/pricing" && req.method === "PUT") {
    requireAdmin(who);
    const body = (await req.json()) as any;
    // { reset: true } goes back to the built-in table for the region
    const after = body?.reset ? defaultPricing(ctx.region) : parsePricing(body);
    const before = pricingFor(ctx);
    store.setSetting("pricing", after);
    store.addEvent({ actor: who.user, action: "pricing.update", detail: { before, after } });
    return json({ result: { pricing: after, custom: true, region: ctx.region } });
  }

  if (p === "/v1/server" && req.method === "GET") {
    requireAdmin(who);
    const gh = auth.config.github;
    let pool: number | null = null;
    try {
      pool = (await ctx.provider.poolStatus()).length;
    } catch {}
    // read-only on purpose: who may log in and which cloud account is used must not be one panel click away
    return json({
      result: {
        region: ctx.region,
        home: RUNO_HOME,
        publicUrl: auth.config.publicUrl,
        ingressDomain: ctx.ingressDomain,
        maxInstances: MAX_INSTANCES,
        expectedAwsArn: process.env.RUNO_EXPECTED_AWS_ARN ?? null,
        sessionHours: auth.config.sessionHours,
        github: gh ? { url: gh.url, allowedOrgs: gh.allowedOrgs, allowedUsers: gh.allowedUsers } : null,
        envAdmins: auth.config.envAdmins,
        pool,
      },
    });
  }

  // ---------- users ----------

  if (p === "/v1/users" && req.method === "GET") {
    requireAdmin(who);
    const fromEnv = [...auth.config.envTokens.keys()].map((login) => ({
      login, role: auth.isAdmin(login) ? "admin" : "member", source: "env", name: null, avatar: null,
      createdAt: null, lastLoginAt: null, disabled: false, locked: true,
    }));
    const fromDb = store.users().map((u) => ({
      ...u, role: auth.isAdmin(u.login) ? "admin" : "member", locked: auth.config.envAdmins.includes(u.login),
    }));
    return json({ result: [...fromDb, ...fromEnv] });
  }

  // service accounts: token-only identities for CI and agents
  if (p === "/v1/users" && req.method === "POST") {
    requireAdmin(who);
    requireFresh(who);
    const login = String(((await req.json()) as any)?.login ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(login)) throw new RunoError("A service account name is lowercase letters, digits and dashes");
    if (store.user(login) || auth.isServiceName(login)) throw new RunoError(`"${login}" already exists`);
    store.upsertUser({ login, source: "service" });
    store.addEvent({ actor: who.user, action: "user.create", detail: { login, source: "service" } });
    return json({ result: store.user(login) });
  }

  if (p.startsWith("/v1/users/") && req.method === "PATCH") {
    requireAdmin(who);
    requireFresh(who);
    const login = decodeURIComponent(p.slice("/v1/users/".length));
    const target = store.user(login);
    if (!target) throw new RunoError(`No user "${login}"`);
    const body = (await req.json()) as { role?: string; disabled?: boolean };
    if (login === who.user) throw new RunoError("Ask another admin to change your own account");
    if (body.role !== undefined && body.role !== "admin" && body.role !== "member") throw new RunoError("role is admin or member");
    if (body.role === "member" && auth.config.envAdmins.includes(login))
      throw new RunoError(`${login} is an admin through RUNO_SERVER_ADMINS`, "Remove it from the server's environment file");
    if (body.role === "admin" && target.source === "service") throw new RunoError("Service accounts cannot be admins");
    store.updateUser(login, { role: body.role as any, disabled: typeof body.disabled === "boolean" ? body.disabled : undefined });
    store.addEvent({ actor: who.user, action: "user.update", detail: { login, ...body } });
    return json({ result: store.user(login) });
  }

  // ---------- CLI tokens ----------

  if (p === "/v1/tokens" && req.method === "GET")
    return json({ result: store.tokens(who.admin && url.searchParams.get("all") === "1" ? undefined : who.user) });

  if (p === "/v1/tokens" && req.method === "POST") {
    requireFresh(who);
    const body = (await req.json()) as { name?: string; user?: string };
    const name = String(body.name ?? "").trim().slice(0, 60);
    if (!name) throw new RunoError("Name the token (where will it live? e.g. \"macbook\", \"github-actions\")");
    const owner = body.user?.trim().toLowerCase() || who.user;
    if (owner !== who.user) {
      // minting for another human would be impersonation; service accounts exist for this
      requireAdmin(who);
      if (store.user(owner)?.source !== "service") throw new RunoError("Tokens for someone else are only for service accounts");
    } else if (!store.user(owner)) {
      if (auth.isServiceName(owner)) throw new RunoError(`${owner} is defined in RUNO_SERVER_TOKENS; its token lives in the server's environment file`);
      throw new RunoError(`No user "${owner}"`);
    }
    const minted = auth.mintToken(owner, name, who.user);
    store.addEvent({ actor: who.user, action: "token.create", detail: { id: minted.id, user: owner, name } });
    return json({ result: { ...store.token(minted.id), token: minted.token } });
  }

  if (p.startsWith("/v1/tokens/") && req.method === "DELETE") {
    const token = store.token(Number(p.slice("/v1/tokens/".length)));
    if (!token || (token.user !== who.user && !who.admin)) throw new AccessDenied("Token not found");
    store.revokeToken(token.id);
    store.addEvent({ actor: who.user, action: "token.revoke", detail: { id: token.id, user: token.user, name: token.name } });
    return json({ result: null });
  }

  return null;
}

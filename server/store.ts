/**
 * Control-plane history — $RUNO_HOME/server.db (SQLite, bun:sqlite).
 *
 * server-envs.json stays the live registry (what exists right now); this file
 * is everything that must survive a destroy: who asked for which machine, how
 * long it ran, the audit trail, fleet-size samples, panel users, sessions and
 * CLI tokens. Secrets are stored hashed — a leaked server.db does not log
 * anyone in.
 */
import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";

export interface Machine {
  instanceId: string;
  envName: string;
  slug: string | null;
  owner: string;
  repo: string | null;
  branch: string | null;
  instanceType: string | null;
  spot: boolean;
  diskGb: number | null;
  createdAt: number;
  endedAt: number | null;
  endedBy: string | null;
  /** "destroy" | "ttl" | "vanished" (terminated outside runo) */
  endReason: string | null;
}

export interface Run {
  instanceId: string;
  startedAt: number;
  endedAt: number | null;
}

export interface AuditEvent {
  id: number;
  ts: number;
  actor: string;
  action: string;
  envName: string | null;
  instanceId: string | null;
  detail: unknown;
}

export interface Sample {
  ts: number;
  running: number;
  stopped: number;
  total: number;
}

export interface User {
  login: string;
  role: "admin" | "member";
  /** "github" (logged in through OAuth) | "service" (created by an admin, token-only) */
  source: string;
  name: string | null;
  avatar: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  disabled: boolean;
}

export interface TokenRow {
  id: number;
  user: string;
  name: string;
  prefix: string;
  createdAt: number;
  createdBy: string;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  instance_id TEXT PRIMARY KEY, env_name TEXT NOT NULL, slug TEXT, owner TEXT NOT NULL,
  repo TEXT, branch TEXT, instance_type TEXT, spot INTEGER NOT NULL DEFAULT 0, disk_gb INTEGER,
  created_at INTEGER NOT NULL, ended_at INTEGER, ended_by TEXT, end_reason TEXT
);
CREATE INDEX IF NOT EXISTS machines_created ON machines(created_at);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, instance_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_instance ON runs(instance_id, ended_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  env_name TEXT, instance_id TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS events_instance ON events(instance_id, ts);
CREATE TABLE IF NOT EXISTS samples (
  ts INTEGER PRIMARY KEY, running INTEGER NOT NULL, stopped INTEGER NOT NULL, total INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  login TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'member', source TEXT NOT NULL, name TEXT, avatar TEXT,
  created_at INTEGER NOT NULL, last_login_at INTEGER, disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY, user TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL, last_used_at INTEGER, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const MACHINE_COLS = `instance_id AS instanceId, env_name AS envName, slug, owner, repo, branch,
  instance_type AS instanceType, spot, disk_gb AS diskGb, created_at AS createdAt,
  ended_at AS endedAt, ended_by AS endedBy, end_reason AS endReason`;
const USER_COLS = `login, role, source, name, avatar, created_at AS createdAt,
  last_login_at AS lastLoginAt, disabled`;
const TOKEN_COLS = `id, user, name, prefix, created_at AS createdAt, created_by AS createdBy,
  last_used_at AS lastUsedAt, revoked_at AS revokedAt`;

export class Store {
  private db: Database;

  constructor(file: string) {
    this.db = new Database(file, { create: true });
    if (file !== ":memory:") {
      try {
        chmodSync(file, 0o600);
      } catch {}
      this.db.run("PRAGMA journal_mode = WAL");
    }
    this.db.run(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------- machines + runs ----------

  addMachine(m: Omit<Machine, "endedAt" | "endedBy" | "endReason">): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO machines (instance_id, env_name, slug, owner, repo, branch, instance_type, spot, disk_gb, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.instanceId, m.envName, m.slug, m.owner, m.repo, m.branch, m.instanceType, m.spot ? 1 : 0, m.diskGb, m.createdAt);
  }

  /** Closes the machine and its open run. No-op when it already ended. */
  endMachine(instanceId: string, by: string, reason: string, ts = Date.now()): void {
    this.closeRun(instanceId, ts);
    this.db
      .query("UPDATE machines SET ended_at = ?, ended_by = ?, end_reason = ? WHERE instance_id = ? AND ended_at IS NULL")
      .run(ts, by, reason, instanceId);
  }

  machine(instanceId: string): Machine | null {
    const row = this.db.query(`SELECT ${MACHINE_COLS} FROM machines WHERE instance_id = ?`).get(instanceId) as any;
    return row ? { ...row, spot: Boolean(row.spot) } : null;
  }

  /** Machines alive at any point of [from, to], newest first. */
  machinesBetween(from: number, to: number): Machine[] {
    const rows = this.db
      .query(
        `SELECT ${MACHINE_COLS} FROM machines
         WHERE created_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY created_at DESC`,
      )
      .all(to, from) as any[];
    return rows.map((r) => ({ ...r, spot: Boolean(r.spot) }));
  }

  openMachines(): Machine[] {
    const rows = this.db.query(`SELECT ${MACHINE_COLS} FROM machines WHERE ended_at IS NULL`).all() as any[];
    return rows.map((r) => ({ ...r, spot: Boolean(r.spot) }));
  }

  openRun(instanceId: string, ts = Date.now()): boolean {
    if (this.db.query("SELECT 1 FROM runs WHERE instance_id = ? AND ended_at IS NULL").get(instanceId)) return false;
    this.db.query("INSERT INTO runs (instance_id, started_at) VALUES (?, ?)").run(instanceId, ts);
    return true;
  }

  closeRun(instanceId: string, ts = Date.now()): boolean {
    const res = this.db
      .query("UPDATE runs SET ended_at = MAX(?, started_at) WHERE instance_id = ? AND ended_at IS NULL")
      .run(ts, instanceId);
    return res.changes > 0;
  }

  runsBetween(from: number, to: number): Run[] {
    return this.db
      .query(
        `SELECT instance_id AS instanceId, started_at AS startedAt, ended_at AS endedAt FROM runs
         WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)`,
      )
      .all(to, from) as Run[];
  }

  // ---------- audit trail ----------

  addEvent(e: { actor: string; action: string; envName?: string | null; instanceId?: string | null; detail?: unknown; ts?: number }): void {
    this.db
      .query("INSERT INTO events (ts, actor, action, env_name, instance_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.ts ?? Date.now(), e.actor, e.action, e.envName ?? null, e.instanceId ?? null,
        e.detail === undefined ? null : JSON.stringify(e.detail));
  }

  events(f: { limit?: number; before?: number; actor?: string; instanceIds?: string[] } = {}): AuditEvent[] {
    const where: string[] = [];
    const params: any[] = [];
    if (f.before) (where.push("id < ?"), params.push(f.before));
    if (f.actor) (where.push("actor = ?"), params.push(f.actor));
    if (f.instanceIds) {
      if (!f.instanceIds.length) return [];
      where.push(`instance_id IN (${f.instanceIds.map(() => "?").join(",")})`);
      params.push(...f.instanceIds);
    }
    const rows = this.db
      .query(
        `SELECT id, ts, actor, action, env_name AS envName, instance_id AS instanceId, detail FROM events
         ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, Math.min(Math.max(f.limit ?? 100, 1), 500)) as any[];
    return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }

  lastEvent(instanceId: string): AuditEvent | null {
    return this.events({ instanceIds: [instanceId], limit: 1 })[0] ?? null;
  }

  // ---------- fleet-size samples ----------

  addSample(s: Sample): void {
    this.db.query("INSERT OR REPLACE INTO samples (ts, running, stopped, total) VALUES (?, ?, ?, ?)")
      .run(s.ts, s.running, s.stopped, s.total);
  }

  latestSample(): Sample | null {
    return this.db.query("SELECT ts, running, stopped, total FROM samples ORDER BY ts DESC LIMIT 1").get() as Sample | null;
  }

  peak(from: number, to: number): { running: number; ts: number } | null {
    return this.db
      .query("SELECT running, ts FROM samples WHERE ts BETWEEN ? AND ? ORDER BY running DESC, ts DESC LIMIT 1")
      .get(from, to) as any;
  }

  /** Highest and average concurrency per bucket — what the fleet chart draws. */
  concurrency(from: number, to: number, bucketMs: number): { ts: number; peak: number; avg: number }[] {
    return this.db
      .query(
        `SELECT (ts / ?1) * ?1 AS ts, MAX(running) AS peak, AVG(running) AS avg FROM samples
         WHERE ts BETWEEN ?2 AND ?3 GROUP BY 1 ORDER BY 1`,
      )
      .all(bucketMs, from, to) as any[];
  }

  pruneSamples(olderThan: number): void {
    this.db.query("DELETE FROM samples WHERE ts < ?").run(olderThan);
  }

  // ---------- users ----------

  user(login: string): User | null {
    const row = this.db.query(`SELECT ${USER_COLS} FROM users WHERE login = ?`).get(login) as any;
    return row ? { ...row, disabled: Boolean(row.disabled) } : null;
  }

  users(): User[] {
    return (this.db.query(`SELECT ${USER_COLS} FROM users ORDER BY login`).all() as any[])
      .map((r) => ({ ...r, disabled: Boolean(r.disabled) }));
  }

  /** Creates the user on first sight; later calls only refresh the profile (role and disabled stay). */
  upsertUser(u: { login: string; source: string; role?: "admin" | "member"; name?: string | null; avatar?: string | null; loggedIn?: boolean }): User {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO users (login, role, source, name, avatar, created_at, last_login_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(login) DO UPDATE SET name = COALESCE(?4, name), avatar = COALESCE(?5, avatar),
           last_login_at = COALESCE(?7, last_login_at)`,
      )
      .run(u.login, u.role ?? "member", u.source, u.name ?? null, u.avatar ?? null, now, u.loggedIn ? now : null);
    return this.user(u.login)!;
  }

  updateUser(login: string, patch: { role?: "admin" | "member"; disabled?: boolean }): void {
    if (patch.role) this.db.query("UPDATE users SET role = ? WHERE login = ?").run(patch.role, login);
    if (patch.disabled !== undefined) {
      this.db.query("UPDATE users SET disabled = ? WHERE login = ?").run(patch.disabled ? 1 : 0, login);
      if (patch.disabled) this.db.query("DELETE FROM sessions WHERE user = ?").run(login);
    }
  }

  // ---------- sessions (stored hashed) ----------

  addSession(idHash: string, user: string, expiresAt: number): void {
    this.db.query("INSERT INTO sessions (id_hash, user, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(idHash, user, Date.now(), expiresAt);
  }

  session(idHash: string, now = Date.now()): { user: string; createdAt: number } | null {
    return this.db
      .query("SELECT user, created_at AS createdAt FROM sessions WHERE id_hash = ? AND expires_at > ?")
      .get(idHash, now) as any;
  }

  deleteSession(idHash: string): void {
    this.db.query("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
  }

  pruneSessions(now = Date.now()): void {
    this.db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  }

  // ---------- CLI tokens (stored hashed) ----------

  addToken(t: { user: string; name: string; hash: string; prefix: string; createdBy: string }): number {
    const res = this.db
      .query("INSERT INTO tokens (user, name, hash, prefix, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(t.user, t.name, t.hash, t.prefix, Date.now(), t.createdBy);
    return Number(res.lastInsertRowid);
  }

  /** The owner of a live token; bumps last_used_at at most once a minute. */
  tokenUser(hash: string, now = Date.now()): string | null {
    const row = this.db.query("SELECT id, user, last_used_at AS used FROM tokens WHERE hash = ? AND revoked_at IS NULL").get(hash) as any;
    if (!row) return null;
    if (!row.used || now - row.used > 60_000) this.db.query("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
    return row.user;
  }

  token(id: number): TokenRow | null {
    return this.db.query(`SELECT ${TOKEN_COLS} FROM tokens WHERE id = ?`).get(id) as TokenRow | null;
  }

  tokens(user?: string): TokenRow[] {
    return (user
      ? this.db.query(`SELECT ${TOKEN_COLS} FROM tokens WHERE user = ? ORDER BY id DESC`).all(user)
      : this.db.query(`SELECT ${TOKEN_COLS} FROM tokens ORDER BY id DESC`).all()) as TokenRow[];
  }

  liveTokenCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM tokens WHERE revoked_at IS NULL").get() as any).n;
  }

  revokeToken(id: number): void {
    this.db.query("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id);
  }

  // ---------- settings ----------

  setting<T>(key: string): T | null {
    const row = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as any;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setSetting(key: string, value: unknown): void {
    this.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
  }
}

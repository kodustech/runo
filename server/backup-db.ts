/**
 * Consistent copy of the history database: `bun server/backup-db.ts [keep]`.
 *
 * VACUUM INTO snapshots server.db while the server keeps writing (a plain `cp`
 * of a WAL database can be torn). Copies land in $RUNO_HOME/backups, the newest
 * `keep` (default 14) are kept. Same disk — it protects against corruption and
 * bad deploys, not against losing the volume: ship a copy elsewhere as well
 * (deploy/update-server.sh pulls one on every deploy).
 */
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { RUNO_HOME } from "../src/config";

const keep = Number(process.argv[2]) || 14;
const dir = path.join(RUNO_HOME, "backups");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const target = path.join(dir, `server-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);

const db = new Database(path.join(RUNO_HOME, "server.db"), { readonly: true });
db.run(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
db.close();

const old = readdirSync(dir).filter((f) => /^server-.*\.db$/.test(f)).sort().slice(0, -keep);
for (const f of old) rmSync(path.join(dir, f));
console.log(target);

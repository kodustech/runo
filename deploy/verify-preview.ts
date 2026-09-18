import { RemoteProvider } from "../src/provider/remote";
import { shq } from "../src/ssh";

const id = process.argv[2];
if (!id || !process.env.RUNO_SERVER || !process.env.RUNO_TOKEN)
  throw new Error("Usage: source QA config; bun deploy/verify-preview.ts <instance-id>");
const provider = new RemoteProvider(process.env.RUNO_SERVER, process.env.RUNO_TOKEN);
const rt = { id, ip: null, state: "unknown" as const };
const pg = `psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'BEGIN; CREATE TEMP TABLE runo_qa_probe(value text); INSERT INTO runo_qa_probe VALUES ('"'"'qa-write-ok'"'"'); SELECT value FROM runo_qa_probe; ROLLBACK;'`;
const mongo = `const admin=db.getSiblingDB("admin"); admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD); printjson(admin.runCommand({ping:1}));`;
for (const [name, command] of [
  ["PostgreSQL transactional write/read (rolled back)", `docker exec db_postgres sh -c ${shq(pg)}`],
  ["MongoDB authenticated ping", `docker exec mongodb mongosh --quiet --eval ${shq(mongo)}`],
] as const) {
  const result = await provider.exec(rt, command, { timeoutMs: 30_000 });
  console.log(`${name}: exit ${result.exitCode}\n${result.stdout}`);
  if (result.exitCode !== 0) throw new Error(`${name} failed: ${result.stderr}`);
}

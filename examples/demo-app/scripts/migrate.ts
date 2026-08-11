import { db } from "../src/db";

await db`CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`;
console.log("migrate: tabela items ok");
await db.end();

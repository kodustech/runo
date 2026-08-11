import { db } from "../src/db";

await db`TRUNCATE items RESTART IDENTITY`;
await db`INSERT INTO items (name) VALUES ('alpha'), ('beta'), ('gamma')`;
console.log("seed: 3 rows");
await db.end();

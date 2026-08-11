import { SQL } from "bun";

export const db = new SQL(
  process.env.DATABASE_URL ?? "postgres://postgres:runo@localhost:5432/postgres",
);

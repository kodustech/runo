import { SQL } from "bun";

export const db = new SQL(
  process.env.DATABASE_URL ?? "postgres://postgres:kd@localhost:5432/postgres",
);

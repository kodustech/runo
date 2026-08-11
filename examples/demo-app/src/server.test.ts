import { expect, test } from "bun:test";

const base = process.env.API_URL ?? "http://localhost:3000";

test("GET /health responds ok", async () => {
  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(200);
});

test("GET /items returns the 3 seeded rows", async () => {
  const res = await fetch(`${base}/items`);
  expect(res.status).toBe(200);
  const rows = (await res.json()) as { id: number; name: string }[];
  expect(rows.length).toBe(3);
});

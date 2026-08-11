import { db } from "./db";

const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") return Response.json({ ok: true });
    if (pathname === "/items") {
      const rows = await db`SELECT id, name FROM items ORDER BY id`;
      return Response.json([...rows]);
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`demo-app listening on :${port}`);

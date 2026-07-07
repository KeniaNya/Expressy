// Raw Bun.serve — no framework. This is the *ceiling* for anything running on
// Bun: it shows how much headroom a framework has before it hits the runtime.
import { LARGE_PAYLOAD, PORT } from "./contract.mjs";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const TEXT_HEADERS = { "Content-Type": "text/plain; charset=utf-8" };
const LARGE_JSON = JSON.stringify(LARGE_PAYLOAD);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/plaintext") return new Response("Hello, World!", { headers: TEXT_HEADERS });
    if (p === "/json") return Response.json({ message: "Hello, World!" });
    if (p === "/search") {
      return Response.json({
        q: url.searchParams.get("q"),
        limit: url.searchParams.get("limit"),
      });
    }
    if (p === "/middleware") return Response.json({ steps: 5 });
    if (p === "/json/large") return new Response(LARGE_JSON, { headers: JSON_HEADERS });
    if (p.startsWith("/user/")) return Response.json({ id: p.slice("/user/".length) });
    if (p === "/echo" && req.method === "POST") {
      const body = await req.json();
      return Response.json({ received: body });
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`READY ${server.port}`);

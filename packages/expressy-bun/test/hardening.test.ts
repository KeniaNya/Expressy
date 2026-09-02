import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import expressy, { Router, json, text, raw, serveStatic, HttpError } from "../src/index";

const request = (app: ReturnType<typeof expressy>, path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

const post = (app: ReturnType<typeof expressy>, path: string, body: BodyInit | null, headers: Record<string, string>) =>
  request(app, path, { method: "POST", body, headers });

describe("routing control flow", () => {
  test("next('route') skips the rest of the current route, not the next one", async () => {
    const app = expressy();
    const seen: string[] = [];
    app.get(
      "/x",
      (_req, _res, next) => { seen.push("a"); next("route"); },
      (_req, _res, next) => { seen.push("b (skipped)"); next(); },
    );
    app.get("/x", (_req, res) => { seen.push("c"); res.text("ok"); });

    const res = await request(app, "/x");
    expect(res.status).toBe(200);
    expect(seen).toEqual(["a", "c"]);
  });

  test("next('route') from app.use middleware simply continues", async () => {
    const app = expressy();
    app.use((_req, _res, next) => next("route"));
    app.get("/x", (_req, res) => res.text("reached"));
    expect(await (await request(app, "/x")).text()).toBe("reached");
  });

  test("next('router') exits the current router", async () => {
    const app = expressy();
    const api = new Router();
    api.use((_req, _res, next) => next("router"));
    api.get("/secret", (_req, res) => res.text("leaked"));
    app.use("/api", api);
    app.get("/api/secret", (_req, res) => res.text("outer"));

    expect(await (await request(app, "/api/secret")).text()).toBe("outer");
  });

  test("routing is case-insensitive by default, like Express", async () => {
    const app = expressy();
    app.get("/Users", (_req, res) => res.text("ok"));
    expect((await request(app, "/users")).status).toBe(200);
    expect((await request(app, "/USERS")).status).toBe(200);
  });

  test("case sensitive routing can be enabled per app and per router", async () => {
    const app = expressy();
    app.enable("case sensitive routing");
    app.get("/Users", (_req, res) => res.text("ok"));
    expect((await request(app, "/Users")).status).toBe(200);
    expect((await request(app, "/users")).status).toBe(404);

    const app2 = expressy();
    const r = new Router({ caseSensitive: true });
    r.get("/Users", (_req, res) => res.text("ok"));
    app2.use(r);
    expect((await request(app2, "/users")).status).toBe(404);
  });

  test("strict routing distinguishes trailing slashes", async () => {
    const app = expressy();
    app.enable("strict routing");
    app.get("/about", (_req, res) => res.text("ok"));
    expect((await request(app, "/about")).status).toBe(200);
    expect((await request(app, "/about/")).status).toBe(404);
  });

  test("optional params", async () => {
    const app = expressy();
    app.get("/user/:id?", (req, res) => res.json({ id: req.params.id ?? null }));
    expect(await (await request(app, "/user")).json()).toEqual({ id: null });
    expect(await (await request(app, "/user/7")).json()).toEqual({ id: "7" });
    expect((await request(app, "/user/7/x")).status).toBe(404);
  });

  test("path arrays register every path", async () => {
    const app = expressy();
    app.get(["/a", "/b/:id"], (req, res) => res.json({ id: req.params.id ?? null }));
    expect((await request(app, "/a")).status).toBe(200);
    expect(await (await request(app, "/b/3")).json()).toEqual({ id: "3" });
  });

  test("RegExp paths expose capture groups as numeric params", async () => {
    const app = expressy();
    app.get(/^\/files\/(\d+)\.txt$/, (req, res) => res.json({ n: req.params[0] }));
    expect(await (await request(app, "/files/42.txt")).json()).toEqual({ n: "42" });
    expect((await request(app, "/files/x.txt")).status).toBe(404);
  });

  test("app.route() chains methods on one path", async () => {
    const app = expressy();
    app
      .route("/book")
      .get((_req, res) => res.text("get"))
      .post((_req, res) => res.text("post"));
    expect(await (await request(app, "/book")).text()).toBe("get");
    expect(await (await request(app, "/book", { method: "POST" })).text()).toBe("post");
    expect((await request(app, "/book", { method: "PUT" })).status).toBe(404);
  });

  test("a sync handler that returns a Response has it sent", async () => {
    const app = expressy();
    app.get("/r", () => new Response("native", { status: 202 }));
    const res = await request(app, "/r");
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("native");
  });

  test("mount params stay visible in error handlers of that router (route params do not, as in Express)", async () => {
    const app = expressy();
    const r = new Router();
    r.get("/:id", () => { throw new HttpError(400, "bad"); });
    r.use((err: any, req: any, res: any, _next: any) => res.status(err.status).json(req.params));
    app.use("/items/:kind", r);
    const res = await request(app, "/items/book/9");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ kind: "book" });
  });
});

describe("body parsers", () => {
  test("empty JSON body yields {} instead of a 400", async () => {
    const app = expressy();
    app.use(json());
    app.post("/x", (req, res) => res.json(req.body));
    const res = await post(app, "/x", "", { "Content-Type": "application/json" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  test("strict mode rejects non-object JSON, strict:false allows it", async () => {
    const strictApp = expressy();
    strictApp.use(json());
    strictApp.post("/x", (req, res) => res.json({ body: req.body }));
    expect((await post(strictApp, "/x", "123", { "Content-Type": "application/json" })).status).toBe(400);

    const lax = expressy();
    lax.use(json({ strict: false }));
    lax.post("/x", (req, res) => res.json({ body: req.body }));
    expect(await (await post(lax, "/x", "123", { "Content-Type": "application/json" })).json()).toEqual({ body: 123 });
  });

  test("chunked bodies without Content-Length are cut off at the limit", async () => {
    const app = expressy();
    app.use(json({ limit: 64 }));
    app.post("/x", (req, res) => res.json(req.body));

    let pushed = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Endless body; the parser must stop reading once the limit is crossed.
        pushed += 32;
        controller.enqueue(new TextEncoder().encode("x".repeat(32)));
        if (pushed > 10_000) controller.close();
      },
    });
    const res = await request(app, "/x", {
      method: "POST",
      body: stream,
      headers: { "Content-Type": "application/json" },
      // @ts-expect-error Bun supports streaming request bodies
      duplex: "half",
    });
    expect(res.status).toBe(413);
    expect(pushed).toBeLessThan(1000);
  });

  test("text() and raw() parsers", async () => {
    const app = expressy();
    app.use(text());
    app.use(raw());
    app.post("/t", (req, res) => res.json({ body: req.body, type: typeof req.body }));
    app.post("/r", (req, res) => res.json({ isBuffer: Buffer.isBuffer(req.body), len: (req.body as Buffer).length }));

    expect(await (await post(app, "/t", "hola", { "Content-Type": "text/plain" })).json()).toEqual({ body: "hola", type: "string" });
    expect(await (await post(app, "/r", new Uint8Array([1, 2, 3]), { "Content-Type": "application/octet-stream" })).json()).toEqual({ isBuffer: true, len: 3 });
  });

  test("expressy.text / expressy.raw statics exist", () => {
    expect(typeof expressy.text).toBe("function");
    expect(typeof expressy.raw).toBe("function");
  });
});

describe("response helpers", () => {
  test("clearCookie drops maxAge and expires the cookie", async () => {
    const app = expressy();
    app.get("/out", (_req, res) => {
      res.clearCookie("sid", { maxAge: 900000, httpOnly: true });
      res.end();
    });
    const cookie = (await request(app, "/out")).headers.get("set-cookie")!;
    expect(cookie).toContain("sid=;");
    expect(cookie).not.toContain("Max-Age");
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970");
    expect(cookie).toContain("HttpOnly");
  });

  test("cookie with maxAge sets Max-Age and a matching Expires", async () => {
    const app = expressy();
    app.get("/in", (_req, res) => { res.cookie("a", "1", { maxAge: 60_000 }); res.end(); });
    const cookie = (await request(app, "/in")).headers.get("set-cookie")!;
    expect(cookie).toContain("Max-Age=60");
    expect(cookie).toContain("Expires=");
  });

  test("res.type accepts extensions and full MIME types", async () => {
    const app = expressy();
    app.get("/png", (_req, res) => res.type(".png").end());
    app.get("/csv", (_req, res) => res.type("csv").end());
    app.get("/full", (_req, res) => res.type("application/vnd.api+json").end());
    expect((await request(app, "/png")).headers.get("content-type")).toBe("image/png");
    expect((await request(app, "/csv")).headers.get("content-type")).toContain("text/csv");
    expect((await request(app, "/full")).headers.get("content-type")).toBe("application/vnd.api+json");
  });

  test("res.vary / res.location / res.attachment", async () => {
    const app = expressy();
    app.get("/v", (_req, res) => {
      res.vary("Accept").vary("Origin").vary("accept");
      res.location("/there");
      res.attachment("informe ñ.pdf");
      res.end();
    });
    const res = await request(app, "/v");
    expect(res.headers.get("vary")).toBe("Accept, Origin");
    expect(res.headers.get("location")).toBe("/there");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain('attachment; filename="informe ?.pdf"');
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''informe%20%C3%B1.pdf");
  });

  test("res.sendFile with root and res.download", async () => {
    const dir = mkdtempSync(join(tmpdir(), "expressy-files-"));
    writeFileSync(join(dir, "report.txt"), "contents");
    const app = expressy();
    app.get("/f", (_req, res) => res.sendFile("report.txt", { root: dir }));
    app.get("/d", (_req, res) => res.download(join(dir, "report.txt"), "renamed.txt"));
    app.get("/missing", (_req, res) => res.sendFile("nope.txt", { root: dir }));

    const f = await request(app, "/f");
    expect(await f.text()).toBe("contents");
    const d = await request(app, "/d");
    expect(d.headers.get("content-disposition")).toContain('filename="renamed.txt"');
    expect(await d.text()).toBe("contents");
    expect((await request(app, "/missing")).status).toBe(404);
  });

  test("HEAD of a file response has no body but keeps headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "expressy-head-"));
    writeFileSync(join(dir, "a.txt"), "hello");
    const app = expressy();
    app.use(serveStatic(dir));
    const res = await request(app, "/a.txt", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("");
  });

  test("HttpError exposes statusCode and expose", () => {
    const e = new HttpError(422);
    expect(e.statusCode).toBe(422);
    expect(e.expose).toBe(true);
    expect(e.message).toBe("Unprocessable Entity");
    expect(new HttpError(502).expose).toBe(false);
  });
});

describe("serveStatic", () => {
  function makeSite() {
    const dir = mkdtempSync(join(tmpdir(), "expressy-static-"));
    writeFileSync(join(dir, "index.html"), "<h1>home</h1>");
    writeFileSync(join(dir, "app.js"), "console.log(1)");
    writeFileSync(join(dir, ".env"), "SECRET=1");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "index.html"), "<h1>docs</h1>");
    // Deterministic mtime so cache validators are stable.
    const when = new Date("2026-01-02T03:04:05Z");
    utimesSync(join(dir, "app.js"), when, when);
    return dir;
  }

  test("serves files, directory indexes, and falls through otherwise", async () => {
    const app = expressy();
    app.use(serveStatic(makeSite()));
    app.use((_req, res) => res.status(404).text("custom 404"));

    expect(await (await request(app, "/")).text()).toBe("<h1>home</h1>");
    expect(await (await request(app, "/docs")).text()).toBe("<h1>docs</h1>");
    expect((await request(app, "/app.js")).headers.get("content-type")).toContain("javascript");
    expect(await (await request(app, "/nope.txt")).text()).toBe("custom 404");
  });

  test("blocks traversal, null bytes, and dotfiles", async () => {
    const dir = makeSite();
    const app = expressy();
    app.use(serveStatic(dir));
    app.use((_req, res) => res.status(404).text("nope"));

    expect((await request(app, "/../../etc/passwd")).status).toBe(404);
    expect((await request(app, "/%00")).status).toBe(404);
    expect((await request(app, "/app.js%00")).status).toBe(404);
    expect((await request(app, "/.env")).status).toBe(404);

    const deny = expressy();
    deny.use(serveStatic(dir, { dotfiles: "deny" }));
    expect((await request(deny, "/.env")).status).toBe(403);

    const allow = expressy();
    allow.use(serveStatic(dir, { dotfiles: "allow" }));
    expect(await (await request(allow, "/.env")).text()).toBe("SECRET=1");
  });

  test("index:false does not serve directories", async () => {
    const app = expressy();
    app.use(serveStatic(makeSite(), { index: false }));
    expect((await request(app, "/")).status).toBe(404);
  });

  test("ETag / Last-Modified / Cache-Control and 304 on conditional GETs", async () => {
    const app = expressy();
    app.use(serveStatic(makeSite(), { maxAge: "1d", immutable: true }));

    const first = await request(app, "/app.js");
    const etag = first.headers.get("etag")!;
    const lastModified = first.headers.get("last-modified")!;
    expect(etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(lastModified).toBe("Fri, 02 Jan 2026 03:04:05 GMT");
    expect(first.headers.get("cache-control")).toBe("public, max-age=86400, immutable");

    const byEtag = await request(app, "/app.js", { headers: { "If-None-Match": etag } });
    expect(byEtag.status).toBe(304);
    expect(await byEtag.text()).toBe("");
    expect(byEtag.headers.get("etag")).toBe(etag);

    const byDate = await request(app, "/app.js", { headers: { "If-Modified-Since": lastModified } });
    expect(byDate.status).toBe(304);

    const stale = await request(app, "/app.js", { headers: { "If-None-Match": 'W/"deadbeef"' } });
    expect(stale.status).toBe(200);

    const older = await request(app, "/app.js", {
      headers: { "If-Modified-Since": "Thu, 01 Jan 2026 00:00:00 GMT" },
    });
    expect(older.status).toBe(200);
  });

  test("etag/lastModified can be disabled and setHeaders runs", async () => {
    const app = expressy();
    app.use(
      serveStatic(makeSite(), {
        etag: false,
        lastModified: false,
        setHeaders: (res) => res.set("X-Static", "yes"),
      }),
    );
    const res = await request(app, "/app.js");
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("last-modified")).toBeNull();
    expect(res.headers.get("x-static")).toBe("yes");
    expect(res.headers.get("cache-control")).toBe("public, max-age=0");
  });
});

describe("request extras", () => {
  test("req.xhr and lazy req.query", async () => {
    const app = expressy();
    app.get("/x", (req, res) => res.json({ xhr: req.xhr, q: req.query }));
    const res = await request(app, "/x?a=1&a=2&b=3", { headers: { "X-Requested-With": "XMLHttpRequest" } });
    expect(await res.json()).toEqual({ xhr: true, q: { a: ["1", "2"], b: "3" } });
  });

  test("app.get('env') defaults from NODE_ENV", () => {
    const app = expressy();
    expect(typeof app.get("env")).toBe("string");
  });
});

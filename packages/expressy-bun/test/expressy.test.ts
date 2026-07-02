import { describe, expect, test } from "bun:test";
import expressy, { Router, json, HttpError } from "../src/index";

const request = (app: ReturnType<typeof expressy>, path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

describe("routing", () => {
  test("matches method and path", async () => {
    const app = expressy();
    app.get("/hello", (_req, res) => res.text("hi"));

    const res = await request(app, "/hello");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi");

    const wrongMethod = await request(app, "/hello", { method: "POST" });
    expect(wrongMethod.status).toBe(404);
  });

  test("route params are captured and decoded", async () => {
    const app = expressy();
    app.get("/users/:id/posts/:postId", (req, res) => res.json(req.params));

    const res = await request(app, "/users/42/posts/caf%C3%A9");
    expect(await res.json()).toEqual({ id: "42", postId: "café" });
  });

  test("wildcard routes", async () => {
    const app = expressy();
    app.get("/files/*", (req, res) => res.text(req.params["*"]));

    const res = await request(app, "/files/a/b/c.txt");
    expect(await res.text()).toBe("a/b/c.txt");
  });

  test("query strings, including repeated keys", async () => {
    const app = expressy();
    app.get("/search", (req, res) => res.json(req.query));

    const res = await request(app, "/search?q=bun&tag=a&tag=b");
    expect(await res.json()).toEqual({ q: "bun", tag: ["a", "b"] });
  });

  test("trailing slash matches", async () => {
    const app = expressy();
    app.get("/about", (_req, res) => res.text("ok"));
    expect((await request(app, "/about/")).status).toBe(200);
  });

  test("HEAD falls back to GET handlers with an empty body", async () => {
    const app = expressy();
    app.get("/page", (_req, res) => res.send("<h1>body</h1>"));

    const res = await request(app, "/page", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("unknown routes get the default 404", async () => {
    const app = expressy();
    const res = await request(app, "/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Cannot GET /nope");
  });
});

describe("middleware", () => {
  test("runs in order and can short-circuit", async () => {
    const app = expressy();
    const order: string[] = [];
    app.use((_req, _res, next) => { order.push("first"); next(); });
    app.use((_req, _res, next) => { order.push("second"); next(); });
    app.get("/x", (_req, res) => { order.push("route"); res.end(); });

    await request(app, "/x");
    expect(order).toEqual(["first", "second", "route"]);
  });

  test("path-scoped middleware only runs under its prefix", async () => {
    const app = expressy();
    let ran = 0;
    app.use("/admin", (_req, _res, next) => { ran++; next(); });
    app.get("/admin/panel", (_req, res) => res.end());
    app.get("/public", (_req, res) => res.end());

    await request(app, "/admin/panel");
    await request(app, "/public");
    expect(ran).toBe(1);
  });

  test("json body parser populates req.body", async () => {
    const app = expressy();
    app.use(json());
    app.post("/echo", (req, res) => res.json(req.body));

    const res = await request(app, "/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bun" }),
    });
    expect(await res.json()).toEqual({ name: "bun" });
  });

  test("malformed JSON becomes a 400", async () => {
    const app = expressy();
    app.use(json());
    app.post("/echo", (req, res) => res.json(req.body));

    const res = await request(app, "/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("routers", () => {
  test("mounted routers see stripped paths and own params", async () => {
    const app = expressy();
    const api = new Router();
    api.get("/", (_req, res) => res.text("index"));
    api.get("/:id", (req, res) => res.json({ id: req.params.id }));
    app.use("/api/notes", api);

    expect(await (await request(app, "/api/notes")).text()).toBe("index");
    expect(await (await request(app, "/api/notes/7")).json()).toEqual({ id: "7" });
    expect((await request(app, "/api/other")).status).toBe(404);
  });

  test("params from the mount path merge with route params", async () => {
    const app = expressy();
    const posts = new Router();
    posts.get("/:postId", (req, res) => res.json(req.params));
    app.use("/users/:userId/posts", posts);

    const res = await request(app, "/users/9/posts/33");
    expect(await res.json()).toEqual({ userId: "9", postId: "33" });
  });
});

describe("errors", () => {
  test("thrown errors reach 4-arity error handlers", async () => {
    const app = expressy();
    app.get("/boom", () => { throw new Error("kaboom"); });
    app.use((err: unknown, _req: any, res: any, _next: any) => {
      res.status(500).json({ handled: (err as Error).message });
    });

    const res = await request(app, "/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ handled: "kaboom" });
  });

  test("async rejections are caught too", async () => {
    const app = expressy();
    app.get("/boom", async () => { throw new HttpError(418, "teapot"); });

    const res = await request(app, "/boom");
    expect(res.status).toBe(418);
  });

  test("next(err) skips normal handlers", async () => {
    const app = expressy();
    let skipped = true;
    app.get("/x", (_req, _res, next) => next(new HttpError(403)));
    app.use((_req, _res, next) => { skipped = false; next(); });

    const res = await request(app, "/x");
    expect(res.status).toBe(403);
    expect(skipped).toBe(true);
  });
});

describe("response helpers", () => {
  test("res.send picks sensible content types", async () => {
    const app = expressy();
    app.get("/str", (_req, res) => res.send("<b>hi</b>"));
    app.get("/obj", (_req, res) => res.send({ a: 1 }));

    const str = await request(app, "/str");
    expect(str.headers.get("content-type")).toContain("text/html");
    const obj = await request(app, "/obj");
    expect(obj.headers.get("content-type")).toContain("application/json");
    expect(await obj.json()).toEqual({ a: 1 });
  });

  test("redirect sets status and location", async () => {
    const app = expressy();
    app.get("/old", (_req, res) => res.redirect("/new", 301));

    const res = await request(app, "/old", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/new");
  });

  test("handlers may return a fetch Response directly", async () => {
    const app = expressy();
    app.get("/native", () => new Response("raw", { status: 201 }));

    const res = await request(app, "/native");
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("raw");
  });

  test("cookies serialize correctly", async () => {
    const app = expressy();
    app.get("/login", (_req, res) => {
      res.cookie("session", "abc 123", { httpOnly: true, sameSite: "Lax" });
      res.end();
    });

    const res = await request(app, "/login");
    expect(res.headers.get("set-cookie")).toBe(
      "session=abc%20123; Path=/; HttpOnly; SameSite=Lax",
    );
  });
});

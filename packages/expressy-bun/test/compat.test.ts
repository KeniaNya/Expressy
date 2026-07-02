import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import expressy, { Router, json, urlencoded, HttpError } from "../src/index";

const request = (app: ReturnType<typeof expressy>, path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

describe("express-compat API shape", () => {
  test("expressy.Router() works as a factory and with new", () => {
    const viaFactory = expressy.Router();
    const viaNew = new expressy.Router();
    expect(viaFactory).toBeInstanceOf(Router);
    expect(viaNew).toBeInstanceOf(Router);
  });

  test("expressy.json / expressy.urlencoded / expressy.static exist", () => {
    expect(typeof expressy.json).toBe("function");
    expect(typeof expressy.urlencoded).toBe("function");
    expect(typeof expressy.static).toBe("function");
    expect(typeof expressy.session).toBe("function");
  });
});

describe("app settings", () => {
  test("set/get/enable/disable", () => {
    const app = expressy();
    app.set("view engine", "html");
    expect(app.get("view engine")).toBe("html");
    app.enable("x");
    expect(app.enabled("x")).toBe(true);
    app.disable("x");
    expect(app.disabled("x")).toBe(true);
  });

  test("app.get still registers routes when handlers are given", async () => {
    const app = expressy();
    app.set("greeting", "hola");
    app.get("/greet", (req, res) => res.text(String(req.app?.get("greeting"))));
    expect(await (await request(app, "/greet")).text()).toBe("hola");
  });
});

describe("trust proxy", () => {
  test("req.ip honors X-Forwarded-For with numeric hops", async () => {
    const app = expressy();
    app.set("trust proxy", 1);
    app.get("/ip", (req, res) => res.json({ ip: req.ip ?? null }));

    const res = await request(app, "/ip", {
      headers: { "X-Forwarded-For": "203.0.113.7, 10.0.0.1" },
    });
    expect(await res.json()).toEqual({ ip: "10.0.0.1" });
  });

  test("req.protocol and req.secure honor X-Forwarded-Proto", async () => {
    const app = expressy();
    app.set("trust proxy", 1);
    app.get("/proto", (req, res) => res.json({ protocol: req.protocol, secure: req.secure }));

    const res = await request(app, "/proto", { headers: { "X-Forwarded-Proto": "https" } });
    expect(await res.json()).toEqual({ protocol: "https", secure: true });
  });

  test("forwarding headers are ignored without trust proxy", async () => {
    const app = expressy();
    app.get("/proto", (req, res) => res.json({ protocol: req.protocol }));
    const res = await request(app, "/proto", { headers: { "X-Forwarded-Proto": "https" } });
    expect(await res.json()).toEqual({ protocol: "http" });
  });
});

describe("request compat", () => {
  test("req.headers is a plain object with lowercase keys", async () => {
    const app = expressy();
    app.get("/h", (req, res) =>
      res.json({ accept: req.headers.accept, key: req.headers["x-api-key"] }),
    );
    const res = await request(app, "/h", {
      headers: { Accept: "application/json", "X-Api-Key": "sekrit" },
    });
    expect(await res.json()).toEqual({ accept: "application/json", key: "sekrit" });
  });

  test("req.cookies parses the Cookie header", async () => {
    const app = expressy();
    app.get("/c", (req, res) => res.json(req.cookies));
    const res = await request(app, "/c", { headers: { Cookie: "a=1; b=hello%20world" } });
    expect(await res.json()).toEqual({ a: "1", b: "hello world" });
  });

  test("req.baseUrl reflects the mount point, req.url the mount-relative url", async () => {
    const app = expressy();
    const router = new Router();
    router.get("/panel", (req, res) =>
      res.json({ baseUrl: req.baseUrl, url: req.url, path: req.path }),
    );
    app.use("/admin", router);

    const res = await request(app, "/admin/panel?x=1");
    expect(await res.json()).toEqual({ baseUrl: "/admin", url: "/panel?x=1", path: "/panel" });
  });
});

describe("response compat", () => {
  test("res.setHeader / res.getHeader Node-style aliases", async () => {
    const app = expressy();
    app.get("/dl", (_req, res) => {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="x.csv"');
      expect(res.getHeader("content-disposition")).toContain("x.csv");
      res.send("a,b\n1,2");
    });
    const res = await request(app, "/dl");
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  test("res.sendStatus sends the standard text", async () => {
    const app = expressy();
    app.get("/gone", (_req, res) => res.sendStatus(410));
    const res = await request(app, "/gone");
    expect(res.status).toBe(410);
    expect(await res.text()).toBe("Gone");
  });

  test("res.redirect accepts Express's (status, url) order too", async () => {
    const app = expressy();
    app.get("/a", (_req, res) => res.redirect(301, "/b"));
    const res = await request(app, "/a", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/b");
  });
});

describe("body parser options", () => {
  test("json limit produces a 413", async () => {
    const app = expressy();
    app.use(json({ limit: 16 }));
    app.post("/x", (req, res) => res.json(req.body));
    const res = await request(app, "/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ big: "x".repeat(100) }),
    });
    expect(res.status).toBe(413);
  });

  test("urlencoded extended parses bracket notation", async () => {
    const app = expressy();
    app.use(urlencoded({ extended: true }));
    app.post("/f", (req, res) => res.json(req.body));
    const res = await request(app, "/f", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "user[name]=lena&tags[]=a&tags[]=b&plain=1&rep=x&rep=y",
    });
    expect(await res.json()).toEqual({
      user: { name: "lena" },
      tags: ["a", "b"],
      plain: "1",
      rep: ["x", "y"],
    });
  });

  test("urlencoded extended ignores prototype-polluting keys", async () => {
    const app = expressy();
    app.use(urlencoded({ extended: true }));
    app.post("/f", (req, res) => res.json({ polluted: ({} as any).hacked ?? null }));
    const res = await request(app, "/f", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "__proto__[hacked]=yes",
    });
    expect(await res.json()).toEqual({ polluted: null });
  });
});

describe("view engine", () => {
  const makeViews = () => {
    const dir = mkdtempSync(join(tmpdir(), "expressy-views-"));
    writeFileSync(join(dir, "hello.html"), "unused - engine is mocked");
    return dir;
  };

  test("app.engine + res.render merge app.locals, res.locals, and options", async () => {
    const app = expressy();
    app.set("views", makeViews());
    app.set("view engine", "html");
    app.engine("html", (_path, opts: any, cb) => {
      cb(undefined, `site=${opts.site} user=${opts.user} title=${opts.title}`);
    });
    app.locals.site = "LenaLab";
    app.use((_req, res, next) => {
      res.locals.user = "kenia";
      next();
    });
    app.get("/", (_req, res) => res.render("hello", { title: "Inicio" }));

    const res = await request(app, "/");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("site=LenaLab user=kenia title=Inicio");
  });

  test("render errors reach the error middleware", async () => {
    const app = expressy();
    app.set("views", makeViews());
    app.set("view engine", "html");
    app.engine("html", (_path, _opts, cb) => cb(new HttpError(500, "template exploded")));
    app.get("/", (_req, res) => res.render("hello"));
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(500).json({ caught: err.message });
    });

    const res = await request(app, "/");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ caught: "template exploded" });
  });

  test("a custom View class via app.set('view') is honored (nunjucks contract)", async () => {
    const app = expressy();
    app.set("view engine", "html");
    // Mimics what nunjucks's `express:` option installs.
    class FakeNunjucksView {
      name: string;
      constructor(name: string, opts: { defaultEngine?: string }) {
        this.name = name.includes(".") ? name : `${name}.${opts.defaultEngine}`;
      }
      render(opts: Record<string, unknown>, cb: (err: unknown, html?: string) => void) {
        cb(undefined, `rendered:${this.name}:${opts.who}`);
      }
    }
    app.set("view", FakeNunjucksView);
    app.get("/", (_req, res) => res.render("home", { who: "lena" }));

    const res = await request(app, "/");
    expect(await res.text()).toBe("rendered:home.html:lena");
  });
});

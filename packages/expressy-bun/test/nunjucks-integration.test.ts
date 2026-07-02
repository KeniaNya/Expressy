import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error nunjucks has no bundled types
import nunjucks from "nunjucks";
import expressy, { session } from "../src/index";

const request = (app: ReturnType<typeof expressy>, path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

/**
 * Integration test replicating LenaStyle's exact setup: nunjucks configured
 * with the `express:` option (which installs its own View class through
 * `app.set("view", ...)`), a "view engine" of plain .html, session-backed
 * res.locals, and custom filters.
 */
describe("nunjucks integration (LenaStyle-style)", () => {
  function makeApp() {
    const views = mkdtempSync(join(tmpdir(), "expressy-nunjucks-"));
    writeFileSync(
      join(views, "perfil.html"),
      "<h1>Hola {{ user.name }}</h1><p>{{ flash }}</p><span>{{ monto | currency }}</span>",
    );
    writeFileSync(join(views, "404.html"), "<h1>No encontrado: {{ url }}</h1>");

    const app = expressy();
    app.set("trust proxy", 1);
    const env = nunjucks.configure(views, { autoescape: true, express: app, watch: false });
    env.addFilter("currency", (v: number) => `$${Number(v).toFixed(2)}`);
    app.set("view engine", "html");

    app.use(
      session({
        secret: "test-secret",
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 60_000, httpOnly: true, sameSite: "lax" },
      }),
    );
    // Same locals middleware pattern as LenaStyle's app.js.
    app.use((req, res, next) => {
      res.locals.user = req.session?.user ?? null;
      res.locals.flash = req.session?.flash ?? "";
      if (req.session) delete req.session.flash;
      next();
    });

    app.post("/login", async (req, res) => {
      await req.session!.regenerate();
      req.session!.user = { name: "Kenia" };
      req.session!.flash = "Bienvenida";
      await req.session!.save();
      res.redirect("/perfil");
    });
    app.get("/perfil", (_req, res) => res.render("perfil", { monto: 1234.5 }));
    app.use((req, res) => res.status(404).render("404", { url: req.originalUrl }));
    return app;
  }

  test("res.render goes through nunjucks's own View class with merged locals", async () => {
    const app = makeApp();

    const login = await request(app, "/login", { method: "POST", redirect: "manual" });
    expect(login.status).toBe(302);
    const cookie = login.headers
      .getSetCookie()
      .find((c) => c.startsWith("connect.sid="))!
      .split(";")[0];

    const perfil = await request(app, "/perfil", { headers: { Cookie: cookie } });
    expect(perfil.status).toBe(200);
    expect(perfil.headers.get("content-type")).toContain("text/html");
    const html = await perfil.text();
    expect(html).toContain("<h1>Hola Kenia</h1>");
    expect(html).toContain("<p>Bienvenida</p>"); // flash consumed
    expect(html).toContain("<span>$1234.50</span>"); // custom filter

    // Flash was deleted from the session -> second visit renders empty.
    const again = await request(app, "/perfil", { headers: { Cookie: cookie } });
    expect(await again.text()).toContain("<p></p>");
  });

  test("404 handler renders a template too", async () => {
    const app = makeApp();
    const res = await request(app, "/nada?x=1");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("No encontrado: /nada?x=1");
  });
});

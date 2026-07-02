import { describe, expect, test } from "bun:test";
import expressy, { session, MemoryStore } from "../src/index";

const request = (app: ReturnType<typeof expressy>, path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

/** Extract the session cookie ("name=value") from a Set-Cookie header. */
function sessionCookie(res: Response, name = "connect.sid"): string | null {
  for (const c of res.headers.getSetCookie()) {
    if (c.startsWith(`${name}=`)) return c.split(";")[0];
  }
  return null;
}

function loginApp(store = new MemoryStore()) {
  const app = expressy();
  app.use(
    session({
      secret: "keyboard cat",
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: "lax" },
      store,
    }),
  );
  app.post("/login", async (req, res) => {
    // Same promisified callback pattern LenaStyle uses.
    await new Promise<void>((resolve, reject) =>
      req.session!.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session!.user = { name: "kenia", rol: "admin" };
    await new Promise<void>((resolve, reject) =>
      req.session!.save((err) => (err ? reject(err) : resolve())),
    );
    res.redirect("/home");
  });
  app.get("/me", (req, res) => res.json({ user: req.session?.user ?? null }));
  app.post("/logout", (req, res) => {
    req.session!.destroy(() => res.redirect("/"));
  });
  return app;
}

describe("session()", () => {
  test("unmodified new sessions are not saved and get no cookie (saveUninitialized: false)", async () => {
    const app = expressy();
    app.use(session({ secret: "s3cret" }));
    app.get("/", (_req, res) => res.text("ok"));

    const res = await request(app, "/");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("modified sessions are saved, signed, and persist across requests", async () => {
    const app = expressy();
    app.use(session({ secret: "s3cret", cookie: { maxAge: 60_000 } }));
    app.get("/visit", (req, res) => {
      req.session!.views = ((req.session!.views as number) ?? 0) + 1;
      res.json({ views: req.session!.views });
    });

    const first = await request(app, "/visit");
    expect(await first.json()).toEqual({ views: 1 });
    const cookie = sessionCookie(first)!;
    expect(cookie).toContain("connect.sid=s%3A"); // signed, express-session wire format

    const second = await request(app, "/visit", { headers: { Cookie: cookie } });
    expect(await second.json()).toEqual({ views: 2 });
    // Existing session, rolling: false -> no new cookie.
    expect(sessionCookie(second)).toBeNull();
  });

  test("cookie attributes come from the config", async () => {
    const app = loginApp();
    const res = await request(app, "/login", { method: "POST", redirect: "manual" });
    const raw = res.headers.getSetCookie().find((c) => c.startsWith("connect.sid="))!;
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=lax");
    expect(raw).toContain("Expires=");
    expect(raw).not.toContain("Secure");
  });

  test("login flow: regenerate + save issue a fresh signed sid", async () => {
    const app = loginApp();

    const anon = await request(app, "/me");
    expect(await anon.json()).toEqual({ user: null });

    const login = await request(app, "/login", { method: "POST", redirect: "manual" });
    expect(login.status).toBe(302);
    const cookie = sessionCookie(login)!;
    expect(cookie).toBeTruthy();

    const me = await request(app, "/me", { headers: { Cookie: cookie } });
    expect(await me.json()).toEqual({ user: { name: "kenia", rol: "admin" } });
  });

  test("regenerate changes the session ID (session fixation defense)", async () => {
    const store = new MemoryStore();
    const app = expressy();
    app.use(session({ secret: "s", store, cookie: { maxAge: 60_000 } }));
    app.get("/seed", (req, res) => {
      req.session!.marker = "pre";
      res.json({ sid: req.sessionID });
    });
    app.post("/regen", async (req, res) => {
      const before = req.sessionID;
      await req.session!.regenerate();
      req.session!.user = "x";
      res.json({ before, after: req.sessionID, marker: req.session!.marker ?? null });
    });

    const seeded = await request(app, "/seed");
    const cookie = sessionCookie(seeded)!;
    const res = await request(app, "/regen", { method: "POST", headers: { Cookie: cookie } });
    const body = (await res.json()) as { before: string; after: string; marker: unknown };
    expect(body.before).not.toBe(body.after);
    expect(body.marker).toBeNull(); // fresh session, old data gone
    expect(sessionCookie(res)).toContain("connect.sid="); // new cookie for the new sid
  });

  test("destroy removes the session from the store", async () => {
    const store = new MemoryStore();
    const app = loginApp(store);

    const login = await request(app, "/login", { method: "POST", redirect: "manual" });
    const cookie = sessionCookie(login)!;

    await request(app, "/logout", { method: "POST", headers: { Cookie: cookie }, redirect: "manual" });

    const after = await request(app, "/me", { headers: { Cookie: cookie } });
    expect(await after.json()).toEqual({ user: null });
  });

  test("tampered signatures are rejected and produce a fresh session", async () => {
    const app = expressy();
    app.use(session({ secret: "s3cret", cookie: { maxAge: 60_000 } }));
    app.get("/visit", (req, res) => {
      req.session!.views = ((req.session!.views as number) ?? 0) + 1;
      res.json({ views: req.session!.views });
    });

    const first = await request(app, "/visit");
    const cookie = sessionCookie(first)!;
    const tampered = cookie.slice(0, -4) + "XXXX";

    const res = await request(app, "/visit", { headers: { Cookie: tampered } });
    expect(await res.json()).toEqual({ views: 1 }); // started over
  });

  test("expired sessions are evicted from the MemoryStore", async () => {
    const store = new MemoryStore();
    const app = expressy();
    app.use(session({ secret: "s", store, cookie: { maxAge: 5 } })); // 5ms
    app.get("/visit", (req, res) => {
      req.session!.views = ((req.session!.views as number) ?? 0) + 1;
      res.json({ views: req.session!.views });
    });

    const first = await request(app, "/visit");
    const cookie = sessionCookie(first)!;
    await new Promise((r) => setTimeout(r, 20));
    const res = await request(app, "/visit", { headers: { Cookie: cookie } });
    expect(await res.json()).toEqual({ views: 1 }); // expired -> fresh session
  });

  test("secret arrays: first signs, older secrets still verify", async () => {
    const store = new MemoryStore();
    const mkApp = (secret: string | string[]) => {
      const app = expressy();
      app.use(session({ secret, store, cookie: { maxAge: 60_000 } }));
      app.get("/visit", (req, res) => {
        req.session!.views = ((req.session!.views as number) ?? 0) + 1;
        res.json({ views: req.session!.views });
      });
      return app;
    };

    const oldApp = mkApp("old-secret");
    const first = await request(oldApp, "/visit");
    const cookie = sessionCookie(first)!;

    const rotated = mkApp(["new-secret", "old-secret"]);
    const res = await request(rotated, "/visit", { headers: { Cookie: cookie } });
    expect(await res.json()).toEqual({ views: 2 });
  });

  test("session data survives when the handler responds via res.render-style async paths", async () => {
    const app = expressy();
    app.use(session({ secret: "s", cookie: { maxAge: 60_000 } }));
    // CSRF-style middleware that lazily seeds a token, like LenaStyle.
    app.use((req, _res, next) => {
      if (!req.session!.csrfToken) req.session!.csrfToken = "tok123";
      next();
    });
    app.get("/form", (req, res) => res.json({ csrf: req.session!.csrfToken }));

    const first = await request(app, "/form");
    expect(await first.json()).toEqual({ csrf: "tok123" });
    const cookie = sessionCookie(first)!;
    expect(cookie).toBeTruthy(); // modified by the CSRF middleware -> saved

    const second = await request(app, "/form", { headers: { Cookie: cookie } });
    expect(await second.json()).toEqual({ csrf: "tok123" });
  });
});

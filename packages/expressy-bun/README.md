# ⚡ Expressy

An Express-like micro framework built directly on **`Bun.serve`**.
Zero dependencies, no build step — it's just a handful of TypeScript files that Bun runs natively.

```sh
bun add expressy-bun
```

```ts
import expressy from "expressy-bun";

const app = expressy();

app.get("/", (req, res) => res.send("Hello from Bun!"));
app.get("/users/:id", (req, res) => res.json({ id: req.params.id }));

app.listen(3000);
```

## Why

Express carries years of Node-era baggage (30+ transitive dependencies, callback-based streams, no native TypeScript). Bun already ships an extremely fast HTTP server — Expressy just adds the ergonomics you actually use: routing, middleware, params, and `res.json()`.

Coming from Express? Read **[MIGRATION.md](MIGRATION.md)** — an honest breakdown of what's a drop-in, what needs changing, and what isn't supported.

## Features

- **Express-style routing** — `app.get/post/put/patch/delete/head/options/all(path, ...handlers)`
- **Route params & wildcards** — `/users/:id`, `/files/*` (captured as `req.params["*"]`)
- **Middleware with `next()`** — including path-scoped mounts and Express-style 4-arity error handlers
- **Mountable routers** — `app.use("/api/notes", router)`, with mount-path params merging (`/users/:userId/posts` + `/:postId`)
- **Async everywhere** — `async` handlers just work; rejections flow into your error middleware
- **Body parsers** — `json()` and `urlencoded()` built in, with `limit` and qs-style `extended` options
- **Static files** — `serveStatic(dir)` using `Bun.file` (zero-copy sendfile, automatic MIME types)
- **Native sessions** — `session()` with the express-session API (signed cookies, stores, `regenerate`/`save`/`destroy`)
- **View engines** — `app.engine()`, `app.set("view engine", ...)`, `res.render()` with `app.locals`/`res.locals`; nunjucks's `express:` option works out of the box
- **Settings** — `app.set`/`app.get`/`enable`/`disable`, including `trust proxy` (X-Forwarded-For/-Proto/-Host)
- **fetch-native** — the app *is* a fetch handler; handlers may also return a plain `Response`

## API tour

### Application

```ts
const app = expressy();          // or: new App()

app.listen(3000);                            // returns the Bun server
app.listen({ port: 3000, hostname: "::" });

// The app is a fetch handler, so these work too:
Bun.serve({ port: 3000, fetch: app.fetch });
export default app;                          // bun run index.ts
await app.fetch(new Request("http://x/"));   // perfect for tests
```

### Routing

```ts
app.get("/notes/:id", (req, res) => { ... });
app.post("/notes", validate, create);        // multiple handlers per route
app.all("/anything", handler);               // every method

const api = new Router();
api.get("/", list);
api.get("/:id", show);
app.use("/api/notes", api);                  // api sees paths relative to the mount
```

### Request

| Property | Description |
|---|---|
| `req.params` | Route params (`:id`, `*`) — URL-decoded |
| `req.query` | Parsed query string; repeated keys become arrays |
| `req.body` | Set by `json()` / `urlencoded()` middleware |
| `req.path`, `req.originalUrl`, `req.url`, `req.baseUrl` | Current (mount-relative) path / original path+query / mount prefix |
| `req.method`, `req.headers`, `req.get(name)` | `req.headers` is a plain lowercase-keyed object, like Node/Express |
| `req.cookies` | Parsed `Cookie` header |
| `req.session`, `req.sessionID` | Set by the `session()` middleware |
| `req.hostname`, `req.protocol`, `req.secure`, `req.ip` | Connection info; honors the `trust proxy` setting |
| `req.is("json")` | Content-Type check |
| `await req.json()` / `req.text()` / `req.formData()` | Manual body reading (text/json are cached) |
| `req.raw` | The untouched fetch `Request` |

### Response

```ts
res.status(201).json({ ok: true });
res.send("<h1>html</h1>");        // strings → text/html, objects → JSON, Blob/BunFile pass through
res.text("plain"); res.html("<b>hi</b>");
res.set("X-Powered-By", "expressy").type("json");
res.setHeader("Content-Disposition", "attachment");  // Node-style aliases too
res.redirect("/login");           // both (url, status) and Express's (status, url) work
res.sendStatus(404);              // "Not Found"
res.render("perfil", { user });   // via app.engine / view engine setting
await res.sendFile("./report.pdf");
res.cookie("session", token, { httpOnly: true, sameSite: "Lax" });
res.locals.user = currentUser;    // per-request template locals
res.onFinish((res) => log(res.statusCode));  // fires after the response is sent
res.end();                        // empty body
```

### Sessions

Express-session-compatible, built in — same options, same signed-cookie wire
format, same store contract (callback-based, so `connect-mongo`-style stores plug in):

```ts
import expressy, { session } from "expressy-bun";

app.use(session({
  secret: process.env.SESSION_SECRET!,   // string or [newest, ...older] for rotation
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: "lax", secure: "auto" },
  // store: new MyStore(),               // defaults to MemoryStore (dev only)
}));

app.post("/login", async (req, res) => {
  await req.session.regenerate();        // promise or callback style
  req.session.user = { name: "Kenia" };
  await req.session.save();
  res.redirect("/");
});
app.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));
```

### Views

```ts
app.set("views", "./views");
app.set("view engine", "html");
app.engine("html", (path, locals, cb) => cb(null, myRender(path, locals)));
app.locals.site = "MyApp";                       // merged into every render
app.use((req, res, next) => { res.locals.user = req.session?.user; next(); });
app.get("/", (req, res) => res.render("home", { title: "Inicio" }));
```

Engines that install themselves through Express's View-class hook work as-is —
e.g. `nunjucks.configure("views", { express: app })`.

### Middleware & error handling

```ts
import expressy, { json, urlencoded, serveStatic, HttpError } from "expressy-bun";

app.use(json());                       // req.body for application/json
app.use(urlencoded());                 // req.body for form posts
app.use(serveStatic("./public"));      // falls through when no file matches
app.use("/admin", requireAuth);        // path-scoped

app.get("/notes/:id", (req) => {
  throw new HttpError(404, "No such note");   // status-aware errors
});

// 4 arguments = error handler (same rule as Express)
app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : 500;
  res.status(status).json({ error: err.message });
});
```

Anything unhandled falls back to a built-in 404 / error responder.

## Testing without a server

Because the app is a fetch handler, tests need no ports and no sockets:

```ts
import { test, expect } from "bun:test";

test("hello", async () => {
  const res = await app.fetch(new Request("http://localhost/hello"));
  expect(res.status).toBe(200);
});
```

Run the suite: `bun test`

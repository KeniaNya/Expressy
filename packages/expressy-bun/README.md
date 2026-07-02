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
- **Body parsers** — `json()` and `urlencoded()` built in
- **Static files** — `serveStatic(dir)` using `Bun.file` (zero-copy sendfile, automatic MIME types)
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
| `req.path`, `req.originalUrl` | Current (mount-relative) path / original path+query |
| `req.method`, `req.headers`, `req.get(name)` | The usual suspects |
| `req.hostname`, `req.protocol`, `req.secure`, `req.ip` | Connection info |
| `req.is("json")` | Content-Type check |
| `await req.json()` / `req.text()` / `req.formData()` | Manual body reading (text/json are cached) |
| `req.raw` | The untouched fetch `Request` |

### Response

```ts
res.status(201).json({ ok: true });
res.send("<h1>html</h1>");        // strings → text/html, objects → JSON, Blob/BunFile pass through
res.text("plain"); res.html("<b>hi</b>");
res.set("X-Powered-By", "expressy").type("json");
res.redirect("/login");           // res.redirect(url, 301)
await res.sendFile("./report.pdf");
res.cookie("session", token, { httpOnly: true, sameSite: "Lax" });
res.onFinish((res) => log(res.statusCode));  // fires after the response is sent
res.end();                        // empty body
```

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

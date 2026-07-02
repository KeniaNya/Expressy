# Migrating from Express — how much of a drop-in is Expressy?

**Short answer:** Expressy is *API-compatible*, not *ecosystem-compatible*. If your app is a plain JSON/HTML API built from routes, `req.params`/`req.query`/`req.body`, `res.status().json()`, routers, and your own middleware, migration is mostly changing imports — often 5–10 lines. If your app leans on third-party Express middleware, template engines, or Node's `http` internals (`res.write`, `req.pipe`), it is **not** a drop-in and those parts need rewriting.

Use this document as a checklist: skim [What works unchanged](#-what-works-unchanged), apply [What you must change](#-what-you-must-change-always), then scan [Not supported](#-not-supported) for anything your app uses.

---

## ✅ What works unchanged

These behave the same as Express, same signatures, same semantics:

| Feature | Notes |
|---|---|
| `app.get/post/put/patch/delete/head/options/all(path, ...handlers)` | Multiple handlers per route work |
| Middleware: `app.use(fn)`, `app.use("/prefix", fn)` | Prefix mounting strips the path for the mounted handler, like Express |
| `next()` / `next(err)` | Same chaining model |
| Error handlers = functions with **4 parameters** | Same arity-based detection as Express |
| Routers: `router.get(...)`, `app.use("/api", router)` | Mount-path params merge into `req.params` (`/users/:userId` + router `/:postId`) |
| Sub-apps: `app.use("/admin", otherApp)` | An `App` is a `Router` |
| Route params: `/users/:id` → `req.params.id` | URL-decoded, same as Express |
| `req.query` | Flat keys; repeated keys become arrays (see [query differences](#query-strings)) |
| `req.body` via body-parser middleware | `json()` / `urlencoded()` instead of `express.json()` / `express.urlencoded()` |
| `req.method`, `req.headers`, `req.get(name)`, `req.hostname`, `req.protocol`, `req.secure`, `req.ip`, `req.originalUrl`, `req.path` | |
| `res.status(code)`, `res.set()`, `res.get()`, `res.append()`, `res.type()` | Chainable, same as Express |
| `res.json(obj)`, `res.send(body)`, `res.end()` | `send()` does the same type sniffing: string→HTML, object→JSON |
| `res.redirect(url)` / `res.redirect(url, status)` | Note: Express is `redirect(status, url)` — **argument order is flipped** |
| `res.cookie(name, value, opts)` / `res.clearCookie(name)` | Same options (`httpOnly`, `maxAge` in ms, `sameSite`, ...) |
| Async handlers | Better than Express 4: rejections are caught and routed to error middleware automatically (Express 4 needs `express-async-errors` or manual `.catch(next)`) |
| Default 404 (`Cannot GET /path`) and default error responder | Error details hidden when `NODE_ENV=production`, like Express |
| `HEAD` requests falling back to `GET` handlers | Body stripped automatically |
| Trailing-slash tolerance (`/about` matches `/about/`) | |

---

## 🔧 What you must change (always)

### 1. Imports and app creation

```js
// Express
const express = require("express");
const app = express();
const router = express.Router();
app.use(express.json());
app.use(express.static("public"));
```

```ts
// Expressy
import expressy, { Router, json, serveStatic } from "expressy";
const app = expressy();
const router = new Router();        // class, not a factory call
app.use(json());
app.use(serveStatic("public"));
```

### 2. `app.listen` returns a Bun server, not `http.Server`

```ts
const server = app.listen(3000, (server) => {      // callback receives the Bun server
  console.log(`listening on ${server.port}`);
});
server.stop();                                      // not server.close()
```

### 3. Wildcard param name

```ts
app.get("/files/*", (req, res) => {
  req.params["*"];   // Expressy
  // req.params[0]   // Express 4
});
```

### 4. `res.redirect` argument order

```ts
res.redirect("/new-url", 301);   // Expressy: (url, status?)
// res.redirect(301, "/new");    // Express: (status, url)
```

### 5. Reading the body manually

`req` is **not** a Node stream. There is no `req.on("data")` / `req.pipe()`.

```ts
const text = await req.text();       // cached, safe to call twice
const data = await req.json();
const form = await req.formData();   // multipart & urlencoded
const stream = req.raw.body;         // web ReadableStream if you need one
```

---

## ❌ Not supported

If your app uses any of these, it is **not** a drop-in swap:

### The Express middleware ecosystem (the big one)

Third-party Express middleware (`morgan`, `helmet`, `cors`, `passport`, `multer`, `express-session`, `cookie-parser`, `compression`, ...) **will not work**. They mutate Node's `IncomingMessage`/`ServerResponse`, which don't exist here — Expressy wraps fetch `Request`/`Response`. Equivalents are usually a few lines of your own middleware:

```ts
// cors in ~6 lines
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// cookie-parser in ~5 lines
app.use((req, res, next) => {
  (req as any).cookies = Object.fromEntries(
    (req.get("cookie") ?? "").split("; ").filter(Boolean).map(c => {
      const i = c.indexOf("=");
      return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
    }),
  );
  next();
});
```

### Views / template engines

No `app.set("view engine", ...)`, no `app.engine()`, no `res.render()`, no `res.locals` / `app.locals`. Render HTML however you like (template literals, JSX via Bun, etc.) and send it with `res.html(...)`.

### Streaming with `res.write()`

`res` is a response *builder*: one terminal call (`send`/`json`/`end`/...) produces the whole response. There is no incremental `res.write()` / `res.flushHeaders()`. For streaming (SSE, large files), pass a web `ReadableStream` to `res.send(stream)` or return a fetch `Response` directly from the handler — both are first-class.

### Routing features

| Express | Expressy |
|---|---|
| RegExp paths: `app.get(/^\/ab?c/)` | ❌ strings only (`:param` and `*`) |
| Path arrays: `app.get(["/a", "/b"], h)` | ❌ register twice |
| Optional params: `/user/:id?` | ❌ register both routes |
| `next("route")` / `next("router")` | ❌ **any truthy argument to `next()` is treated as an error** — this is a silent behavior change, check your code for it |
| `app.param("id", fn)` | ❌ use middleware |
| `app.route("/x").get(...).post(...)` | ❌ register per method |

### Request / response API gaps

- `req.accepts()`, `req.acceptsLanguages()`, `req.fresh`, `req.stale`, `req.range`, `req.xhr`, `req.subdomains` — no content negotiation helpers. `req.is()` exists.
- `req.baseUrl`, `req.route` — not exposed (use `req.originalUrl` / `req.path`).
- `req.cookies` / `req.signedCookies` — not populated (see the 5-line cookie parser above).
- `res.sendStatus(404)` — use `res.status(404).end()`.
- `res.format()`, `res.attachment()`, `res.download()`, `res.vary()`, `res.links()`, `res.jsonp()` — not implemented.
- `res.headersSent` — use `res.finished`.
- `res.sendFile(path)` — exists but is `async` (call it with `await` or `return`) and resolves relative paths from the working directory; there is no `{ root }` option.
- `app.set()` / `app.get(settingName)` / `app.disable()` / `app.enable()` — no settings system; notably **no `trust proxy`**: `req.ip` is the direct socket address, so read `X-Forwarded-For` yourself when behind a proxy.

### Query strings

Express parses queries with `qs`, so `?filter[name]=x&list[0]=a` becomes nested objects. Expressy uses `URLSearchParams`: keys stay flat (`req.query["filter[name]"]`), and only repeated keys (`?tag=a&tag=b`) become arrays. If your clients send bracket-nested queries, that code needs adjusting.

### Node runtime

Expressy is Bun-only. It runs on `Bun.serve`, so Node.js (and Deno) are out.

---

## 🎁 What you get that Express doesn't have

- **Handlers can return a fetch `Response`** — anything fetch-native plugs straight in.
- **The app is a fetch handler**: `await app.fetch(new Request(...))` makes tests port-free and instant; `export default app` works with `bun run`.
- **`res.onFinish(cb)`** — clean hook for logging/metrics middleware.
- **`HttpError`** — `throw new HttpError(404, "no such note")` from anywhere, including async code.
- Zero dependencies, no build step, and Bun-level throughput.

---

## Verdict by app type

| Your Express app | Drop-in? |
|---|---|
| JSON REST API: routes, routers, params, `express.json()`, own middleware, central error handler | **Yes** — change imports, the wildcard name, and `redirect` arg order; done |
| Adds `cors` / `cookie-parser` / `morgan` | **Almost** — replace each with a few lines of your own middleware (samples above) |
| Uses `passport`, `express-session`, `multer` | **No** — auth/sessions/uploads need rewriting on web-standard APIs (`req.formData()` covers most `multer` cases) |
| Server-rendered views (`res.render`, EJS/Pug) | **No** — no view-engine layer |
| Streams responses with `res.write` / pipes Node streams | **No** — rework around `ReadableStream` / `Response` |
| Runs on Node.js and must stay there | **No** — Expressy requires Bun |

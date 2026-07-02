# Migrating from Express — how much of a drop-in is Expressy?

**Short answer:** Expressy is *API-compatible*, not *ecosystem-compatible*. If your app is built from routes, `req.params`/`req.query`/`req.body`/`req.session`, `res.status().json()`/`res.render()`, routers, and your own middleware, migration is mostly changing imports — often 2–5 lines. Sessions, view engines, settings (`trust proxy`), and cookies are built in. If your app leans on other third-party Express middleware or Node's `http` internals (`res.write`, `req.pipe`), those parts need rewriting.

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
| `req.method`, `req.headers`, `req.get(name)`, `req.hostname`, `req.protocol`, `req.secure`, `req.ip`, `req.originalUrl`, `req.url`, `req.path`, `req.baseUrl` | `req.headers` is a plain lowercase-keyed object, like Node/Express |
| `req.cookies` | Parsed from the `Cookie` header automatically |
| `req.session` / `req.sessionID` | Built-in `session()` middleware with the express-session API (see below) |
| `app.set()` / `app.get(name)` / `app.enable()` / `app.disable()` | Including `trust proxy` (X-Forwarded-For/-Proto/-Host, numeric hop counts) |
| `express.Router()`, `express.json()`, `express.urlencoded()`, `express.static()` | Same call shapes on the default export: `expressy.Router()`, `expressy.json({ limit: "2mb" })`, ... |
| `res.status(code)`, `res.set()`, `res.get()`, `res.append()`, `res.type()` | Chainable, same as Express; Node-style `res.setHeader()`/`getHeader()`/`removeHeader()` too |
| `res.json(obj)`, `res.send(body)`, `res.end()`, `res.sendStatus(code)` | `send()` does the same type sniffing: string→HTML, object→JSON, Buffer→octet-stream |
| `res.redirect(...)` | Accepts **both** `(url, status?)` and Express's `(status, url)` |
| `res.render(view, locals)`, `res.locals`, `app.locals`, `app.engine()`, `view engine`/`views` settings | Engines using Express's View-class hook (nunjucks `express:` option) work unchanged |
| `res.cookie(name, value, opts)` / `res.clearCookie(name)` | Same options (`httpOnly`, `maxAge` in ms, `sameSite`, ...) |
| Async handlers | Better than Express 4: rejections are caught and routed to error middleware automatically (Express 4 needs `express-async-errors` or manual `.catch(next)`) |
| Default 404 (`Cannot GET /path`) and default error responder | Error details hidden when `NODE_ENV=production`, like Express |
| `HEAD` requests falling back to `GET` handlers | Body stripped automatically |
| Trailing-slash tolerance (`/about` matches `/about/`) | |

---

## 🔧 What you must change (always)

### 1. Imports and app creation

The default export now carries the same statics as `express`, so the classic
style works with just the import changed:

```js
// Before: const express = require("express");
const express = require("expressy-bun");
const app = express();
const router = express.Router();               // factory call works
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.static("public"));
```

Or the named-import style if you prefer:

```ts
import expressy, { Router, json, serveStatic, session } from "expressy-bun";
const app = expressy();
const router = new Router();
```

`express-session` maps 1:1 to the built-in `session()`:

```js
// Before: const session = require("express-session");
const { session } = require("expressy-bun");
app.use(session({ secret, resave: false, saveUninitialized: false, cookie: { ... } }));
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

### 4. Reading the body manually

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

Third-party Express middleware (`morgan`, `helmet`, `cors`, `passport`, `multer`, `compression`, ...) **will not work**. They mutate Node's `IncomingMessage`/`ServerResponse`, which don't exist here — Expressy wraps fetch `Request`/`Response`. The two most common ones are already built in — `express-session` → `session()` (same API, same cookie format, same store contract) and `cookie-parser` → `req.cookies` (always populated). Equivalents for the rest are usually a few lines of your own middleware:

```ts
// cors in ~6 lines
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
```

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

- `req.accepts()`, `req.acceptsLanguages()`, `req.fresh`, `req.stale`, `req.range`, `req.xhr`, `req.subdomains` — no content negotiation helpers. `req.is()` exists; check `req.headers.accept` yourself.
- `req.route` — not exposed.
- `req.signedCookies` — the session cookie is signed, but there is no general signed-cookie API.
- `res.format()`, `res.attachment()`, `res.download()`, `res.vary()`, `res.links()`, `res.jsonp()` — not implemented.
- `res.sendFile(path)` — exists but is `async` (call it with `await` or `return`) and resolves relative paths from the working directory; there is no `{ root }` option.

### Query strings

Express parses queries with `qs`, so `?filter[name]=x&list[0]=a` becomes nested objects. Expressy uses `URLSearchParams`: keys stay flat (`req.query["filter[name]"]`), and only repeated keys (`?tag=a&tag=b`) become arrays. If your clients send bracket-nested **query strings**, that code needs adjusting. (Bracket-nested **form bodies** are fine: `urlencoded({ extended: true })` parses them.)

### Node runtime

Expressy is Bun-only. It runs on `Bun.serve`, so Node.js (and Deno) are out.

---

## 🎁 What you get that Express doesn't have

- **Handlers can return a fetch `Response`** — anything fetch-native plugs straight in.
- **The app is a fetch handler**: `await app.fetch(new Request(...))` makes tests port-free and instant; `export default app` works with `bun run`.
- **Sessions built in** — no `express-session` dependency; signed cookies via `node:crypto`, promise *and* callback styles on `regenerate`/`save`/`destroy`.
- **`res.onFinish(cb)`** — clean hook for logging/metrics middleware.
- **`HttpError`** — `throw new HttpError(404, "no such note")` from anywhere, including async code.
- Zero dependencies, no build step, and Bun-level throughput.

---

## Verdict by app type

| Your Express app | Drop-in? |
|---|---|
| JSON REST API: routes, routers, params, `express.json()`, own middleware, central error handler | **Yes** — change the import and the wildcard name; done |
| Server-rendered app: `express-session` + view engine (nunjucks) + `res.render` + `res.locals` + `trust proxy` | **Yes** — swap the two imports; nunjucks's `express:` option and the session config work unchanged |
| Adds `cors` / `morgan` / `helmet` | **Almost** — replace each with a few lines of your own middleware (samples above) |
| Uses `passport`, `multer` | **No** — auth strategies/uploads need rewriting on web-standard APIs (`req.formData()` covers most `multer` cases) |
| Streams responses with `res.write` / pipes Node streams | **No** — rework around `ReadableStream` / `Response` |
| Runs on Node.js and must stay there | **No** — Expressy requires Bun |

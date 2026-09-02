# Changelog

## 0.4.0 — 2026-09-02

Hardening pass plus the Express routing features that were still missing.

### Fixed

- **Body limit enforced while streaming.** Bodies without `Content-Length`
  (chunked uploads) were buffered in full before the limit was checked.
  They are now cut off as soon as the limit is crossed.
- **Empty JSON body yields `{}`**, like Express, instead of a 400.
- **`res.clearCookie()` drops `maxAge`** from the options it forwards, so the
  cookie is actually cleared. `res.cookie()` with `maxAge` now also emits a
  matching `Expires`, like Express.
- **`serveStatic` no longer throws on null bytes** in the path; it falls
  through like any other non-match.
- **HEAD responses cancel the unused body stream** instead of leaking it.
- **`next("route")` / `next("router")`** are now real control-flow signals
  (skip the rest of the route / leave the router) rather than being treated
  as errors.

### Changed

- **Routing is case-insensitive by default**, like Express. Opt out with
  `app.enable("case sensitive routing")` or `new Router({ caseSensitive: true })`.
  `strict routing` / `{ strict: true }` distinguishes trailing slashes.
- **`json()` is strict by default** (top-level objects and arrays only), like
  Express. Pass `{ strict: false }` to accept scalars.
- `HttpError` gains `statusCode` and `expose` (true for 4xx).
- `req.query` is parsed lazily on first access.
- Sync handlers no longer pay a microtask per layer.

### Added

- Routing: optional params (`/user/:id?`), path arrays, `RegExp` paths
  (capture groups become `req.params[0]`, ...), `app.route(path).get().post()`.
- Body parsers: `text()` and `raw()` (also `expressy.text` / `expressy.raw`).
- `serveStatic` options: `maxAge` (number or `"1d"`), `immutable`, `etag`,
  `lastModified`, `dotfiles`, `index: false`, `setHeaders`. Sends `ETag`,
  `Last-Modified` and `Cache-Control`; answers `If-None-Match` /
  `If-Modified-Since` with 304.
- Response: `res.vary()`, `res.location()`, `res.attachment()`,
  `res.download()`, `res.header()`; `res.sendFile(path, { root, headers })`;
  `res.type()` accepts extensions (`".png"`).
- Request: `req.xhr`; `app.get("env")` defaults from `NODE_ENV`.

## 0.3.0

- CommonJS entry (`require("expressy-bun")` returns the callable factory).
- Package metadata for npm (repository, homepage, bugs).

## 0.2.0

- Native `session()` with the express-session API and wire format.
- View engines (`app.engine`, `res.render`, Express View-class hook so
  nunjucks's `express:` option works), `app.locals` / `res.locals`.
- Settings (`app.set/get/enable/disable`), `trust proxy`, plain-object
  `req.headers`, `req.cookies`, `req.baseUrl`, Express-shaped statics on the
  default export (`expressy.Router()`, `.json()`, `.static()`, ...).

## 0.1.0

- Initial release: routing, middleware, routers, body parsers, static files,
  error handling, fetch-native app.

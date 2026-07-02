# Expressy workspace

A lightweight, zero-dependency, Express-like framework for Bun — plus a demo app that showcases it.

```
packages/expressy-bun/   The library (≈600 lines of TypeScript, no dependencies, no build step)
demo/                Notes app: REST API + static frontend built with the library
```

## Quick start

```sh
bun install        # links the workspace
bun test           # run the library's test suite (20 tests)
bun run demo       # start the demo at http://localhost:3000 (hot reload)
```

## The 10-second pitch

```ts
import expressy, { Router, json } from "expressy-bun";

const app = expressy();
app.use(json());

app.get("/hello/:name", (req, res) => {
  res.json({ hello: req.params.name });
});

app.listen(3000);
```

Same mental model as Express — routing, middleware, `next()`, error handlers, mountable routers — but running directly on `Bun.serve` with fetch-native `Request`/`Response` underneath and zero packages in `node_modules` (only `@types/bun` for editor types).

See [packages/expressy-bun/README.md](packages/expressy-bun/README.md) for the full API, [packages/expressy-bun/MIGRATION.md](packages/expressy-bun/MIGRATION.md) for an honest Express-compatibility breakdown (what's a drop-in, what isn't), and [demo/index.ts](demo/index.ts) for a complete, commented example.

## What the demo shows

| Feature | Where |
|---|---|
| Custom middleware (request logger with timing) | `app.use` at the top of [demo/index.ts](demo/index.ts) |
| JSON body parsing | `app.use(json())` |
| Mounted router with full CRUD | `app.use("/api/notes", api)` |
| Route params | `GET /api/greet/:name`, `GET /api/notes/:id` |
| Query strings | `GET /api/notes?q=search` |
| Validation middleware per-route | `api.post("/", validateNote, ...)` |
| `HttpError` + central error handler | `GET /api/boom`, the 4-arity handler at the bottom |
| Redirects | `GET /old-home` → `/` (301) |
| Static file serving | the frontend at `/` (`serveStatic`) |
| Custom 404s (JSON for API, HTML otherwise) | the catch-all middleware |

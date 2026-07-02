import expressy, { Router, json, serveStatic, HttpError } from "expressy-bun";
import type { Handler, ErrorHandler } from "expressy-bun";

const app = expressy();

// ── Custom middleware: request logger with timing ────────────────────────
app.use((req, res, next) => {
  const start = performance.now();
  res.onFinish(() => {
    const ms = (performance.now() - start).toFixed(1);
    console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ── Built-in JSON body parser ────────────────────────────────────────────
app.use(json());

// ── Notes API: a mountable Router with full CRUD ─────────────────────────
interface Note {
  id: number;
  title: string;
  content: string;
  createdAt: string;
}

const notes = new Map<number, Note>();
let nextId = 1;

const seed = (title: string, content: string) => {
  const note: Note = { id: nextId++, title, content, createdAt: new Date().toISOString() };
  notes.set(note.id, note);
};
seed("Welcome to Expressy", "An Express-like framework in a few hundred lines, powered by Bun.serve.");
seed("Zero dependencies", "Routing, middleware, params, body parsing and static files — no node_modules jungle.");

const findNote = (id: string): Note => {
  const note = notes.get(Number(id));
  if (!note) throw new HttpError(404, `Note ${id} not found`);
  return note;
};

const validateNote: Handler = (req, _res, next) => {
  const body = req.body as Partial<Note> | undefined;
  if (!body || typeof body.title !== "string" || !body.title.trim()) {
    throw new HttpError(422, "A note needs a non-empty 'title'");
  }
  next();
};

const api = new Router();

api.get("/", (req, res) => {
  let list = [...notes.values()];
  const q = req.query.q;
  if (typeof q === "string" && q) {
    const needle = q.toLowerCase();
    list = list.filter(
      (n) => n.title.toLowerCase().includes(needle) || n.content.toLowerCase().includes(needle),
    );
  }
  res.json(list);
});

api.get("/:id", (req, res) => res.json(findNote(req.params.id)));

api.post("/", validateNote, (req, res) => {
  const body = req.body as Pick<Note, "title" | "content">;
  const note: Note = {
    id: nextId++,
    title: body.title.trim(),
    content: body.content?.trim() ?? "",
    createdAt: new Date().toISOString(),
  };
  notes.set(note.id, note);
  res.status(201).json(note);
});

api.put("/:id", validateNote, (req, res) => {
  const note = findNote(req.params.id);
  const body = req.body as Pick<Note, "title" | "content">;
  note.title = body.title.trim();
  note.content = body.content?.trim() ?? "";
  res.json(note);
});

api.delete("/:id", (req, res) => {
  const note = findNote(req.params.id);
  notes.delete(note.id);
  res.status(204).end();
});

app.use("/api/notes", api);

// ── A few extra routes to show off features ──────────────────────────────
app.get("/api/greet/:name", (req, res) => {
  res.json({ greeting: `Hello, ${req.params.name}!`, from: req.ip ?? "unknown" });
});

app.get("/api/boom", () => {
  throw new Error("Something exploded (on purpose)");
});

app.get("/old-home", (_req, res) => res.redirect("/", 301));

// ── Static frontend ──────────────────────────────────────────────────────
app.use(serveStatic(`${import.meta.dir}/public`));

// ── 404 + error handling ─────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    res.status(404).json({ error: `No API route: ${req.method} ${req.path}` });
  } else {
    res.status(404).html("<h1>404</h1><p>Nothing here. Try <a href='/'>the homepage</a>.</p>");
  }
});

const errorHandler: ErrorHandler = (err, _req, res, _next) => {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : "Unknown error";
  res.status(status).json({ error: message });
};
app.use(errorHandler);

app.listen(Number(process.env.PORT ?? 3000), (server) => {
  console.log(`🚀 Expressy demo running at http://localhost:${server.port}`);
});

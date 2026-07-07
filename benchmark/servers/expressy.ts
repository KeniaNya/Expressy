// Expressy server — runs on Bun (Bun.serve). Started by the orchestrator.
// Implements the shared route contract (see servers/CONTRACT.md).
import expressy, { json } from "expressy-bun";
import { LARGE_PAYLOAD, PORT } from "./contract.mjs";

const app = expressy();

// Route-level middleware only where a scenario needs it, so global overhead
// stays out of the unrelated routes (keeps each scenario isolated).

app.get("/plaintext", (_req, res) => {
  res.set("Content-Type", "text/plain; charset=utf-8").send("Hello, World!");
});

app.get("/json", (_req, res) => {
  res.json({ message: "Hello, World!" });
});

app.get("/user/:id", (req, res) => {
  res.json({ id: req.params.id });
});

app.get("/search", (req, res) => {
  res.json({ q: req.query.q ?? null, limit: req.query.limit ?? null });
});

// A 5-deep middleware chain, mounted only on this route.
const step = (req: any, _res: any, next: () => void) => {
  req.steps = (req.steps ?? 0) + 1;
  next();
};
app.get("/middleware", step, step, step, step, step, (req: any, res) => {
  res.json({ steps: req.steps });
});

app.post("/echo", json(), (req, res) => {
  res.json({ received: req.body });
});

app.get("/json/large", (_req, res) => {
  res.json(LARGE_PAYLOAD);
});

app.listen(PORT, (server) => {
  // The orchestrator waits for this exact line before firing load.
  console.log(`READY ${server.port}`);
});

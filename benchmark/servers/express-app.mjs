// Official Express server. Runs on BOTH Node and Bun (started by the
// orchestrator with the matching runtime), implementing the same route
// contract as the Expressy server so the comparison is apples-to-apples.
import express from "express";
import { LARGE_PAYLOAD, PORT } from "./contract.mjs";

const app = express();

// Fairness knob: with EXPRESS_TUNED=1 we disable the two things Express does
// by default that Expressy does not (weak-ETag hashing + X-Powered-By header),
// so the "framework overhead" comparison isn't skewed by optional features.
if (process.env.EXPRESS_TUNED === "1") {
  app.set("etag", false);
  app.disable("x-powered-by");
}

app.get("/plaintext", (_req, res) => {
  res.type("text/plain").send("Hello, World!");
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

const step = (req, _res, next) => {
  req.steps = (req.steps ?? 0) + 1;
  next();
};
app.get("/middleware", step, step, step, step, step, (req, res) => {
  res.json({ steps: req.steps });
});

app.post("/echo", express.json(), (req, res) => {
  res.json({ received: req.body });
});

app.get("/json/large", (_req, res) => {
  res.json(LARGE_PAYLOAD);
});

app.listen(PORT, () => {
  console.log(`READY ${PORT}`);
});

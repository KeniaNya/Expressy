# Expressy vs Express — Benchmark

A fair, reproducible head-to-head between **Expressy** (this repo, built on `Bun.serve`)
and **official Express**, plus raw-runtime baselines.

## What it measures, and why it's fair

Expressy only runs on Bun; Express is usually run on Node. So "Expressy vs Express on Node"
secretly bundles *two* changes — the framework **and** the runtime. To separate them, the
harness runs **five** servers, all answering byte-identical responses on the same routes:

| Target | Runtime | Role |
|---|---|---|
| **Expressy · Bun** | Bun | the framework under test |
| **Express · Node** | Node | the real-world comparison ("what you'd deploy") |
| **Express · Bun** | Bun | same-runtime control → isolates *framework* overhead |
| **raw Bun.serve** | Bun | ceiling for anything on Bun |
| **raw node:http** | Node | ceiling for anything on Node |

With these, the report can say how much of any win is **Bun** (Express·Bun ÷ Express·Node)
versus **Expressy itself** (Expressy·Bun ÷ Express·Bun).

## Scenarios

Each hits one route to isolate a code path: plain text, small JSON, route params,
query-string parsing, a 5-deep middleware chain, JSON body parsing (`POST`), and a
larger 100-item JSON payload. See [`servers/`](servers) — all frameworks implement the
identical contract in [`contract.mjs`](servers/contract.mjs).

## Running it

```bash
cd benchmark
npm install              # express + autocannon
node smoke.mjs           # correctness gate: all servers must return identical bodies
node run.mjs             # full run (~10 min) → results.json
node report.mjs          # results.json → RESULTS.md
```

- `node run.mjs --quick` — short runs (~3 min) for a fast sanity pass.
- `EXPRESS_TUNED=1` (env) — disables Express's default ETag hashing + `X-Powered-By`
  to compare pure routing.

Load parameters (connections, durations, the concurrency sweep) live at the top of
[`run.mjs`](run.mjs).

## Methodology notes

- **Warmup then measure.** Every scenario runs a discarded warmup (JIT/JSC warmup matters
  a lot) before the timed run.
- **One server per process, restarted per target.** Each scenario gets its own warmup so
  cross-route JIT state is representative of a real multi-route server.
- **`NODE_ENV=production`** for every server.
- **Same client, same host.** autocannon drives all five identically. Because it shares the
  machine with the server, absolute rps is lower than dedicated hardware would show — but the
  **ratios between servers**, which is the point, hold.

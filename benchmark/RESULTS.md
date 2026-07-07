# Expressy vs Express — Benchmark Results

> Generated 2026-07-07T21:30:08.669Z

## Environment

| | |
|---|---|
| CPU | Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz (8 logical cores) |
| Memory | 17 GB |
| OS | win32 10.0.22621 |
| Bun | 1.2.2 |
| Node | v22.13.1 |
| Express | 5.2.1 |
| Load | 6s measured (after 2s warmup) · 64 connections · pipelining 1 |
| Client | autocannon (Node), same host as server |

Every server returns **byte-identical** responses on every route (verified by `smoke.mjs`), so each scenario measures the same work.

## Throughput — requests/sec

Higher is better. Best framework per row in **bold**.

| Scenario | Expressy · Bun | Express · Node | Express · Bun | raw Bun.serve | raw node:http |
|---|--:|--:|--:|--:|--:|
| Plain text | **15,015** | 4,310 | 11,151 | 14,319 | 14,243 |
| JSON (small) | **15,185** | 4,217 | 8,218 | 15,187 | 13,904 |
| Route params | **12,948** | 4,283 | 7,700 | 15,268 | 12,843 |
| Query string | **12,464** | 4,118 | 7,809 | 15,307 | 13,667 |
| Middleware ×5 | **13,589** | 4,146 | 8,465 | 15,313 | 14,283 |
| POST JSON echo | **10,733** | 3,505 | 4,245 | 15,345 | 11,781 |
| JSON (100 items) | **7,467** | 3,202 | 3,863 | 10,619 | 11,843 |

## Latency — milliseconds (p50 / p99)

Lower is better.

| Scenario | Expressy · Bun | Express · Node | Express · Bun |
|---|--:|--:|--:|
| Plain text | 3.0 / 10.0 | 14.0 / 55.0 | 5.0 / 10.0 |
| JSON (small) | 3.0 / 7.0 | 14.0 / 52.0 | 7.0 / 16.0 |
| Route params | 4.0 / 13.0 | 14.0 / 51.0 | 7.0 / 18.0 |
| Query string | 4.0 / 12.0 | 15.0 / 50.0 | 7.0 / 15.0 |
| Middleware ×5 | 4.0 / 9.0 | 14.0 / 50.0 | 7.0 / 14.0 |
| POST JSON echo | 5.0 / 11.0 | 17.0 / 23.0 | 14.0 / 29.0 |
| JSON (100 items) | 7.0 / 20.0 | 19.0 / 37.0 | 16.0 / 26.0 |

## Head-to-head

### 1. Expressy · Bun  vs  Express · Node  — *what you'd deploy*

Combines the framework **and** the runtime. This is the real-world question.

| Scenario | Expressy·Bun rps | Express·Node rps | Speedup |
|---|--:|--:|--:|
| Plain text | 15,015 | 4,310 | 3.48× (+248%) |
| JSON (small) | 15,185 | 4,217 | 3.60× (+260%) |
| Route params | 12,948 | 4,283 | 3.02× (+202%) |
| Query string | 12,464 | 4,118 | 3.03× (+203%) |
| Middleware ×5 | 13,589 | 4,146 | 3.28× (+228%) |
| POST JSON echo | 10,733 | 3,505 | 3.06× (+206%) |
| JSON (100 items) | 7,467 | 3,202 | 2.33× (+133%) |

**Geometric mean speedup: 3.09×** across scenarios.

### 2. Expressy · Bun  vs  Express · Bun  — *pure framework overhead*

Same runtime (Bun) on both sides, so this isolates the framework's own cost.

| Scenario | Expressy·Bun rps | Express·Bun rps | Speedup |
|---|--:|--:|--:|
| Plain text | 15,015 | 11,151 | 1.35× (+35%) |
| JSON (small) | 15,185 | 8,218 | 1.85× (+85%) |
| Route params | 12,948 | 7,700 | 1.68× (+68%) |
| Query string | 12,464 | 7,809 | 1.60× (+60%) |
| Middleware ×5 | 13,589 | 8,465 | 1.61× (+61%) |
| POST JSON echo | 10,733 | 4,245 | 2.53× (+153%) |
| JSON (100 items) | 7,467 | 3,863 | 1.93× (+93%) |

**Geometric mean: 1.76×** — the share of the win attributable to Expressy itself.

### 3. How much is Bun, how much is Expressy?

Runtime effect = Express·Bun ÷ Express·Node (same framework, swap runtime).

| Scenario | Runtime effect (Bun vs Node) | Framework effect (Expressy vs Express, on Bun) |
|---|--:|--:|
| Plain text | 2.59× | 1.35× |
| JSON (small) | 1.95× | 1.85× |
| Route params | 1.80× | 1.68× |
| Query string | 1.90× | 1.60× |
| Middleware ×5 | 2.04× | 1.61× |
| POST JSON echo | 1.21× | 2.53× |
| JSON (100 items) | 1.21× | 1.93× |

## Efficiency vs the raw runtime ceiling

What fraction of the bare server's throughput each framework keeps (higher = thinner overhead).

| Scenario | Expressy ÷ raw Bun | Express·Bun ÷ raw Bun | Express·Node ÷ raw Node |
|---|--:|--:|--:|
| Plain text | 105% | 78% | 30% |
| JSON (small) | 100% | 54% | 30% |
| Route params | 85% | 50% | 33% |
| Query string | 81% | 51% | 30% |
| Middleware ×5 | 89% | 55% | 29% |
| POST JSON echo | 70% | 28% | 30% |
| JSON (100 items) | 70% | 36% | 27% |

## Concurrency scaling — JSON scenario

Throughput (rps) as connections grow.

| Connections | Expressy · Bun | Express · Node | Express · Bun |
|--:|--:|--:|--:|
| 16 | 15,329 | 4,332 | 7,253 |
| 64 | 15,185 | 4,217 | 8,218 |
| 256 | 14,849 | 4,106 | 9,225 |

## Notes & caveats

- **Same-host load.** The client (autocannon) runs on the same machine as the server, so both compete for CPU. Absolute numbers would be higher on dedicated hardware; the *ratios between servers* are the takeaway.
- **Express defaults.** Express is measured as-shipped, which by default computes a weak ETag (hashes each body) and sends `X-Powered-By`. Expressy does neither. Set `EXPRESS_TUNED=1` to disable both and re-measure pure routing.
- **Expressy runs only on Bun.** It's built on `Bun.serve` + fetch `Request`/`Response`, so "Expressy vs Express·Node" bundles a runtime change. Section 2 (both on Bun) isolates the framework.
- **Single machine, one run.** Treat these as directional. Re-run with `node run.mjs` for a fresh sample; use `--quick` for a fast sanity pass.

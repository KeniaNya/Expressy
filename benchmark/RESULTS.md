# Expressy vs Express — Benchmark Results

> Generated 2026-09-02T15:29:55.027Z

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
| Plain text | **11,735** | 3,413 | 7,510 | 11,639 | 11,265 |
| JSON (small) | **11,895** | 3,457 | 7,713 | 11,644 | 10,560 |
| Route params | **11,817** | 3,402 | 7,194 | 11,769 | 10,856 |
| Query string | **11,667** | 3,381 | 7,998 | 12,848 | 10,492 |
| Middleware ×5 | **12,147** | 3,375 | 8,284 | 12,851 | 11,028 |
| POST JSON echo | **9,270** | 2,830 | 4,971 | 12,413 | 8,791 |
| JSON (100 items) | **7,401** | 2,573 | 4,462 | 8,186 | 9,283 |

## Latency — milliseconds (p50 / p99)

Lower is better.

| Scenario | Expressy · Bun | Express · Node | Express · Bun |
|---|--:|--:|--:|
| Plain text | 4.0 / 12.0 | 14.0 / 85.0 | 7.0 / 21.0 |
| JSON (small) | 4.0 / 12.0 | 14.0 / 67.0 | 7.0 / 19.0 |
| Route params | 4.0 / 13.0 | 14.0 / 80.0 | 7.0 / 23.0 |
| Query string | 4.0 / 15.0 | 14.0 / 78.0 | 6.0 / 18.0 |
| Middleware ×5 | 4.0 / 14.0 | 15.0 / 81.0 | 6.0 / 22.0 |
| POST JSON echo | 5.0 / 18.0 | 21.0 / 35.0 | 11.0 / 28.0 |
| JSON (100 items) | 8.0 / 16.0 | 24.0 / 48.0 | 13.0 / 32.0 |

## Head-to-head

### 1. Expressy · Bun  vs  Express · Node  — *what you'd deploy*

Combines the framework **and** the runtime. This is the real-world question.

| Scenario | Expressy·Bun rps | Express·Node rps | Speedup |
|---|--:|--:|--:|
| Plain text | 11,735 | 3,413 | 3.44× (+244%) |
| JSON (small) | 11,895 | 3,457 | 3.44× (+244%) |
| Route params | 11,817 | 3,402 | 3.47× (+247%) |
| Query string | 11,667 | 3,381 | 3.45× (+245%) |
| Middleware ×5 | 12,147 | 3,375 | 3.60× (+260%) |
| POST JSON echo | 9,270 | 2,830 | 3.28× (+228%) |
| JSON (100 items) | 7,401 | 2,573 | 2.88× (+188%) |

**Geometric mean speedup: 3.36×** across scenarios.

### 2. Expressy · Bun  vs  Express · Bun  — *pure framework overhead*

Same runtime (Bun) on both sides, so this isolates the framework's own cost.

| Scenario | Expressy·Bun rps | Express·Bun rps | Speedup |
|---|--:|--:|--:|
| Plain text | 11,735 | 7,510 | 1.56× (+56%) |
| JSON (small) | 11,895 | 7,713 | 1.54× (+54%) |
| Route params | 11,817 | 7,194 | 1.64× (+64%) |
| Query string | 11,667 | 7,998 | 1.46× (+46%) |
| Middleware ×5 | 12,147 | 8,284 | 1.47× (+47%) |
| POST JSON echo | 9,270 | 4,971 | 1.86× (+86%) |
| JSON (100 items) | 7,401 | 4,462 | 1.66× (+66%) |

**Geometric mean: 1.59×** — the share of the win attributable to Expressy itself.

### 3. How much is Bun, how much is Expressy?

Runtime effect = Express·Bun ÷ Express·Node (same framework, swap runtime).

| Scenario | Runtime effect (Bun vs Node) | Framework effect (Expressy vs Express, on Bun) |
|---|--:|--:|
| Plain text | 2.20× | 1.56× |
| JSON (small) | 2.23× | 1.54× |
| Route params | 2.11× | 1.64× |
| Query string | 2.37× | 1.46× |
| Middleware ×5 | 2.45× | 1.47× |
| POST JSON echo | 1.76× | 1.86× |
| JSON (100 items) | 1.73× | 1.66× |

## Efficiency vs the raw runtime ceiling

What fraction of the bare server's throughput each framework keeps (higher = thinner overhead).

| Scenario | Expressy ÷ raw Bun | Express·Bun ÷ raw Bun | Express·Node ÷ raw Node |
|---|--:|--:|--:|
| Plain text | 101% | 65% | 30% |
| JSON (small) | 102% | 66% | 33% |
| Route params | 100% | 61% | 31% |
| Query string | 91% | 62% | 32% |
| Middleware ×5 | 95% | 64% | 31% |
| POST JSON echo | 75% | 40% | 32% |
| JSON (100 items) | 90% | 55% | 28% |

## Concurrency scaling — JSON scenario

Throughput (rps) as connections grow.

| Connections | Expressy · Bun | Express · Node | Express · Bun |
|--:|--:|--:|--:|
| 16 | 12,069 | 3,519 | 7,731 |
| 64 | 11,895 | 3,457 | 7,713 |
| 256 | 11,455 | 2,633 | 7,665 |

## Notes & caveats

- **Same-host load.** The client (autocannon) runs on the same machine as the server, so both compete for CPU. Absolute numbers would be higher on dedicated hardware; the *ratios between servers* are the takeaway.
- **Express defaults.** Express is measured as-shipped, which by default computes a weak ETag (hashes each body) and sends `X-Powered-By`. Expressy does neither. Set `EXPRESS_TUNED=1` to disable both and re-measure pure routing.
- **Expressy runs only on Bun.** It's built on `Bun.serve` + fetch `Request`/`Response`, so "Expressy vs Express·Node" bundles a runtime change. Section 2 (both on Bun) isolates the framework.
- **Single machine, one run.** Treat these as directional. Re-run with `node run.mjs` for a fresh sample; use `--quick` for a fast sanity pass.

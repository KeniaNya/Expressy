// Turns results.json into RESULTS.md — a human-readable report with throughput
// tables, latency percentiles, and the two comparisons that matter:
//   1. Expressy·Bun vs Express·Node  — what you'd actually deploy
//   2. Expressy·Bun vs Express·Bun   — pure framework overhead (same runtime)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { meta, results } = JSON.parse(readFileSync(join(__dirname, "results.json"), "utf8"));

const TARGET_ORDER = ["expressy-bun", "express-node", "express-bun", "raw-bun", "raw-node"];
const LABELS = {
  "expressy-bun": "Expressy · Bun",
  "express-node": "Express · Node",
  "express-bun": "Express · Bun",
  "raw-bun": "raw Bun.serve",
  "raw-node": "raw node:http",
};
const SCEN_ORDER = ["plaintext", "json", "params", "query", "middleware", "post-json", "json-large"];
const SCEN_TITLE = Object.fromEntries(results.map((r) => [r.scenario, r.scenarioTitle]));
const BASE = meta.config.baseConnections;

const at = (target, scenario, conn = BASE, sweep = false) =>
  results.find((r) => r.target === target && r.scenario === scenario && r.connections === conn && !!r.sweep === sweep);

const fmt = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
const fmt1 = (n) => (n == null ? "—" : n.toFixed(1));
const kb = (bytes) => (bytes == null ? "—" : (bytes / 1024).toFixed(0));
const ratio = (a, b) => (a == null || b == null || b === 0 ? null : a / b);
const pct = (r) => (r == null ? "—" : `${r >= 1 ? "+" : ""}${((r - 1) * 100).toFixed(0)}%`);
const xfaster = (r) => (r == null ? "—" : `${r.toFixed(2)}×`);

let md = "";
const P = (s = "") => (md += s + "\n");

P("# Expressy vs Express — Benchmark Results\n");
P(`> Generated ${meta.date}${meta.quick ? " · **QUICK mode** (short runs, indicative only)" : ""}\n`);
P("## Environment\n");
P(`| | |`);
P(`|---|---|`);
P(`| CPU | ${meta.machine.cpu} (${meta.machine.cores} logical cores) |`);
P(`| Memory | ${meta.machine.memGB} GB |`);
P(`| OS | ${meta.machine.platform} |`);
P(`| Bun | ${meta.versions.bun} |`);
P(`| Node | ${meta.versions.node} |`);
P(`| Express | ${meta.versions.express} |`);
P(`| Load | ${meta.config.durationS}s measured (after ${meta.config.warmupS}s warmup) · ${BASE} connections · pipelining ${meta.config.pipelining} |`);
P(`| Client | autocannon (Node), same host as server |`);
P("");
P("Every server returns **byte-identical** responses on every route (verified by `smoke.mjs`), so each scenario measures the same work.\n");

// ── Throughput table ─────────────────────────────────────────────────────────
P("## Throughput — requests/sec\n");
P("Higher is better. Best framework per row in **bold**.\n");
P(`| Scenario | ${TARGET_ORDER.map((t) => LABELS[t]).join(" | ")} |`);
P(`|---|${TARGET_ORDER.map(() => "--:").join("|")}|`);
for (const s of SCEN_ORDER) {
  const vals = TARGET_ORDER.map((t) => at(t, s)?.rps);
  const frameworkVals = ["expressy-bun", "express-node", "express-bun"].map((t) => at(t, s)?.rps);
  const bestFw = Math.max(...frameworkVals.filter((v) => v != null));
  const cells = TARGET_ORDER.map((t, i) => {
    const v = vals[i];
    const isBestFw = v != null && v === bestFw;
    return isBestFw ? `**${fmt(v)}**` : fmt(v);
  });
  P(`| ${SCEN_TITLE[s]} | ${cells.join(" | ")} |`);
}
P("");

// ── Latency table ────────────────────────────────────────────────────────────
P("## Latency — milliseconds (p50 / p99)\n");
P("Lower is better.\n");
P(`| Scenario | ${["expressy-bun", "express-node", "express-bun"].map((t) => LABELS[t]).join(" | ")} |`);
P(`|---|${["", "", ""].map(() => "--:").join("|")}|`);
for (const s of SCEN_ORDER) {
  const cells = ["expressy-bun", "express-node", "express-bun"].map((t) => {
    const r = at(t, s);
    return r ? `${fmt1(r.latency.p50)} / ${fmt1(r.latency.p99)}` : "—";
  });
  P(`| ${SCEN_TITLE[s]} | ${cells.join(" | ")} |`);
}
P("");

// ── Headline comparisons ─────────────────────────────────────────────────────
P("## Head-to-head\n");
P("### 1. Expressy · Bun  vs  Express · Node  — *what you'd deploy*\n");
P("Combines the framework **and** the runtime. This is the real-world question.\n");
P(`| Scenario | Expressy·Bun rps | Express·Node rps | Speedup |`);
P(`|---|--:|--:|--:|`);
const geo = [];
for (const s of SCEN_ORDER) {
  const e = at("expressy-bun", s)?.rps;
  const x = at("express-node", s)?.rps;
  const r = ratio(e, x);
  if (r) geo.push(r);
  P(`| ${SCEN_TITLE[s]} | ${fmt(e)} | ${fmt(x)} | ${xfaster(r)} (${pct(r)}) |`);
}
const geomean = (arr) => Math.exp(arr.reduce((a, b) => a + Math.log(b), 0) / arr.length);
P(`\n**Geometric mean speedup: ${xfaster(geomean(geo))}** across scenarios.\n`);

P("### 2. Expressy · Bun  vs  Express · Bun  — *pure framework overhead*\n");
P("Same runtime (Bun) on both sides, so this isolates the framework's own cost.\n");
P(`| Scenario | Expressy·Bun rps | Express·Bun rps | Speedup |`);
P(`|---|--:|--:|--:|`);
const geo2 = [];
for (const s of SCEN_ORDER) {
  const e = at("expressy-bun", s)?.rps;
  const x = at("express-bun", s)?.rps;
  const r = ratio(e, x);
  if (r) geo2.push(r);
  P(`| ${SCEN_TITLE[s]} | ${fmt(e)} | ${fmt(x)} | ${xfaster(r)} (${pct(r)}) |`);
}
P(`\n**Geometric mean: ${xfaster(geomean(geo2))}** — the share of the win attributable to Expressy itself.\n`);

// ── How much is runtime vs framework ─────────────────────────────────────────
P("### 3. How much is Bun, how much is Expressy?\n");
P("Runtime effect = Express·Bun ÷ Express·Node (same framework, swap runtime).\n");
P(`| Scenario | Runtime effect (Bun vs Node) | Framework effect (Expressy vs Express, on Bun) |`);
P(`|---|--:|--:|`);
for (const s of SCEN_ORDER) {
  const runtimeR = ratio(at("express-bun", s)?.rps, at("express-node", s)?.rps);
  const fwR = ratio(at("expressy-bun", s)?.rps, at("express-bun", s)?.rps);
  P(`| ${SCEN_TITLE[s]} | ${xfaster(runtimeR)} | ${xfaster(fwR)} |`);
}
P("");

// ── Efficiency vs ceiling ────────────────────────────────────────────────────
P("## Efficiency vs the raw runtime ceiling\n");
P("What fraction of the bare server's throughput each framework keeps (higher = thinner overhead).\n");
P(`| Scenario | Expressy ÷ raw Bun | Express·Bun ÷ raw Bun | Express·Node ÷ raw Node |`);
P(`|---|--:|--:|--:|`);
for (const s of SCEN_ORDER) {
  const eBun = ratio(at("expressy-bun", s)?.rps, at("raw-bun", s)?.rps);
  const xBun = ratio(at("express-bun", s)?.rps, at("raw-bun", s)?.rps);
  const xNode = ratio(at("express-node", s)?.rps, at("raw-node", s)?.rps);
  const p = (r) => (r == null ? "—" : `${(r * 100).toFixed(0)}%`);
  P(`| ${SCEN_TITLE[s]} | ${p(eBun)} | ${p(xBun)} | ${p(xNode)} |`);
}
P("");

// ── Concurrency sweep ────────────────────────────────────────────────────────
P("## Concurrency scaling — JSON scenario\n");
P("Throughput (rps) as connections grow.\n");
const sweepConns = meta.config.sweepConnections;
P(`| Connections | ${["expressy-bun", "express-node", "express-bun"].map((t) => LABELS[t]).join(" | ")} |`);
P(`|--:|${["", "", ""].map(() => "--:").join("|")}|`);
for (const c of sweepConns) {
  const cells = ["expressy-bun", "express-node", "express-bun"].map((t) => {
    const r = c === BASE ? at(t, "json", c, false) : at(t, "json", c, true);
    return fmt(r?.rps);
  });
  P(`| ${c} | ${cells.join(" | ")} |`);
}
P("");

// ── Notes ────────────────────────────────────────────────────────────────────
P("## Notes & caveats\n");
P("- **Same-host load.** The client (autocannon) runs on the same machine as the server, so both compete for CPU. Absolute numbers would be higher on dedicated hardware; the *ratios between servers* are the takeaway.");
P("- **Express defaults.** Express is measured as-shipped, which by default computes a weak ETag (hashes each body) and sends `X-Powered-By`. Expressy does neither. Set `EXPRESS_TUNED=1` to disable both and re-measure pure routing.");
P("- **Expressy runs only on Bun.** It's built on `Bun.serve` + fetch `Request`/`Response`, so \"Expressy vs Express·Node\" bundles a runtime change. Section 2 (both on Bun) isolates the framework.");
P("- **Single machine, one run.** Treat these as directional. Re-run with `node run.mjs` for a fresh sample; use `--quick` for a fast sanity pass.");

const outPath = join(__dirname, "RESULTS.md");
writeFileSync(outPath, md);
console.log(`Wrote ${outPath}`);

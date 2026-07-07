// Benchmark orchestrator.
//
// For each target (framework + runtime) it spawns the server, waits for its
// READY line, then drives autocannon through every scenario, recording rps and
// latency percentiles. Results are written to results.json for report.mjs.
//
// Runs on Node so autocannon (a Node HTTP client) is on its home turf; the
// servers under test are spawned with their own runtime (bun or node).
import autocannon from "autocannon";
import { spawn, execSync } from "node:child_process";
import { createConnection } from "node:net";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUICK = process.argv.includes("--quick");
const PORT = 3100;
const HOST = "127.0.0.1";

// ── Load config ────────────────────────────────────────────────────────────
const BASE_CONN = 64;
const SWEEP_CONN = [16, 64, 256];
const WARMUP_S = QUICK ? 1 : 2;
const DURATION_S = QUICK ? 3 : 6;
const TRIALS = QUICK ? 1 : 3; // median of N measured runs per data point (kills noise)

// ── Resolve the bun executable (node is the one running us) ─────────────────
// Prefer the env-derived path: `where bun` prints in the OEM code page, which
// Node mis-decodes when the home dir has non-ASCII chars (e.g. "INGENIERÍA").
function findBun() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    for (const p of [join(home, ".bun", "bin", "bun.exe"), join(home, ".bun", "bin", "bun")]) {
      if (existsSync(p)) return p;
    }
  }
  try {
    const cmd = process.platform === "win32" ? "where bun" : "which bun";
    const out = execSync(cmd, { encoding: "utf8" }).trim().split(/\r?\n/);
    return out.find((l) => /bun(\.exe)?$/i.test(l.trim())) ?? out[0];
  } catch {
    return "bun";
  }
}
const BUN = findBun();
const NODE = process.execPath;

// ── Targets: (framework × runtime) plus raw-runtime ceilings ────────────────
const TARGETS = [
  { key: "expressy-bun", label: "Expressy · Bun", runtime: "bun", file: "servers/expressy.ts", group: "framework" },
  { key: "express-node", label: "Express · Node", runtime: "node", file: "servers/express-app.mjs", group: "framework" },
  { key: "express-bun", label: "Express · Bun", runtime: "bun", file: "servers/express-app.mjs", group: "framework" },
  { key: "raw-bun", label: "raw Bun.serve", runtime: "bun", file: "servers/raw-bun.ts", group: "baseline" },
  { key: "raw-node", label: "raw node:http", runtime: "node", file: "servers/raw-node.mjs", group: "baseline" },
];

// ── Scenarios: one route each, chosen to isolate a code path ────────────────
const POST_BODY = JSON.stringify({ name: "Ada", role: "admin", tags: ["x", "y", "z"] });
const SCENARIOS = [
  { key: "plaintext", title: "Plain text", method: "GET", path: "/plaintext" },
  { key: "json", title: "JSON (small)", method: "GET", path: "/json" },
  { key: "params", title: "Route params", method: "GET", path: "/user/42" },
  { key: "query", title: "Query string", method: "GET", path: "/search?q=hello&limit=10" },
  { key: "middleware", title: "Middleware ×5", method: "GET", path: "/middleware" },
  { key: "post-json", title: "POST JSON echo", method: "POST", path: "/echo",
    body: POST_BODY, headers: { "content-type": "application/json" } },
  { key: "json-large", title: "JSON (100 items)", method: "GET", path: "/json/large" },
];

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: HOST, port });
    sock.setTimeout(400);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => resolve(false));
  });
}

async function waitPortFree(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (!(await portOpen(port))) return;
    await sleep(150);
  }
}

function startServer(target) {
  const exe = target.runtime === "bun" ? BUN : NODE;
  const args = target.runtime === "bun"
    ? ["run", join(__dirname, target.file)]
    : [join(__dirname, target.file)];
  const child = spawn(exe, args, {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const ready = new Promise((resolve, reject) => {
    let out = "";
    const onData = (d) => {
      out += d.toString();
      if (out.includes("READY")) resolve();
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) =>
      reject(new Error(`${target.key} exited before READY (code ${code})\n${stderr}`)));
    setTimeout(() => reject(new Error(`${target.key} READY timeout\n${stderr}${out}`)), 15000);
  });
  return { child, ready, getStderr: () => stderr };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((r) => child.once("exit", r)),
    sleep(2000),
  ]);
  if (child.exitCode === null) {
    try {
      if (process.platform === "win32") execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" });
      else child.kill("SIGKILL");
    } catch { /* already gone */ }
  }
  await waitPortFree(PORT);
}

function runLoad({ scenario, connections, duration }) {
  return new Promise((resolve, reject) => {
    autocannon(
      {
        url: `http://${HOST}:${PORT}${scenario.path}`,
        method: scenario.method,
        headers: scenario.headers,
        body: scenario.body,
        connections,
        pipelining: 1,
        duration,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
  });
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

async function measure(scenario, connections) {
  // One discarded warmup, then TRIALS measured runs — report the median trial
  // (by rps) so a single noisy run can't skew the result.
  await runLoad({ scenario, connections, duration: WARMUP_S });
  const runs = [];
  for (let t = 0; t < TRIALS; t++) {
    runs.push(await runLoad({ scenario, connections, duration: DURATION_S }));
  }
  const rpsList = runs.map((r) => r.requests.average);
  const medRps = median(rpsList);
  // Pick the run whose rps is closest to the median to source its latency/etc.
  const rep = runs.reduce((best, r) =>
    Math.abs(r.requests.average - medRps) < Math.abs(best.requests.average - medRps) ? r : best);
  return {
    rps: medRps,
    rpsTrials: rpsList.map((v) => Math.round(v)),
    rpsSpread: (Math.max(...rpsList) - Math.min(...rpsList)) / medRps,
    latency: {
      mean: rep.latency.average,
      p50: rep.latency.p50,
      p90: rep.latency.p90,
      p99: rep.latency.p99,
      max: rep.latency.max,
    },
    throughputBytes: rep.throughput.average,
    non2xx: rep.non2xx,
    errors: rep.errors,
    timeouts: rep.timeouts,
    totalRequests: rep.requests.total,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
function bunVersion() {
  try { return execSync(`"${BUN}" --version`, { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}
function expressVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "node_modules/express/package.json"), "utf8"));
    return pkg.version;
  } catch { return "unknown"; }
}

async function main() {
  const os = await import("node:os");
  const meta = {
    date: new Date().toISOString(),
    quick: QUICK,
    config: { baseConnections: BASE_CONN, sweepConnections: SWEEP_CONN, warmupS: WARMUP_S, durationS: DURATION_S, trials: TRIALS, pipelining: 1 },
    versions: { bun: bunVersion(), node: process.version, express: expressVersion() },
    machine: {
      cpu: os.cpus()[0].model,
      cores: os.cpus().length,
      memGB: Number((os.totalmem() / 1e9).toFixed(1)),
      platform: `${os.platform()} ${os.release()}`,
    },
  };
  console.log(`\nExpressy benchmark  ·  ${meta.machine.cpu} (${meta.machine.cores} cores)`);
  console.log(`bun ${meta.versions.bun}  ·  node ${meta.versions.node}  ·  express ${meta.versions.express}`);
  console.log(`warmup ${WARMUP_S}s · ${TRIALS}×${DURATION_S}s measured (median) · ${BASE_CONN} connections · pipelining 1${QUICK ? "  [QUICK]" : ""}\n`);

  const results = [];

  for (const target of TARGETS) {
    process.stdout.write(`▶ ${target.label.padEnd(18)} `);
    await waitPortFree(PORT);
    const srv = startServer(target);
    try {
      await srv.ready;
    } catch (e) {
      console.log(`\n  ✗ failed to start: ${e.message}`);
      continue;
    }
    await sleep(300); // settle

    // Build this target's run list: every scenario at base concurrency, plus a
    // connection sweep on the JSON scenario (framework targets only).
    const runList = SCENARIOS.map((s) => ({ scenario: s, connections: BASE_CONN, sweep: false }));
    if (target.group === "framework") {
      for (const c of SWEEP_CONN) {
        if (c === BASE_CONN) continue;
        runList.push({ scenario: SCENARIOS.find((s) => s.key === "json"), connections: c, sweep: true });
      }
    }

    for (const run of runList) {
      try {
        const m = await measure(run.scenario, run.connections);
        results.push({
          target: target.key, label: target.label, group: target.group, runtime: target.runtime,
          scenario: run.scenario.key, scenarioTitle: run.scenario.title,
          connections: run.connections, sweep: run.sweep, ...m,
        });
        process.stdout.write(run.sweep ? "~" : "·");
      } catch (e) {
        process.stdout.write("x");
        results.push({ target: target.key, scenario: run.scenario.key, connections: run.connections, error: String(e) });
      }
    }
    await stopServer(srv.child);
    console.log("  done");
  }

  const out = { meta, results };
  const outPath = join(__dirname, "results.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n✓ Wrote ${outPath}  (${results.length} data points)\n`);

  // Quick console summary: base-connection rps per scenario.
  printSummary(results);
}

function printSummary(results) {
  const scen = SCENARIOS.map((s) => s.key);
  const targets = TARGETS.map((t) => t.key);
  const rps = (t, s) =>
    results.find((r) => r.target === t && r.scenario === s && r.connections === BASE_CONN && !r.sweep)?.rps;

  const header = ["scenario".padEnd(16), ...TARGETS.map((t) => t.label.split(" · ")[0].slice(0, 9).padStart(10))].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const s of scen) {
    const row = [s.padEnd(16)];
    for (const t of targets) {
      const v = rps(t, s);
      row.push((v ? Math.round(v).toLocaleString() : "—").padStart(10));
    }
    console.log(row.join(" "));
  }
  console.log("\n(rps at 64 connections; full percentiles in results.json — run `node report.mjs` for the report)\n");
}

main().catch((e) => { console.error(e); process.exit(1); });

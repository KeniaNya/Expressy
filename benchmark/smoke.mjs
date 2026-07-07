// Correctness gate: starts each server and checks every route returns the
// expected status/body. If bodies differ across frameworks the benchmark would
// be comparing different work, so this must pass before running run.mjs.
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3199;
const HOST = "127.0.0.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBun() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    for (const p of [join(home, ".bun", "bin", "bun.exe"), join(home, ".bun", "bin", "bun")]) {
      if (existsSync(p)) return p;
    }
  }
  try {
    const out = execSync(process.platform === "win32" ? "where bun" : "which bun", { encoding: "utf8" })
      .trim().split(/\r?\n/);
    return out.find((l) => /bun(\.exe)?$/i.test(l.trim())) ?? out[0];
  } catch { return "bun"; }
}
const BUN = findBun();

const TARGETS = [
  { key: "expressy-bun", runtime: "bun", file: "servers/expressy.ts" },
  { key: "express-node", runtime: "node", file: "servers/express-app.mjs" },
  { key: "express-bun", runtime: "bun", file: "servers/express-app.mjs" },
  { key: "raw-bun", runtime: "bun", file: "servers/raw-bun.ts" },
  { key: "raw-node", runtime: "node", file: "servers/raw-node.mjs" },
];

const CHECKS = [
  { m: "GET", path: "/plaintext", expect: "Hello, World!", ct: /text\/plain/ },
  { m: "GET", path: "/json", expect: '{"message":"Hello, World!"}', ct: /application\/json/ },
  { m: "GET", path: "/user/42", expect: '{"id":"42"}', ct: /application\/json/ },
  { m: "GET", path: "/search?q=hello&limit=10", expect: '{"q":"hello","limit":"10"}', ct: /application\/json/ },
  { m: "GET", path: "/middleware", expect: '{"steps":5}', ct: /application\/json/ },
  { m: "POST", path: "/echo", body: '{"a":1,"b":[2,3]}', ct: /application\/json/,
    expect: '{"received":{"a":1,"b":[2,3]}}' },
];

async function start(target) {
  const exe = target.runtime === "bun" ? BUN : process.execPath;
  const args = target.runtime === "bun" ? ["run", join(__dirname, target.file)] : [join(__dirname, target.file)];
  const child = spawn(exe, args, {
    cwd: __dirname, env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; if (out.includes("READY")) resolve(); });
    child.once("exit", (c) => reject(new Error(`exited ${c}: ${err}`)));
    setTimeout(() => reject(new Error(`timeout: ${err}${out}`)), 15000);
  });
  return child;
}

async function stop(child) {
  child.kill("SIGTERM");
  await Promise.race([new Promise((r) => child.once("exit", r)), sleep(1500)]);
  if (child.exitCode === null && process.platform === "win32") {
    try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" }); } catch {}
  }
  await sleep(400);
}

let failures = 0;
for (const target of TARGETS) {
  let child;
  try {
    child = await start(target);
    await sleep(300);
  } catch (e) {
    console.log(`✗ ${target.key}: failed to start — ${e.message}`);
    failures++;
    continue;
  }
  const problems = [];
  for (const c of CHECKS) {
    try {
      const res = await fetch(`http://${HOST}:${PORT}${c.path}`, {
        method: c.m, body: c.body,
        headers: c.body ? { "content-type": "application/json" } : undefined,
      });
      const text = await res.text();
      const ct = res.headers.get("content-type") ?? "";
      if (res.status !== 200) problems.push(`${c.m} ${c.path} → status ${res.status}`);
      else if (text !== c.expect) problems.push(`${c.m} ${c.path} → body ${JSON.stringify(text)} ≠ ${JSON.stringify(c.expect)}`);
      else if (c.ct && !c.ct.test(ct)) problems.push(`${c.m} ${c.path} → content-type ${JSON.stringify(ct)}`);
    } catch (e) {
      problems.push(`${c.m} ${c.path} → ${e.message}`);
    }
  }
  await stop(child);
  if (problems.length === 0) console.log(`✓ ${target.key.padEnd(14)} all ${CHECKS.length} routes OK`);
  else { failures++; console.log(`✗ ${target.key.padEnd(14)}\n   - ${problems.join("\n   - ")}`); }
}

console.log(failures === 0 ? "\nAll servers agree ✓  ready to benchmark" : `\n${failures} target(s) with problems ✗`);
process.exit(failures === 0 ? 0 : 1);

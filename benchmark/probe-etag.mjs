// Focused probe: how much of Express·Node's cost is its default ETag hashing +
// X-Powered-By? Measures the same server with EXPRESS_TUNED off vs on.
import autocannon from "autocannon";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3177, HOST = "127.0.0.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(tuned) {
  const child = spawn(process.execPath, [join(__dirname, "servers/express-app.mjs")], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production", EXPRESS_TUNED: tuned ? "1" : "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; if (out.includes("READY")) resolve(child); });
    child.once("exit", (c) => reject(new Error("exit " + c)));
    setTimeout(() => reject(new Error("timeout")), 15000);
  });
}
const load = (path) => new Promise((res, rej) =>
  autocannon({ url: `http://${HOST}:${PORT}${path}`, connections: 64, duration: 8 },
    (e, r) => (e ? rej(e) : res(r.requests.average))));

async function measure(tuned) {
  const child = await start(tuned);
  await sleep(300);
  await load("/plaintext"); // warmup
  const plaintext = await load("/plaintext");
  const json = await load("/json");
  child.kill("SIGTERM");
  await Promise.race([new Promise((r) => child.once("exit", r)), sleep(1500)]);
  await sleep(500);
  return { plaintext, json };
}

const off = await measure(false);
const on = await measure(true);
console.log("Express·Node default (etag+x-powered-by):", { plaintext: Math.round(off.plaintext), json: Math.round(off.json) });
console.log("Express·Node tuned   (no etag, no xpb)  :", { plaintext: Math.round(on.plaintext), json: Math.round(on.json) });
console.log("ETag/xpb cost: plaintext", ((on.plaintext / off.plaintext - 1) * 100).toFixed(0) + "%", "json", ((on.json / off.json - 1) * 100).toFixed(0) + "%");

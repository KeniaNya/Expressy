// Raw Node http server — no framework. The *ceiling* for anything on Node:
// it shows how much of the Express cost is the framework vs. the runtime.
import http from "node:http";
import { LARGE_PAYLOAD, PORT } from "./contract.mjs";

const LARGE_JSON = JSON.stringify(LARGE_PAYLOAD);

const server = http.createServer((req, res) => {
  const qIndex = req.url.indexOf("?");
  const path = qIndex === -1 ? req.url : req.url.slice(0, qIndex);
  const query = qIndex === -1 ? "" : req.url.slice(qIndex + 1);

  if (path === "/plaintext") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Hello, World!");
  }
  if (path === "/json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ message: "Hello, World!" }));
  }
  if (path === "/search") {
    const params = new URLSearchParams(query);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ q: params.get("q"), limit: params.get("limit") }));
  }
  if (path === "/middleware") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ steps: 5 }));
  }
  if (path === "/json/large") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(LARGE_JSON);
  }
  if (path.startsWith("/user/")) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ id: path.slice("/user/".length) }));
  }
  if (path === "/echo" && req.method === "POST") {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ received: data ? JSON.parse(data) : undefined }));
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`READY ${PORT}`);
});

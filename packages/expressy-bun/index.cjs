// CommonJS entry: makes `require("expressy-bun")` return the callable app
// factory directly — matching `const express = require("express")` ergonomics —
// with every named export (Router, session, HttpError, ...) attached to it.
const mod = require("./src/index.ts");
const expressy = mod.default;
for (const [key, value] of Object.entries(mod)) {
  if (key !== "default" && expressy[key] === undefined) expressy[key] = value;
}
module.exports = expressy;

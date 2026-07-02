import { App } from "./application";
import { Router } from "./router";
import { json, urlencoded, serveStatic } from "./middleware";
import { session } from "./session";

/**
 * Create an application — the Express way:
 *
 *     import expressy from "expressy";
 *     const app = expressy();
 *     app.get("/", (req, res) => res.send("hello"));
 *     app.listen(3000);
 */
function expressy(): App {
  return new App();
}

// Express-compat statics: `expressy.Router()`, `expressy.json()`,
// `expressy.static()`, ... so `const express = require("expressy-bun")`
// works as a drop-in for the `express` import style.
function RouterFactory(): Router {
  return new Router();
}
expressy.Router = RouterFactory as { (): Router; new (): Router };
expressy.json = json;
expressy.urlencoded = urlencoded;
expressy.static = serveStatic;
expressy.session = session;

export default expressy;

export { App } from "./application";
export type { ListenOptions } from "./application";
export { Router } from "./router";
export type { Handler, ErrorHandler, NextFunction } from "./router";
export { ExpressyRequest as Request } from "./request";
export { ExpressyResponse as Response } from "./response";
export type { CookieOptions, RenderCallback } from "./response";
export { HttpError } from "./errors";
export { json, urlencoded, serveStatic } from "./middleware";
export type { StaticOptions, BodyParserOptions, UrlencodedOptions } from "./middleware";
export { session, MemoryStore, Session, SessionCookie } from "./session";
export type { SessionOptions, SessionStore, SessionData, SessionCookieOptions } from "./session";
export { View } from "./view";
export type { Engine, ViewOptions } from "./view";
export { parseCookieHeader } from "./cookies";

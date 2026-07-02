import { App } from "./application";

/**
 * Create an application — the Express way:
 *
 *     import expressy from "expressy";
 *     const app = expressy();
 *     app.get("/", (req, res) => res.send("hello"));
 *     app.listen(3000);
 */
export default function expressy(): App {
  return new App();
}

export { App } from "./application";
export type { ListenOptions } from "./application";
export { Router } from "./router";
export type { Handler, ErrorHandler, NextFunction } from "./router";
export { ExpressyRequest as Request } from "./request";
export { ExpressyResponse as Response } from "./response";
export type { CookieOptions } from "./response";
export { HttpError } from "./errors";
export { json, urlencoded, serveStatic } from "./middleware";
export type { StaticOptions } from "./middleware";

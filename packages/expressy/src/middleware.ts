import { join, resolve, sep } from "node:path";
import type { Handler } from "./router";
import { HttpError } from "./errors";

/**
 * Body parser: populates `req.body` for `application/json` requests.
 * Malformed JSON produces a 400 through the error-handling chain.
 */
export function json(): Handler {
  return async (req, _res, next) => {
    if (req.raw.body && req.is("application/json")) {
      try {
        req.body = await req.json();
      } catch {
        return next(new HttpError(400, "Invalid JSON body"));
      }
    }
    next();
  };
}

/**
 * Body parser: populates `req.body` (as a plain object) for
 * `application/x-www-form-urlencoded` requests.
 */
export function urlencoded(): Handler {
  return async (req, _res, next) => {
    if (req.raw.body && req.is("application/x-www-form-urlencoded")) {
      try {
        const params = new URLSearchParams(await req.text());
        const body: Record<string, string | string[]> = {};
        for (const [key, value] of params) {
          const existing = body[key];
          if (existing === undefined) body[key] = value;
          else if (Array.isArray(existing)) existing.push(value);
          else body[key] = [existing, value];
        }
        req.body = body;
      } catch {
        return next(new HttpError(400, "Invalid form body"));
      }
    }
    next();
  };
}

export interface StaticOptions {
  /** File served when the path resolves to a directory. Default: "index.html". */
  index?: string;
}

/**
 * Serves static files from a directory using Bun.file (zero-copy sendfile
 * under the hood). Falls through to the next handler when no file matches.
 */
export function serveStatic(root: string, options: StaticOptions = {}): Handler {
  const rootDir = resolve(root);
  const index = options.index ?? "index.html";

  return async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    let pathname: string;
    try {
      pathname = decodeURIComponent(req.path);
    } catch {
      return next();
    }

    const filePath = resolve(join(rootDir, pathname));
    // Never escape the root directory.
    if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) return next();

    let file = Bun.file(filePath);
    if (!(await file.exists())) {
      file = Bun.file(join(filePath, index));
      if (!(await file.exists())) return next();
    }
    res.send(file);
  };
}

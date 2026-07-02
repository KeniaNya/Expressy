import type { ExpressyRequest } from "./request";
import type { ExpressyResponse } from "./response";

export type NextFunction = (err?: unknown) => void;

export type Handler = (
  req: ExpressyRequest,
  res: ExpressyResponse,
  next: NextFunction,
) => unknown;

export type ErrorHandler = (
  err: unknown,
  req: ExpressyRequest,
  res: ExpressyResponse,
  next: NextFunction,
) => unknown;

type AnyHandler = Handler | ErrorHandler;
type Mountable = AnyHandler | Router;

interface MatchResult {
  params: Record<string, string>;
  matchedLength: number;
}

/**
 * Compiles an Express-style path into a regex.
 * Supports `:param` segments and `*` wildcards.
 * `exact` matches the whole path (routes); otherwise it matches
 * a prefix ending at a segment boundary (middleware mounts).
 */
function compilePath(path: string, exact: boolean) {
  const keys: string[] = [];

  if (!exact && (path === "/" || path === "")) {
    // Mounted at root: matches everything, strips nothing.
    return { regex: /^/, keys };
  }

  const escaped = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/:(\w+)|\*/g, (_match, key: string) => {
    if (key) {
      keys.push(key);
      return "([^/]+)";
    }
    keys.push("*");
    return "(.*)";
  });

  const regex = exact
    ? new RegExp(`^${pattern}/?$`)
    : new RegExp(`^${pattern}(?=/|$)`);
  return { regex, keys };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

class Layer {
  private regex: RegExp;
  private keys: string[];
  readonly method: string | null;
  readonly handler: AnyHandler;
  readonly isMount: boolean;
  readonly isErrorHandler: boolean;

  constructor(path: string, method: string | null, handler: AnyHandler, isMount: boolean) {
    const { regex, keys } = compilePath(path, !isMount);
    this.regex = regex;
    this.keys = keys;
    this.method = method;
    this.handler = handler;
    this.isMount = isMount;
    this.isErrorHandler = handler.length === 4;
  }

  matchesMethod(method: string): boolean {
    if (!this.method || this.method === "ALL") return true;
    if (this.method === method) return true;
    // HEAD falls back to GET handlers, like Express.
    return this.method === "GET" && method === "HEAD";
  }

  match(path: string): MatchResult | null {
    const m = this.regex.exec(path);
    if (!m) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < this.keys.length; i++) {
      const value = m[i + 1];
      if (value !== undefined) params[this.keys[i]] = decode(value);
    }
    return { params, matchedLength: m[0].length };
  }
}

export class Router {
  private stack: Layer[] = [];

  /** Mount middleware, an error handler, or another Router (optionally under a path prefix). */
  use(path: string, ...handlers: Array<Handler | Router>): this;
  use(path: string, ...handlers: ErrorHandler[]): this;
  use(...handlers: Array<Handler | Router>): this;
  use(...handlers: ErrorHandler[]): this;
  use(first: string | Mountable, ...rest: Mountable[]): this {
    const path = typeof first === "string" ? first : "/";
    const handlers = typeof first === "string" ? rest : [first, ...rest];
    for (const h of handlers) {
      const fn = h instanceof Router ? h.handle : h;
      this.stack.push(new Layer(path, null, fn, true));
    }
    return this;
  }

  private route(method: string, path: string, handlers: Handler[]): this {
    for (const h of handlers) {
      this.stack.push(new Layer(path, method, h, false));
    }
    return this;
  }

  get(path: string, ...handlers: Handler[]) { return this.route("GET", path, handlers); }
  post(path: string, ...handlers: Handler[]) { return this.route("POST", path, handlers); }
  put(path: string, ...handlers: Handler[]) { return this.route("PUT", path, handlers); }
  patch(path: string, ...handlers: Handler[]) { return this.route("PATCH", path, handlers); }
  delete(path: string, ...handlers: Handler[]) { return this.route("DELETE", path, handlers); }
  head(path: string, ...handlers: Handler[]) { return this.route("HEAD", path, handlers); }
  options(path: string, ...handlers: Handler[]) { return this.route("OPTIONS", path, handlers); }
  all(path: string, ...handlers: Handler[]) { return this.route("ALL", path, handlers); }

  /**
   * Runs the request through this router's stack. Calls `done` when the
   * stack is exhausted (or an unhandled error falls through).
   * Bound arrow so routers can be mounted directly as middleware.
   */
  handle = (req: ExpressyRequest, res: ExpressyResponse, done: NextFunction): void => {
    let idx = 0;

    const next: NextFunction = (err?: unknown) => {
      if (res.finished && err === undefined) return;
      if (idx >= this.stack.length) return done(err);

      const layer = this.stack[idx++];

      if (layer.method && !layer.matchesMethod(req.method)) return next(err);
      // Error handlers only run when there is an error, and vice versa.
      if (err !== undefined ? !layer.isErrorHandler : layer.isErrorHandler) return next(err);

      const match = layer.match(req.path);
      if (!match) return next(err);

      const prevPath = req.path;
      const prevParams = req.params;
      const prevBaseUrl = req.baseUrl;
      req.params = { ...prevParams, ...match.params };
      if (layer.isMount && match.matchedLength > 0) {
        req.baseUrl = prevBaseUrl + req.path.slice(0, match.matchedLength);
        const stripped = req.path.slice(match.matchedLength);
        req.path = stripped.startsWith("/") ? stripped : `/${stripped}`;
      }

      let called = false;
      const restoreAndNext: NextFunction = (e?: unknown) => {
        if (called) return;
        called = true;
        req.path = prevPath;
        req.params = prevParams;
        req.baseUrl = prevBaseUrl;
        next(e);
      };

      // Kept on the request so late errors (e.g. res.render) can still
      // reach the error-handling middleware after the handler returned.
      req._next = restoreAndNext;

      try {
        const out = err !== undefined && layer.isErrorHandler
          ? (layer.handler as ErrorHandler)(err, req, res, restoreAndNext)
          : (layer.handler as Handler)(req, res, restoreAndNext);
        Promise.resolve(out).then(
          (value) => {
            // Convenience: returning a fetch Response sends it.
            if (value instanceof Response && !res.finished) res.send(value);
          },
          (e) => restoreAndNext(e ?? new Error("Handler rejected")),
        );
      } catch (e) {
        restoreAndNext(e ?? new Error("Handler threw"));
      }
    };

    next();
  };
}

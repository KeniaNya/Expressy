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

/** A route path: a string pattern, a RegExp, or an array of either. */
export type PathPattern = string | RegExp | Array<string | RegExp>;

export interface RouterOptions {
  /** Treat `/Foo` and `/foo` as different paths. Default: false, like Express. */
  caseSensitive?: boolean;
  /** Distinguish `/foo` from `/foo/`. Default: false, like Express. */
  strict?: boolean;
}

type AnyHandler = Handler | ErrorHandler;
type Mountable = AnyHandler | Router;

interface MatchResult {
  /** `null` when the pattern captures nothing, so the caller can skip an object spread. */
  params: Record<string, string> | null;
  matchedLength: number;
}

interface Compiled {
  regex: RegExp;
  keys: string[];
  /** RegExp routes expose their capture groups as `req.params[0]`, `[1]`, ... */
  numeric: boolean;
}

/**
 * Compiles an Express-style path into a regex.
 * Supports `:param` segments, optional `:param?` segments and `*` wildcards;
 * RegExp paths are used as-is. `exact` matches the whole path (routes);
 * otherwise it matches a prefix ending at a segment boundary (mounts).
 */
function compilePath(path: string | RegExp, exact: boolean, options: RouterOptions): Compiled {
  const keys: string[] = [];

  if (path instanceof RegExp) return { regex: path, keys, numeric: true };

  if (!exact && (path === "/" || path === "")) {
    // Mounted at root: matches everything, strips nothing.
    return { regex: /^/, keys, numeric: false };
  }

  const escaped = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  // After escaping, an optional marker reads `:name\?`.
  const pattern = escaped.replace(
    /(\/)?:(\w+)(\\\?)?|\*/g,
    (_match, slash: string | undefined, key: string | undefined, optional: string | undefined) => {
      if (key) {
        keys.push(key);
        const segment = `${slash ?? ""}([^/]+)`;
        return optional ? `(?:${segment})?` : segment;
      }
      keys.push("*");
      return "(.*)";
    },
  );

  const flags = options.caseSensitive ? "" : "i";
  const regex = exact
    ? new RegExp(`^${pattern}${options.strict ? "" : "/?"}$`, flags)
    : new RegExp(`^${pattern}(?=/|$)`, flags);
  return { regex, keys, numeric: false };
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
  private numeric: boolean;
  readonly method: string | null;
  readonly handler: AnyHandler;
  readonly isMount: boolean;
  readonly isErrorHandler: boolean;
  /** Layers registered by one route call share a group, which is what `next("route")` skips. */
  readonly group: number;

  constructor(
    path: string | RegExp,
    method: string | null,
    handler: AnyHandler,
    isMount: boolean,
    group: number,
    options: RouterOptions,
  ) {
    const { regex, keys, numeric } = compilePath(path, !isMount, options);
    this.regex = regex;
    this.keys = keys;
    this.numeric = numeric;
    this.method = method;
    this.handler = handler;
    this.isMount = isMount;
    this.isErrorHandler = handler.length === 4;
    this.group = group;
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
    if (this.numeric) {
      const params: Record<string, string> = {};
      for (let i = 1; i < m.length; i++) {
        if (m[i] !== undefined) params[i - 1] = decode(m[i]);
      }
      return { params, matchedLength: m[0].length };
    }
    if (this.keys.length === 0) return { params: null, matchedLength: m[0].length };
    const params: Record<string, string> = {};
    for (let i = 0; i < this.keys.length; i++) {
      const value = m[i + 1];
      if (value !== undefined) params[this.keys[i]] = decode(value);
    }
    return { params, matchedLength: m[0].length };
  }
}

/** Chainable per-path registration returned by `router.route(path)`. */
export class Route {
  constructor(
    private readonly router: Router,
    private readonly path: PathPattern,
    private readonly group: number,
  ) {}

  private add(method: string, handlers: Handler[]): this {
    this.router._addRoute(method, this.path, handlers, this.group);
    return this;
  }

  all(...handlers: Handler[]) { return this.add("ALL", handlers); }
  get(...handlers: Handler[]) { return this.add("GET", handlers); }
  post(...handlers: Handler[]) { return this.add("POST", handlers); }
  put(...handlers: Handler[]) { return this.add("PUT", handlers); }
  patch(...handlers: Handler[]) { return this.add("PATCH", handlers); }
  delete(...handlers: Handler[]) { return this.add("DELETE", handlers); }
  head(...handlers: Handler[]) { return this.add("HEAD", handlers); }
  options(...handlers: Handler[]) { return this.add("OPTIONS", handlers); }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

export class Router {
  private stack: Layer[] = [];
  private routerOptions: RouterOptions;
  private groupSeq = 0;

  constructor(options: RouterOptions = {}) {
    this.routerOptions = { caseSensitive: false, strict: false, ...options };
  }

  /** @internal Lets the App apply `case sensitive routing` / `strict routing` settings. */
  _configure(options: RouterOptions): void {
    Object.assign(this.routerOptions, options);
  }

  /** Mount middleware, an error handler, or another Router (optionally under a path prefix). */
  use(path: PathPattern, ...handlers: Array<Handler | Router>): this;
  use(path: PathPattern, ...handlers: ErrorHandler[]): this;
  use(...handlers: Array<Handler | Router>): this;
  use(...handlers: ErrorHandler[]): this;
  use(first: PathPattern | Mountable, ...rest: Mountable[]): this {
    const isPath = typeof first === "string" || first instanceof RegExp || Array.isArray(first);
    const paths = isPath ? first : "/";
    const handlers = isPath ? rest : [first as Mountable, ...rest];
    for (const h of handlers) {
      const fn = h instanceof Router ? h.handle : h;
      // Each `use` handler is its own group: `next("route")` from middleware just continues.
      const group = ++this.groupSeq;
      for (const path of Array.isArray(paths) ? paths : [paths]) {
        this.stack.push(new Layer(path, null, fn, true, group, this.routerOptions));
      }
    }
    return this;
  }

  /** @internal */
  _addRoute(method: string, path: PathPattern, handlers: Handler[], group: number): void {
    for (const p of Array.isArray(path) ? path : [path]) {
      for (const h of handlers) {
        this.stack.push(new Layer(p, method, h, false, group, this.routerOptions));
      }
    }
  }

  private route_(method: string, path: PathPattern, handlers: Handler[]): this {
    this._addRoute(method, path, handlers, ++this.groupSeq);
    return this;
  }

  /** Chainable registration for one path: `app.route("/x").get(a).post(b)`. */
  route(path: PathPattern): Route {
    return new Route(this, path, ++this.groupSeq);
  }

  get(path: PathPattern, ...handlers: Handler[]) { return this.route_("GET", path, handlers); }
  post(path: PathPattern, ...handlers: Handler[]) { return this.route_("POST", path, handlers); }
  put(path: PathPattern, ...handlers: Handler[]) { return this.route_("PUT", path, handlers); }
  patch(path: PathPattern, ...handlers: Handler[]) { return this.route_("PATCH", path, handlers); }
  delete(path: PathPattern, ...handlers: Handler[]) { return this.route_("DELETE", path, handlers); }
  head(path: PathPattern, ...handlers: Handler[]) { return this.route_("HEAD", path, handlers); }
  options(path: PathPattern, ...handlers: Handler[]) { return this.route_("OPTIONS", path, handlers); }
  all(path: PathPattern, ...handlers: Handler[]) { return this.route_("ALL", path, handlers); }

  /**
   * Runs the request through this router's stack. Calls `done` when the
   * stack is exhausted (or an unhandled error falls through).
   * Bound arrow so routers can be mounted directly as middleware.
   */
  handle = (req: ExpressyRequest, res: ExpressyResponse, done: NextFunction): void => {
    let idx = 0;
    // Group whose remaining layers `next("route")` asked us to skip.
    let skipGroup = -1;

    const next: NextFunction = (err?: unknown) => {
      // Express control-flow signals: leave this router / skip the rest of this route.
      if (err === "router") return done();
      if (res.finished && err === undefined) return;
      if (idx >= this.stack.length) return done(err);

      const layer = this.stack[idx++];

      if (skipGroup !== -1) {
        if (layer.group === skipGroup) return next(err);
        skipGroup = -1;
      }

      if (layer.method && !layer.matchesMethod(req.method)) return next(err);
      // Error handlers only run when there is an error, and vice versa.
      if (err !== undefined ? !layer.isErrorHandler : layer.isErrorHandler) return next(err);

      const match = layer.match(req.path);
      if (!match) return next(err);

      const prevPath = req.path;
      const prevParams = req.params;
      const prevBaseUrl = req.baseUrl;
      if (match.params) req.params = { ...prevParams, ...match.params };
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
        if (e === "route") {
          skipGroup = layer.group;
          e = undefined;
        }
        next(e);
      };

      // Kept on the request so late errors (e.g. res.render) can still
      // reach the error-handling middleware after the handler returned.
      req._next = restoreAndNext;

      // Convenience: returning a fetch Response sends it.
      const onValue = (value: unknown) => {
        if (value instanceof Response && !res.finished) res.send(value);
      };
      const onError = (e: unknown) => restoreAndNext(e ?? new Error("Handler rejected"));

      try {
        const out = err !== undefined && layer.isErrorHandler
          ? (layer.handler as ErrorHandler)(err, req, res, restoreAndNext)
          : (layer.handler as Handler)(req, res, restoreAndNext);
        // Sync handlers skip the microtask; async ones are awaited.
        if (isThenable(out)) out.then(onValue, onError);
        else onValue(out);
      } catch (e) {
        restoreAndNext(e ?? new Error("Handler threw"));
      }
    };

    next();
  };
}

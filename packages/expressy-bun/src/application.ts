import type { Server } from "bun";
import { resolve } from "node:path";
import { Router, type Handler } from "./router";
import { ExpressyRequest } from "./request";
import { ExpressyResponse, type RenderCallback } from "./response";
import { HttpError } from "./errors";
import { View, type Engine, type ViewOptions } from "./view";

export interface ListenOptions {
  port?: number;
  hostname?: string;
  /** Enables Bun's development mode (detailed error pages). */
  development?: boolean;
}

/** Anything with the View contract works — nunjucks installs its own class via `app.set("view", ...)`. */
type ViewConstructor = new (
  name: string,
  opts: ViewOptions,
) => { render(options: Record<string, unknown>, callback: RenderCallback): void };

function statusOf(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  const anyErr = err as { status?: unknown; statusCode?: unknown };
  const status = anyErr?.status ?? anyErr?.statusCode;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 500;
}

export class App extends Router {
  /** App-wide template locals, merged into every `res.render`. */
  readonly locals: Record<string, any> = {};
  /** Registered template engines, keyed by extension (".html"). */
  readonly engines: Record<string, Engine> = {};
  private settings = new Map<string, unknown>();

  constructor() {
    super();
    this.settings.set("views", resolve("views"));
  }

  /** Assign a setting: `app.set("view engine", "html")`, `app.set("trust proxy", 1)`. */
  set(name: string, value: unknown): this {
    this.settings.set(name, value);
    return this;
  }

  /** Read an app setting (single argument) or register a GET route, like Express. */
  get(setting: string): any;
  get(path: string, ...handlers: Handler[]): this;
  get(pathOrSetting: string, ...handlers: Handler[]): any {
    if (handlers.length === 0) return this.settings.get(pathOrSetting);
    return super.get(pathOrSetting, ...handlers);
  }

  enable(name: string): this {
    return this.set(name, true);
  }

  disable(name: string): this {
    return this.set(name, false);
  }

  enabled(name: string): boolean {
    return Boolean(this.settings.get(name));
  }

  disabled(name: string): boolean {
    return !this.settings.get(name);
  }

  /** Register a template engine for an extension: `app.engine("html", fn)`. */
  engine(ext: string, fn: Engine): this {
    this.engines[ext.startsWith(".") ? ext : `.${ext}`] = fn;
    return this;
  }

  /** Render a view by name. Prefer `res.render`, which merges locals for you. */
  render(name: string, locals: Record<string, unknown>, callback: RenderCallback): void {
    const ViewClass = (this.settings.get("view") as ViewConstructor | undefined) ?? View;
    let view: InstanceType<ViewConstructor>;
    try {
      view = new ViewClass(name, {
        defaultEngine: this.settings.get("view engine") as string | undefined,
        root: this.settings.get("views") as string | undefined,
        engines: this.engines,
      });
    } catch (err) {
      return callback(err);
    }
    try {
      view.render(locals, callback);
    } catch (err) {
      callback(err);
    }
  }

  /**
   * fetch-compatible handler. This means the whole app is directly usable
   * anywhere a fetch handler fits: `Bun.serve({ fetch: app.fetch })`,
   * `export default app`, or tests (`await app.fetch(new Request(...))`).
   */
  fetch = (request: Request, server?: Server<unknown>): Promise<Response> => {
    const req = new ExpressyRequest(request, server);
    const res = new ExpressyResponse();
    req.app = this;
    req.res = res;
    res.app = this;
    res.req = req;

    return new Promise<Response>((resolve) => {
      res._onFinish = (response) => {
        if (req.method === "HEAD" && response.body) {
          resolve(new Response(null, response));
        } else {
          resolve(response);
        }
      };

      // Reached when the whole stack ran without anyone responding.
      const done = (err?: unknown) => {
        if (res.finished) return;
        if (err !== undefined) {
          const status = statusOf(err);
          if (status >= 500) console.error("[expressy] Unhandled error:", err);
          const message = err instanceof Error ? err.message : String(err);
          const showDetail = process.env.NODE_ENV !== "production";
          res.status(status).type("text").end(showDetail ? message : "Internal Server Error");
        } else {
          res.status(404).type("text").end(`Cannot ${req.method} ${req.path}`);
        }
      };

      try {
        this.handle(req, res, done);
      } catch (err) {
        done(err);
      }
    });
  };

  /** Start a Bun server. Returns the `Bun.serve` instance. */
  listen(port?: number | string, callback?: (server: Server<unknown>) => void): Server<unknown>;
  listen(options: ListenOptions, callback?: (server: Server<unknown>) => void): Server<unknown>;
  listen(
    portOrOptions: number | string | ListenOptions = 3000,
    callback?: (server: Server<unknown>) => void,
  ): Server<unknown> {
    // Port may arrive as a string (e.g. process.env.PORT), like Express accepts.
    const options =
      typeof portOrOptions === "object" ? portOrOptions : { port: Number(portOrOptions) };
    const server = Bun.serve({
      port: options.port ?? 3000,
      hostname: options.hostname,
      development: options.development ?? false,
      fetch: this.fetch,
    });
    callback?.(server);
    return server;
  }
}

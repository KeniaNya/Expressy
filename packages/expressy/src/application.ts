import type { Server } from "bun";
import { Router } from "./router";
import { ExpressyRequest } from "./request";
import { ExpressyResponse } from "./response";
import { HttpError } from "./errors";

export interface ListenOptions {
  port?: number;
  hostname?: string;
  /** Enables Bun's development mode (detailed error pages). */
  development?: boolean;
}

function statusOf(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  const anyErr = err as { status?: unknown; statusCode?: unknown };
  const status = anyErr?.status ?? anyErr?.statusCode;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 500;
}

export class App extends Router {
  /**
   * fetch-compatible handler. This means the whole app is directly usable
   * anywhere a fetch handler fits: `Bun.serve({ fetch: app.fetch })`,
   * `export default app`, or tests (`await app.fetch(new Request(...))`).
   */
  fetch = (request: Request, server?: Server<unknown>): Promise<Response> => {
    const req = new ExpressyRequest(request, server);
    const res = new ExpressyResponse();

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
  listen(port?: number, callback?: (server: Server<unknown>) => void): Server<unknown>;
  listen(options: ListenOptions, callback?: (server: Server<unknown>) => void): Server<unknown>;
  listen(
    portOrOptions: number | ListenOptions = 3000,
    callback?: (server: Server<unknown>) => void,
  ): Server<unknown> {
    const options = typeof portOrOptions === "number" ? { port: portOrOptions } : portOrOptions;
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

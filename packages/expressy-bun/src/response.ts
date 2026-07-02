import type { BunFile } from "bun";
import { STATUS_CODES } from "node:http";
import type { App } from "./application";
import type { ExpressyRequest } from "./request";

const TYPE_SHORTHANDS: Record<string, string> = {
  json: "application/json; charset=utf-8",
  html: "text/html; charset=utf-8",
  text: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  bin: "application/octet-stream",
};

// These status codes must not carry a body.
const EMPTY_STATUS = new Set([101, 204, 205, 304]);

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None" | "strict" | "lax" | "none";
}

export type RenderCallback = (err: unknown, html?: string) => void;

type SendableBody =
  | string
  | object
  | number
  | boolean
  | null
  | undefined
  | Uint8Array
  | ArrayBuffer
  | Blob
  | BunFile
  | ReadableStream
  | Response;

/**
 * Express-flavored response builder. Nothing is written until a terminal
 * method (`send`, `json`, `end`, `redirect`, `sendFile`) is called; the
 * accumulated status/headers/body then become a fetch Response.
 */
export class ExpressyResponse {
  statusCode = 200;
  readonly headers = new Headers();
  finished = false;
  /** Per-response template variables, merged into every `res.render`. */
  readonly locals: Record<string, any> = {};
  /** The application handling this request. */
  app?: App;
  /** The request paired with this response. */
  req?: ExpressyRequest;

  /** @internal Resolves the pending fetch handler with the final Response. */
  _onFinish?: (response: Response) => void;
  private finishListeners: Array<(res: ExpressyResponse) => void> = [];
  private beforeSendListeners: Array<(res: ExpressyResponse) => void | Promise<void>> = [];

  /** Register a callback fired once the response has been sent. */
  onFinish(listener: (res: ExpressyResponse) => void): this {
    this.finishListeners.push(listener);
    return this;
  }

  /**
   * Register a hook that runs after the handler finishes but before the
   * Response is built — headers (e.g. Set-Cookie) can still be added.
   * Hooks may be async; used by the session middleware for persistence.
   */
  onBeforeSend(listener: (res: ExpressyResponse) => void | Promise<void>): this {
    this.beforeSendListeners.push(listener);
    return this;
  }

  /** Express alias for `finished`. */
  get headersSent(): boolean {
    return this.finished;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  /** Set one header or several at once: `res.set("X-A", "1")` / `res.set({ "X-A": "1" })`. */
  set(field: string | Record<string, string>, value?: string): this {
    if (typeof field === "string") {
      this.headers.set(field, value ?? "");
    } else {
      for (const [k, v] of Object.entries(field)) this.headers.set(k, v);
    }
    return this;
  }

  get(field: string): string | undefined {
    return this.headers.get(field) ?? undefined;
  }

  append(field: string, value: string): this {
    this.headers.append(field, value);
    return this;
  }

  /** Node-style alias for `res.set` (accepts arrays like `setHeader` does). */
  setHeader(field: string, value: string | number | readonly string[]): this {
    if (Array.isArray(value)) {
      this.headers.delete(field);
      for (const v of value) this.headers.append(field, String(v));
    } else {
      this.headers.set(field, String(value));
    }
    return this;
  }

  /** Node-style alias for `res.get`. */
  getHeader(field: string): string | undefined {
    return this.headers.get(field) ?? undefined;
  }

  removeHeader(field: string): this {
    this.headers.delete(field);
    return this;
  }

  hasHeader(field: string): boolean {
    return this.headers.has(field);
  }

  /** Set the Content-Type. Accepts shorthands ("json", "html", ...) or full MIME types. */
  type(type: string): this {
    this.headers.set("Content-Type", TYPE_SHORTHANDS[type] ?? type);
    return this;
  }

  cookie(name: string, value: string, options: CookieOptions = {}): this {
    let cookie = `${name}=${encodeURIComponent(value)}`;
    cookie += `; Path=${options.path ?? "/"}`;
    if (options.maxAge !== undefined) cookie += `; Max-Age=${Math.floor(options.maxAge / 1000)}`;
    if (options.expires) cookie += `; Expires=${options.expires.toUTCString()}`;
    if (options.domain) cookie += `; Domain=${options.domain}`;
    if (options.secure) cookie += "; Secure";
    if (options.httpOnly) cookie += "; HttpOnly";
    if (options.sameSite) cookie += `; SameSite=${options.sameSite}`;
    this.headers.append("Set-Cookie", cookie);
    return this;
  }

  clearCookie(name: string, options: CookieOptions = {}): this {
    return this.cookie(name, "", { ...options, expires: new Date(0) });
  }

  json(data: unknown): void {
    if (!this.headers.has("Content-Type")) this.type("json");
    this.finish(JSON.stringify(data));
  }

  text(body: string): void {
    if (!this.headers.has("Content-Type")) this.type("text");
    this.finish(body);
  }

  html(body: string): void {
    if (!this.headers.has("Content-Type")) this.type("html");
    this.finish(body);
  }

  /** Set the status and send its standard text ("404 Not Found", ...). */
  sendStatus(code: number): void {
    this.statusCode = code;
    if (!this.headers.has("Content-Type")) this.type("text");
    this.finish(STATUS_CODES[code] ?? String(code));
  }

  /** Redirect. Accepts both `res.redirect(url, status?)` and Express's `res.redirect(status, url)`. */
  redirect(url: string, status?: number): void;
  redirect(status: number, url: string): void;
  redirect(first: string | number, second?: string | number): void {
    const status = typeof first === "number" ? first : typeof second === "number" ? second : 302;
    const url = typeof first === "string" ? first : String(second);
    this.statusCode = status;
    this.headers.set("Location", url);
    this.finish(null);
  }

  /**
   * Render a view through the app's template engine (see `app.engine` and
   * the `views` / `view engine` settings). Locals are merged from
   * `app.locals`, `res.locals`, and the argument, like Express. Without a
   * callback, errors flow to the error-handling middleware.
   */
  render(view: string, options?: Record<string, unknown> | RenderCallback, callback?: RenderCallback): void {
    const opts = typeof options === "function" ? undefined : options;
    const cb = typeof options === "function" ? options : callback;
    const done: RenderCallback =
      cb ??
      ((err, html) => {
        if (err) {
          const forward = this.req?._next;
          if (forward) return forward(err);
          if (!this.finished) {
            console.error("[expressy] render failed:", err);
            this.status(500).type("text").end("Internal Server Error");
          }
          return;
        }
        this.html(html ?? "");
      });
    if (!this.app) return done(new Error("res.render() needs an app context"));
    const locals = { ...this.app.locals, ...this.locals, ...opts };
    try {
      this.app.render(view, locals, done);
    } catch (err) {
      done(err);
    }
  }

  /** Send a file from disk. Content-Type is inferred from the extension. */
  async sendFile(path: string): Promise<void> {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      const err = new Error(`File not found: ${path}`) as Error & { status: number };
      err.status = 404;
      throw err;
    }
    this.send(file);
  }

  /**
   * Smart send, like Express: strings go out as HTML (unless a Content-Type
   * is already set), plain objects/arrays as JSON, binary as octet-stream,
   * and Blob/BunFile/Response/ReadableStream pass straight through.
   */
  send(body?: SendableBody): void {
    if (body instanceof Response) {
      if (this.finished) {
        throw new Error("Response already sent — cannot send again");
      }
      this.finished = true;
      this.runBeforeSend(() => {
        const merged = new Response(body.body, body);
        for (const [k, v] of this.headers) {
          if (k === "set-cookie") continue;
          merged.headers.set(k, v);
        }
        for (const c of this.headers.getSetCookie()) merged.headers.append("Set-Cookie", c);
        this.emit(merged);
      });
      return;
    }

    if (body === null || body === undefined) {
      this.finish(null);
    } else if (typeof body === "string") {
      if (!this.headers.has("Content-Type")) this.type("html");
      this.finish(body);
    } else if (body instanceof Blob) {
      // Covers BunFile too — Bun infers Content-Type from the file extension.
      if (!this.headers.has("Content-Type") && body.type) {
        this.headers.set("Content-Type", body.type);
      }
      this.finish(body);
    } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      if (!this.headers.has("Content-Type")) this.type("bin");
      this.finish(body as BodyInit);
    } else if (body instanceof ReadableStream) {
      this.finish(body);
    } else {
      // objects, arrays, numbers, booleans
      this.json(body);
    }
  }

  /** End the response with an optional raw body, no content-type magic. */
  end(body: string | null = null): void {
    this.finish(body);
  }

  private finish(body: BodyInit | null): void {
    if (this.finished) {
      throw new Error("Response already sent — cannot send again");
    }
    this.finished = true;
    this.runBeforeSend(() => {
      const finalBody = EMPTY_STATUS.has(this.statusCode) ? null : body;
      this.emit(new Response(finalBody, { status: this.statusCode, headers: this.headers }));
    });
  }

  private runBeforeSend(complete: () => void): void {
    if (this.beforeSendListeners.length === 0) return complete();
    const hooks = this.beforeSendListeners.splice(0);
    void (async () => {
      for (const hook of hooks) {
        try {
          await hook(this);
        } catch (err) {
          console.error("[expressy] beforeSend hook failed:", err);
        }
      }
      complete();
    })();
  }

  private emit(response: Response): void {
    this.statusCode = response.status;
    for (const listener of this.finishListeners) {
      try {
        listener(this);
      } catch {
        // Listeners must never break the response.
      }
    }
    this._onFinish?.(response);
  }
}

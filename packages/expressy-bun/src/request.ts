import type { Server } from "bun";

/**
 * Thin, Express-flavored wrapper around the native fetch Request.
 * The original Request stays available as `req.raw`.
 */
export class ExpressyRequest {
  readonly raw: Request;
  readonly method: string;
  readonly headers: Headers;
  /** Full URL, parsed. */
  readonly parsedUrl: URL;
  /** Path + query string as received (never mutated by routing). */
  readonly originalUrl: string;
  /** Current path. Routers strip their mount prefix from it while dispatching. */
  path: string;
  /** Route params, e.g. `/users/:id` -> `{ id: "42" }`. */
  params: Record<string, string> = {};
  /** Parsed query string. Repeated keys become arrays. */
  readonly query: Record<string, string | string[]>;
  /** Populated by the `json()` / `urlencoded()` body-parser middleware. */
  body: unknown = undefined;

  private server?: Server<unknown>;
  private cachedText?: Promise<string>;

  constructor(raw: Request, server?: Server<unknown>) {
    this.raw = raw;
    this.server = server;
    this.method = raw.method.toUpperCase();
    this.headers = raw.headers;
    this.parsedUrl = new URL(raw.url);
    this.path = this.parsedUrl.pathname;
    this.originalUrl = this.parsedUrl.pathname + this.parsedUrl.search;

    const query: Record<string, string | string[]> = {};
    for (const [key, value] of this.parsedUrl.searchParams) {
      const existing = query[key];
      if (existing === undefined) query[key] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else query[key] = [existing, value];
    }
    this.query = query;
  }

  get hostname(): string {
    return this.parsedUrl.hostname;
  }

  get protocol(): string {
    return this.parsedUrl.protocol.replace(":", "");
  }

  get secure(): boolean {
    return this.protocol === "https";
  }

  /** Client IP address (available when serving via `app.listen`). */
  get ip(): string | undefined {
    return this.server?.requestIP(this.raw)?.address;
  }

  /** Get a request header (case-insensitive). */
  get(name: string): string | undefined {
    return this.headers.get(name) ?? undefined;
  }

  /** Check the Content-Type, e.g. `req.is("json")`, `req.is("text/html")`. */
  is(type: string): boolean {
    const contentType = this.headers.get("content-type") ?? "";
    return contentType.includes(type);
  }

  /** Read the body as text (cached — safe to call more than once). */
  text(): Promise<string> {
    this.cachedText ??= this.raw.text();
    return this.cachedText;
  }

  /** Read and parse the body as JSON. */
  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  /** Read the body as multipart/urlencoded form data. */
  formData(): Promise<FormData> {
    return this.raw.formData();
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.raw.arrayBuffer();
  }
}

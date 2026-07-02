import type { Server } from "bun";
import type { App } from "./application";
import type { ExpressyResponse } from "./response";
import type { Session } from "./session";
import type { NextFunction } from "./router";
import { parseCookieHeader } from "./cookies";

/**
 * Thin, Express-flavored wrapper around the native fetch Request.
 * The original Request stays available as `req.raw`.
 */
export class ExpressyRequest {
  readonly raw: Request;
  readonly method: string;
  /** Full URL, parsed. */
  readonly parsedUrl: URL;
  /** Path + query string as received (never mutated by routing). */
  readonly originalUrl: string;
  /** Current path. Routers strip their mount prefix from it while dispatching. */
  path: string;
  /** Mount prefix accumulated by routers, like Express. Empty at the app level. */
  baseUrl = "";
  /** Route params, e.g. `/users/:id` -> `{ id: "42" }`. */
  params: Record<string, string> = {};
  /** Parsed query string. Repeated keys become arrays. */
  readonly query: Record<string, string | string[]>;
  /** Populated by the `json()` / `urlencoded()` body-parser middleware. */
  body: unknown = undefined;
  /** The application handling this request. */
  app?: App;
  /** The response paired with this request. */
  res?: ExpressyResponse;
  /** Populated by the `session()` middleware. */
  session?: Session;
  sessionID?: string;
  /** @internal Latest dispatch continuation — lets `res.render` route errors to error middleware. */
  _next?: NextFunction;

  private server?: Server<unknown>;
  private cachedText?: Promise<string>;
  private cachedHeaders?: Record<string, string>;
  private cachedCookies?: Record<string, string>;

  constructor(raw: Request, server?: Server<unknown>) {
    this.raw = raw;
    this.server = server;
    this.method = raw.method.toUpperCase();
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

  /**
   * Request headers as a plain object with lowercase keys, like Node/Express
   * (`req.headers.accept`, `req.headers["x-api-key"]`). The fetch `Headers`
   * object stays available as `req.raw.headers`.
   */
  get headers(): Record<string, string> {
    return (this.cachedHeaders ??= Object.fromEntries(this.raw.headers));
  }

  /** Cookies from the `Cookie` header, e.g. `{ theme: "dark" }`. */
  get cookies(): Record<string, string> {
    return (this.cachedCookies ??= parseCookieHeader(this.raw.headers.get("cookie")));
  }

  /** Mount-relative path + query string, like Express's `req.url`. */
  get url(): string {
    return this.path + this.parsedUrl.search;
  }

  private get trustProxy(): unknown {
    return this.app?.get("trust proxy");
  }

  private forwardedFor(): string[] {
    const value = this.raw.headers.get("x-forwarded-for");
    if (!value) return [];
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }

  get hostname(): string {
    if (this.trustProxy) {
      const forwarded = this.raw.headers.get("x-forwarded-host");
      if (forwarded) return forwarded.split(",")[0].trim().replace(/:\d+$/, "");
    }
    return this.parsedUrl.hostname;
  }

  get protocol(): string {
    if (this.trustProxy) {
      const forwarded = this.raw.headers.get("x-forwarded-proto");
      if (forwarded) return forwarded.split(",")[0].trim();
    }
    return this.parsedUrl.protocol.replace(":", "");
  }

  get secure(): boolean {
    return this.protocol === "https";
  }

  /**
   * Client IP address (available when serving via `app.listen`).
   * With the `trust proxy` setting enabled, honors `X-Forwarded-For`:
   * a numeric setting counts trusted hops (Express-style); any other
   * truthy value trusts the whole chain and returns the leftmost entry.
   */
  get ip(): string | undefined {
    const direct = this.server?.requestIP(this.raw)?.address;
    const trust = this.trustProxy;
    if (!trust) return direct;
    const hops = this.forwardedFor();
    if (hops.length === 0) return direct;
    if (typeof trust === "number") return hops[hops.length - trust] ?? hops[0];
    return hops[0];
  }

  /** Get a request header (case-insensitive). */
  get(name: string): string | undefined {
    return this.raw.headers.get(name) ?? undefined;
  }

  /** Check the Content-Type, e.g. `req.is("json")`, `req.is("text/html")`. */
  is(type: string): boolean {
    const contentType = this.raw.headers.get("content-type") ?? "";
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

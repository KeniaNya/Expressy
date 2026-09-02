import { join, resolve, sep } from "node:path";
import type { Handler } from "./router";
import type { ExpressyRequest } from "./request";
import type { ExpressyResponse } from "./response";
import { HttpError } from "./errors";

export interface BodyParserOptions {
  /** Max body size: bytes or a string like "2mb" / "500kb". Default: "100kb", like Express. */
  limit?: number | string;
}

export interface JsonOptions extends BodyParserOptions {
  /** Only accept objects and arrays at the top level. Default: true, like Express. */
  strict?: boolean;
}

export interface UrlencodedOptions extends BodyParserOptions {
  /** qs-style bracket notation (`a[b]=1`, `tags[]=x`). Default: false. */
  extended?: boolean;
}

export interface TextOptions extends BodyParserOptions {
  /** Content-Type to parse. Default: "text/plain". */
  type?: string;
}

export interface RawOptions extends BodyParserOptions {
  /** Content-Type to parse. Default: "application/octet-stream". */
  type?: string;
}

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

function parseLimit(limit: number | string | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (typeof limit === "number") return limit;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(limit.trim());
  if (!m) throw new Error(`Invalid size limit: "${limit}"`);
  return Math.floor(parseFloat(m[1]) * SIZE_UNITS[(m[2] ?? "b").toLowerCase()]);
}

/** Content-Length as a number, or null when the header is absent/invalid. */
function declaredLength(req: ExpressyRequest): number | null {
  const header = req.raw.headers.get("content-length");
  if (header === null) return null;
  const n = Number(header);
  return Number.isFinite(n) ? n : null;
}

/**
 * Drain the body stream while counting bytes, so an oversized body is
 * rejected as soon as it crosses the limit rather than after it has been
 * buffered whole. Used when Content-Length is missing (chunked uploads).
 */
async function readCounted(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function readBody(req: ExpressyRequest, limit: number): Promise<string> {
  const declared = declaredLength(req);
  if (declared !== null && declared > limit) throw new HttpError(413);
  if (declared !== null || !req.raw.body || req.raw.bodyUsed) {
    // Content-Length is known (or the body was already read): the fast path.
    const text = await req.text();
    if (Buffer.byteLength(text) > limit) throw new HttpError(413);
    return text;
  }
  const bytes = await readCounted(req.raw.body, limit);
  const text = new TextDecoder().decode(bytes);
  req._primeText(text);
  return text;
}

async function readBytes(req: ExpressyRequest, limit: number): Promise<Buffer> {
  const declared = declaredLength(req);
  if (declared !== null && declared > limit) throw new HttpError(413);
  if (declared !== null || !req.raw.body || req.raw.bodyUsed) {
    const bytes = Buffer.from(await req.arrayBuffer());
    if (bytes.byteLength > limit) throw new HttpError(413);
    return bytes;
  }
  return Buffer.from(await readCounted(req.raw.body, limit));
}

/**
 * Body parser: populates `req.body` for `application/json` requests.
 * Malformed JSON produces a 400 through the error-handling chain; an empty
 * body yields `{}`, like Express.
 */
export function json(options: JsonOptions = {}): Handler {
  const limit = parseLimit(options.limit, 100 * 1024);
  const strict = options.strict ?? true;
  return async (req, _res, next) => {
    if (req.raw.body && req.is("application/json")) {
      let text: string;
      try {
        text = await readBody(req, limit);
      } catch (err) {
        return next(err);
      }
      if (text.trim() === "") {
        req.body = {};
        return next();
      }
      if (strict) {
        const first = text.trimStart()[0];
        if (first !== "{" && first !== "[") return next(new HttpError(400, "Invalid JSON body"));
      }
      try {
        req.body = JSON.parse(text);
      } catch {
        return next(new HttpError(400, "Invalid JSON body"));
      }
    }
    next();
  };
}

function assignLeaf(node: Record<string, unknown>, key: string, value: string): void {
  const existing = node[key];
  if (existing === undefined) node[key] = value;
  else if (Array.isArray(existing)) existing.push(value);
  else node[key] = [existing, value];
}

// Never follow segments that would mutate Object.prototype.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function setDeep(root: Record<string, unknown>, segments: string[], value: string): void {
  if (segments.some((s) => FORBIDDEN_KEYS.has(s))) return;
  let node: any = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] === "" ? String(Array.isArray(node) ? node.length : 0) : segments[i];
    if (typeof node[seg] !== "object" || node[seg] === null) {
      const nextSeg = segments[i + 1];
      node[seg] = nextSeg === "" || /^\d+$/.test(nextSeg) ? [] : {};
    }
    node = node[seg];
  }
  const leaf = segments[segments.length - 1];
  if (leaf === "" && Array.isArray(node)) node.push(value);
  else assignLeaf(node, leaf === "" ? "0" : leaf, value);
}

function parseSimple(params: URLSearchParams): Record<string, string | string[]> {
  const body: Record<string, string | string[]> = {};
  for (const [key, value] of params) {
    assignLeaf(body as Record<string, unknown>, key, value);
  }
  return body;
}

function parseExtended(params: URLSearchParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of params) {
    const m = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(key);
    if (!m || !m[2]) {
      assignLeaf(body, key, value);
      continue;
    }
    const segments = [m[1], ...Array.from(m[2].matchAll(/\[([^[\]]*)\]/g), (x) => x[1])];
    setDeep(body, segments, value);
  }
  return body;
}

/**
 * Body parser: populates `req.body` (as a plain object) for
 * `application/x-www-form-urlencoded` requests.
 */
export function urlencoded(options: UrlencodedOptions = {}): Handler {
  const limit = parseLimit(options.limit, 100 * 1024);
  const extended = options.extended ?? false;
  return async (req, _res, next) => {
    if (req.raw.body && req.is("application/x-www-form-urlencoded")) {
      let text: string;
      try {
        text = await readBody(req, limit);
      } catch (err) {
        return next(err);
      }
      try {
        const params = new URLSearchParams(text);
        req.body = extended ? parseExtended(params) : parseSimple(params);
      } catch {
        return next(new HttpError(400, "Invalid form body"));
      }
    }
    next();
  };
}

/** Body parser: populates `req.body` with the raw string for `text/plain` (or `type`) requests. */
export function text(options: TextOptions = {}): Handler {
  const limit = parseLimit(options.limit, 100 * 1024);
  const type = options.type ?? "text/plain";
  return async (req, _res, next) => {
    if (req.raw.body && req.is(type)) {
      try {
        req.body = await readBody(req, limit);
      } catch (err) {
        return next(err);
      }
    }
    next();
  };
}

/** Body parser: populates `req.body` with a `Buffer` for `application/octet-stream` (or `type`) requests. */
export function raw(options: RawOptions = {}): Handler {
  const limit = parseLimit(options.limit, 100 * 1024);
  const type = options.type ?? "application/octet-stream";
  return async (req, _res, next) => {
    if (req.raw.body && req.is(type)) {
      try {
        req.body = await readBytes(req, limit);
      } catch (err) {
        return next(err);
      }
    }
    next();
  };
}

export interface StaticOptions {
  /** File served when the path resolves to a directory, or `false` to disable. Default: "index.html". */
  index?: string | false;
  /** How to treat paths with a dot-prefixed segment (`.env`, `.git/`). Default: "ignore" (fall through). */
  dotfiles?: "allow" | "ignore" | "deny";
  /** `Cache-Control: max-age` in milliseconds, or a string like "1d" / "12h" / "30m". Default: 0. */
  maxAge?: number | string;
  /** Add `immutable` to Cache-Control (pair with a long maxAge and hashed filenames). */
  immutable?: boolean;
  /** Send a weak ETag (size + mtime) and honor `If-None-Match`. Default: true. */
  etag?: boolean;
  /** Send `Last-Modified` and honor `If-Modified-Since`. Default: true. */
  lastModified?: boolean;
  /** Hook to add headers before the file is sent. */
  setHeaders?: (res: ExpressyResponse, path: string) => void;
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_557_600_000,
};

/** Milliseconds from a number or an ms-style string ("1d", "12h", "30m", "10s"). */
function parseDuration(value: number | string | undefined): number {
  if (value === undefined) return 0;
  if (typeof value === "number") return value;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)?$/i.exec(value.trim());
  if (!m) throw new Error(`Invalid duration: "${value}"`);
  return Math.floor(parseFloat(m[1]) * DURATION_UNITS[(m[2] ?? "ms").toLowerCase()]);
}

/** Conditional GET: does the client's cached copy still match? */
function isFresh(req: ExpressyRequest, etag: string | null, mtime: number): boolean {
  const noneMatch = req.raw.headers.get("if-none-match");
  if (noneMatch !== null) {
    if (!etag) return false;
    if (noneMatch.trim() === "*") return true;
    const strip = (t: string) => t.trim().replace(/^W\//, "");
    return noneMatch.split(",").some((t) => strip(t) === strip(etag));
  }
  const since = req.raw.headers.get("if-modified-since");
  if (since !== null) {
    const sinceMs = Date.parse(since);
    // HTTP dates have second precision.
    return Number.isFinite(sinceMs) && Math.floor(mtime / 1000) * 1000 <= sinceMs;
  }
  return false;
}

/**
 * Serves static files from a directory using Bun.file (zero-copy sendfile
 * under the hood), with ETag / Last-Modified conditional requests and
 * Cache-Control. Falls through to the next handler when no file matches.
 */
export function serveStatic(root: string, options: StaticOptions = {}): Handler {
  const rootDir = resolve(root);
  const index = options.index ?? "index.html";
  const dotfiles = options.dotfiles ?? "ignore";
  const maxAgeSeconds = Math.floor(parseDuration(options.maxAge) / 1000);
  const cacheControl = `public, max-age=${maxAgeSeconds}${options.immutable ? ", immutable" : ""}`;
  const useEtag = options.etag ?? true;
  const useLastModified = options.lastModified ?? true;

  return async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    let pathname: string;
    try {
      pathname = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    if (pathname.includes("\0")) return next();

    const filePath = resolve(join(rootDir, pathname));
    // Never escape the root directory.
    if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) return next();

    if (dotfiles !== "allow") {
      const relative = filePath.slice(rootDir.length);
      if (relative.split(sep).some((segment) => segment.startsWith("."))) {
        if (dotfiles === "deny") return next(new HttpError(403));
        return next();
      }
    }

    let file = Bun.file(filePath);
    if (!(await file.exists())) {
      if (index === false) return next();
      file = Bun.file(join(filePath, index));
      if (!(await file.exists())) return next();
    }

    const mtime = file.lastModified;
    const etag = useEtag ? `W/"${file.size.toString(16)}-${Math.floor(mtime).toString(16)}"` : null;
    if (etag) res.set("ETag", etag);
    if (useLastModified) res.set("Last-Modified", new Date(mtime).toUTCString());
    if (!res.hasHeader("Cache-Control")) res.set("Cache-Control", cacheControl);
    options.setHeaders?.(res, filePath);

    if (isFresh(req, etag, mtime)) return res.status(304).end();
    res.send(file);
  };
}

import { join, resolve, sep } from "node:path";
import type { Handler } from "./router";
import type { ExpressyRequest } from "./request";
import { HttpError } from "./errors";

export interface BodyParserOptions {
  /** Max body size: bytes or a string like "2mb" / "500kb". Default: "100kb", like Express. */
  limit?: number | string;
}

export interface UrlencodedOptions extends BodyParserOptions {
  /** qs-style bracket notation (`a[b]=1`, `tags[]=x`). Default: false. */
  extended?: boolean;
}

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

function parseLimit(limit: number | string | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (typeof limit === "number") return limit;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(limit.trim());
  if (!m) throw new Error(`Invalid size limit: "${limit}"`);
  return Math.floor(parseFloat(m[1]) * SIZE_UNITS[(m[2] ?? "b").toLowerCase()]);
}

async function readBody(req: ExpressyRequest, limit: number): Promise<string> {
  const declared = Number(req.raw.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413);
  const text = await req.text();
  if (Buffer.byteLength(text) > limit) throw new HttpError(413);
  return text;
}

/**
 * Body parser: populates `req.body` for `application/json` requests.
 * Malformed JSON produces a 400 through the error-handling chain.
 */
export function json(options: BodyParserOptions = {}): Handler {
  const limit = parseLimit(options.limit, 100 * 1024);
  return async (req, _res, next) => {
    if (req.raw.body && req.is("application/json")) {
      let text: string;
      try {
        text = await readBody(req, limit);
      } catch (err) {
        return next(err);
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

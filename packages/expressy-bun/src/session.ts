import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Handler } from "./router";
import type { ExpressyRequest } from "./request";
import type { ExpressyResponse, CookieOptions } from "./response";

/**
 * Native session support with an express-session-compatible API:
 * same options (`secret`, `resave`, `saveUninitialized`, `cookie`, ...),
 * same signed-cookie wire format (`s:<sid>.<hmac>`), same `req.session`
 * methods (`regenerate`/`save`/`destroy`/`reload`/`touch`, callback or
 * promise style), and the same callback-based Store contract so existing
 * stores (connect-mongo, connect-redis, ...) plug in unchanged.
 */

type SameSite = boolean | "lax" | "strict" | "none" | "Lax" | "Strict" | "None";

export interface SessionCookieOptions {
  /** Cookie lifetime in milliseconds. Omit for a browser-session cookie. */
  maxAge?: number;
  path?: string;
  httpOnly?: boolean;
  domain?: string;
  /** `true`, `false`, or `"auto"` (secure only when the request is HTTPS). */
  secure?: boolean | "auto";
  sameSite?: SameSite;
}

/** Cookie state as serialized into the store alongside the session data. */
export interface SessionCookieData {
  originalMaxAge: number | null;
  expires: string | null;
  path: string;
  httpOnly: boolean;
  domain?: string;
  secure?: boolean | "auto";
  sameSite?: SameSite;
}

/** Session data as persisted in a store. */
export type SessionData = Record<string, unknown> & { cookie?: SessionCookieData };

/**
 * Store contract, callback-style for compatibility with the
 * express-session store ecosystem.
 */
export interface SessionStore {
  get(sid: string, callback: (err?: unknown, session?: SessionData | null) => void): void;
  set(sid: string, session: SessionData, callback?: (err?: unknown) => void): void;
  destroy(sid: string, callback?: (err?: unknown) => void): void;
  touch?(sid: string, session: SessionData, callback?: (err?: unknown) => void): void;
}

export interface SessionOptions {
  /** Secret(s) used to sign the session ID cookie. The first signs; all verify. */
  secret: string | string[];
  /** Session cookie name. Default: "connect.sid" (same as express-session). */
  name?: string;
  cookie?: SessionCookieOptions;
  /** Save unmodified sessions back to the store. Default: false. */
  resave?: boolean;
  /** Persist brand-new sessions even when nothing was stored in them. Default: false. */
  saveUninitialized?: boolean;
  /** Re-issue the cookie on every response, sliding the expiry. Default: false. */
  rolling?: boolean;
  /** Defaults to an in-memory store (fine for dev, not for multi-process production). */
  store?: SessionStore;
  /** Session ID generator. Default: 24 random bytes, base64url. */
  genid?: () => string;
}

type Callback = (err?: unknown) => void;

interface SessionContext {
  id: string;
  isNew: boolean;
  destroyed: boolean;
  /** True once the current sid exists in the store (loaded or saved). */
  persisted: boolean;
  lastSavedJson?: string;
  originalDataJson: string;
  store: SessionStore;
  genid: () => string;
  cookieOptions: SessionCookieOptions;
  req: ExpressyRequest;
}

export class SessionCookie {
  originalMaxAge: number | null;
  expires: Date | null;
  path: string;
  httpOnly: boolean;
  domain?: string;
  secure?: boolean | "auto";
  sameSite?: SameSite;

  constructor(options: SessionCookieOptions = {}, stored?: SessionCookieData) {
    this.path = stored?.path ?? options.path ?? "/";
    this.httpOnly = stored?.httpOnly ?? options.httpOnly ?? true;
    this.domain = stored?.domain ?? options.domain;
    this.secure = stored?.secure ?? options.secure;
    this.sameSite = stored?.sameSite ?? options.sameSite;
    this.originalMaxAge = stored?.originalMaxAge ?? options.maxAge ?? null;
    if (stored?.expires) this.expires = new Date(stored.expires);
    else if (this.originalMaxAge != null) this.expires = new Date(Date.now() + this.originalMaxAge);
    else this.expires = null;
  }

  /** Remaining lifetime in ms (null for browser-session cookies). */
  get maxAge(): number | null {
    return this.expires ? this.expires.getTime() - Date.now() : null;
  }

  set maxAge(ms: number | null) {
    this.originalMaxAge = ms;
    this.expires = ms != null ? new Date(Date.now() + ms) : null;
  }

  /** Slide the expiry window forward from now. */
  touch(): void {
    if (this.originalMaxAge != null) this.expires = new Date(Date.now() + this.originalMaxAge);
  }

  toJSON(): SessionCookieData {
    return {
      originalMaxAge: this.originalMaxAge,
      expires: this.expires ? this.expires.toISOString() : null,
      path: this.path,
      httpOnly: this.httpOnly,
      domain: this.domain,
      secure: this.secure,
      sameSite: this.sameSite,
    };
  }
}

/** Per-request internals live here so they never leak into the serialized session. */
const CTX = new WeakMap<Session, SessionContext>();

/** JSON of the session's own data, excluding the cookie — used for dirty checking. */
function dataJson(sess: Session): string {
  const { cookie: _cookie, ...data } = sess as Record<string, unknown>;
  return JSON.stringify(data);
}

function toStored(sess: Session): SessionData {
  return JSON.parse(JSON.stringify(sess)) as SessionData;
}

/** Callback style when a callback is given, promise style otherwise. */
function hybrid(callback: Callback | undefined, run: () => Promise<void>): Promise<void> | undefined {
  const promise = run();
  if (!callback) return promise;
  promise.then(() => callback(), (err) => callback(err));
  return undefined;
}

export class Session {
  [key: string]: any;
  cookie: SessionCookie;

  constructor(ctx: SessionContext, stored?: SessionData) {
    CTX.set(this, ctx);
    if (stored) {
      const { cookie: _cookie, ...data } = stored;
      Object.assign(this, data);
    }
    this.cookie = new SessionCookie(ctx.cookieOptions, stored?.cookie);
  }

  get id(): string {
    return CTX.get(this)!.id;
  }

  /** Persist the session to the store right away. */
  save(callback?: Callback): Promise<void> | undefined {
    const ctx = CTX.get(this)!;
    return hybrid(callback, async () => {
      const json = dataJson(this);
      await storeSet(ctx.store, ctx.id, toStored(this));
      ctx.persisted = true;
      ctx.lastSavedJson = json;
    });
  }

  /** Replace the session with a fresh, empty one under a new ID. */
  regenerate(callback?: Callback): Promise<void> | undefined {
    const ctx = CTX.get(this)!;
    return hybrid(callback, async () => {
      await storeDestroy(ctx.store, ctx.id);
      ctx.id = ctx.genid();
      ctx.isNew = true;
      ctx.persisted = false;
      ctx.lastSavedJson = undefined;
      const fresh = new Session(ctx);
      ctx.originalDataJson = dataJson(fresh);
      ctx.req.sessionID = ctx.id;
      ctx.req.session = fresh;
    });
  }

  /** Remove the session from the store and unset `req.session`. */
  destroy(callback?: Callback): Promise<void> | undefined {
    const ctx = CTX.get(this)!;
    return hybrid(callback, async () => {
      ctx.destroyed = true;
      ctx.req.session = undefined;
      await storeDestroy(ctx.store, ctx.id);
    });
  }

  /** Re-read the session data from the store, discarding local changes. */
  reload(callback?: Callback): Promise<void> | undefined {
    const ctx = CTX.get(this)!;
    return hybrid(callback, async () => {
      const stored = await storeGet(ctx.store, ctx.id);
      if (!stored) throw new Error("failed to load session");
      for (const key of Object.keys(this)) {
        if (key !== "cookie") delete this[key];
      }
      const { cookie: _cookie, ...data } = stored;
      Object.assign(this, data);
    });
  }

  /** Slide the cookie expiry forward. */
  touch(): this {
    this.cookie.touch();
    return this;
  }
}

export class MemoryStore implements SessionStore {
  private sessions = new Map<string, string>();

  get(sid: string, callback: (err?: unknown, session?: SessionData | null) => void): void {
    const raw = this.sessions.get(sid);
    if (raw === undefined) return callback(undefined, null);
    let data: SessionData;
    try {
      data = JSON.parse(raw) as SessionData;
    } catch (err) {
      return callback(err);
    }
    const expires = data.cookie?.expires;
    if (expires && new Date(expires).getTime() <= Date.now()) {
      this.sessions.delete(sid);
      return callback(undefined, null);
    }
    callback(undefined, data);
  }

  set(sid: string, session: SessionData, callback?: Callback): void {
    this.sessions.set(sid, JSON.stringify(session));
    callback?.();
  }

  destroy(sid: string, callback?: Callback): void {
    this.sessions.delete(sid);
    callback?.();
  }

  touch(sid: string, session: SessionData, callback?: Callback): void {
    if (this.sessions.has(sid)) this.sessions.set(sid, JSON.stringify(session));
    callback?.();
  }

  all(callback: (err?: unknown, sessions?: Record<string, SessionData>) => void): void {
    const all: Record<string, SessionData> = {};
    for (const [sid, raw] of this.sessions) all[sid] = JSON.parse(raw) as SessionData;
    callback(undefined, all);
  }

  length(callback: (err?: unknown, length?: number) => void): void {
    callback(undefined, this.sessions.size);
  }

  clear(callback?: Callback): void {
    this.sessions.clear();
    callback?.();
  }
}

function storeGet(store: SessionStore, sid: string): Promise<SessionData | null> {
  return new Promise((resolve, reject) => {
    store.get(sid, (err, session) => (err ? reject(err) : resolve(session ?? null)));
  });
}

function storeSet(store: SessionStore, sid: string, data: SessionData): Promise<void> {
  return new Promise((resolve, reject) => {
    store.set(sid, data, (err) => (err ? reject(err) : resolve()));
  });
}

function storeDestroy(store: SessionStore, sid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    store.destroy(sid, (err) => (err ? reject(err) : resolve()));
  });
}

function storeTouch(store: SessionStore, sid: string, data: SessionData): Promise<void> {
  return new Promise((resolve, reject) => {
    store.touch!(sid, data, (err) => (err ? reject(err) : resolve()));
  });
}

/** HMAC-SHA256 signature, same wire format as the `cookie-signature` package. */
function sign(value: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(value).digest("base64").replace(/=+$/, "");
  return `${value}.${mac}`;
}

function unsign(signed: string, secrets: string[]): string | null {
  const dot = signed.lastIndexOf(".");
  if (dot === -1) return null;
  const value = signed.slice(0, dot);
  for (const secret of secrets) {
    const expected = Buffer.from(sign(value, secret));
    const actual = Buffer.from(signed);
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return value;
  }
  return null;
}

function normalizeSameSite(value: SameSite | undefined): CookieOptions["sameSite"] {
  if (value === undefined || value === false) return undefined;
  if (value === true) return "Strict";
  return value;
}

function issueCookie(
  res: ExpressyResponse,
  req: ExpressyRequest,
  name: string,
  sid: string,
  secret: string,
  cookie: SessionCookie,
): void {
  const secure = cookie.secure === "auto" ? req.secure : Boolean(cookie.secure);
  res.cookie(name, `s:${sign(sid, secret)}`, {
    path: cookie.path,
    httpOnly: cookie.httpOnly,
    domain: cookie.domain,
    secure,
    sameSite: normalizeSameSite(cookie.sameSite),
    expires: cookie.expires ?? undefined,
  });
}

export function session(options: SessionOptions): Handler {
  const secrets = Array.isArray(options?.secret) ? options.secret : [options?.secret];
  if (!secrets[0]) throw new Error("session() requires a `secret` option");
  const name = options.name ?? "connect.sid";
  const store = options.store ?? new MemoryStore();
  const resave = options.resave ?? false;
  const saveUninitialized = options.saveUninitialized ?? false;
  const rolling = options.rolling ?? false;
  const genid = options.genid ?? (() => randomBytes(24).toString("base64url"));
  const cookieOptions = options.cookie ?? {};

  return async (req, res, next) => {
    if (req.session) return next();

    let sid: string | null = null;
    const rawValue = req.cookies[name];
    if (rawValue?.startsWith("s:")) sid = unsign(rawValue.slice(2), secrets);

    let stored: SessionData | null = null;
    if (sid) {
      try {
        stored = await storeGet(store, sid);
      } catch (err) {
        return next(err);
      }
      if (!stored) sid = null;
    }

    const ctx: SessionContext = {
      id: sid ?? genid(),
      isNew: !stored,
      destroyed: false,
      persisted: Boolean(stored),
      originalDataJson: "",
      store,
      genid,
      cookieOptions,
      req,
    };

    req.sessionID = ctx.id;
    req.session = new Session(ctx, stored ?? undefined);
    ctx.originalDataJson = dataJson(req.session);

    // Persist + issue the cookie right before the Response is built, so
    // handlers can mutate the session at any point during the request.
    res.onBeforeSend(async () => {
      const sess = req.session;
      if (!sess || ctx.destroyed) return;
      const json = dataJson(sess);
      const modified = json !== ctx.originalDataJson;
      const shouldSave =
        (ctx.isNew ? modified || saveUninitialized : modified || resave) &&
        json !== ctx.lastSavedJson;
      try {
        if (shouldSave) {
          await storeSet(store, ctx.id, toStored(sess));
          ctx.persisted = true;
          ctx.lastSavedJson = json;
        } else if (!ctx.isNew) {
          sess.cookie.touch();
          if (store.touch) await storeTouch(store, ctx.id, toStored(sess));
        }
      } catch (err) {
        console.error("[expressy] session store save failed:", err);
      }
      if (ctx.persisted && (ctx.isNew || rolling)) {
        issueCookie(res, req, name, ctx.id, secrets[0], sess.cookie);
      }
    });

    next();
  };
}

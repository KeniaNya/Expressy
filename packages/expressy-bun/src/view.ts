import { extname, resolve } from "node:path";

/** Template engine signature, same contract as Express: `(path, locals, cb)`. */
export type Engine = (
  path: string,
  options: Record<string, unknown>,
  callback: (err: unknown, html?: string) => void,
) => void;

export interface ViewOptions {
  /** Extension used when the view name has none (the `view engine` setting). */
  defaultEngine?: string;
  /** Directory the view name is resolved against (the `views` setting). */
  root?: string;
  /** Engines registered via `app.engine(ext, fn)`, keyed by ".ext". */
  engines?: Record<string, Engine>;
}

/**
 * Default view implementation, mirroring Express's View contract.
 * Template engines integrate either through `app.engine(ext, fn)` or by
 * replacing this class entirely with `app.set("view", CustomView)` — which
 * is how nunjucks's `express:` option plugs in.
 */
export class View {
  name: string;
  ext: string;
  path: string;
  private engine: Engine;

  constructor(name: string, opts: ViewOptions = {}) {
    this.name = name;
    let ext = extname(name);
    if (!ext && !opts.defaultEngine) {
      throw new Error("No default engine was specified and no extension was provided.");
    }
    if (!ext) {
      ext = opts.defaultEngine!.startsWith(".") ? opts.defaultEngine! : `.${opts.defaultEngine}`;
      this.name = name + ext;
    }
    this.ext = ext;
    const engine = opts.engines?.[ext];
    if (!engine) {
      throw new Error(`No engine registered for "${ext}" views — call app.engine("${ext.slice(1)}", fn)`);
    }
    this.engine = engine;
    this.path = resolve(opts.root ?? "views", this.name);
  }

  render(options: Record<string, unknown>, callback: (err: unknown, html?: string) => void): void {
    this.engine(this.path, options, callback);
  }
}

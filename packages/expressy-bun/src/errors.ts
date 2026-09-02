import { STATUS_CODES } from "node:http";

/**
 * Throw (or `next()`) one of these from any handler and the default error
 * responder — or your own error middleware — will pick up the status code.
 *
 *     throw new HttpError(404, "No such note");
 */
export class HttpError extends Error {
  readonly status: number;
  /** Express-style alias for `status`. */
  readonly statusCode: number;
  /** True for 4xx errors: safe to show the message to the client. */
  readonly expose: boolean;

  constructor(status: number, message?: string) {
    super(message ?? STATUS_CODES[status] ?? `HTTP Error ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.statusCode = status;
    this.expose = status < 500;
  }
}

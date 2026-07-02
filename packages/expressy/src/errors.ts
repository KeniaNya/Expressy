const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  503: "Service Unavailable",
};

/**
 * Throw (or `next()`) one of these from any handler and the default error
 * responder — or your own error middleware — will pick up the status code.
 *
 *     throw new HttpError(404, "No such note");
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? STATUS_TEXT[status] ?? `HTTP Error ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

import type { ErrorRequestHandler, RequestHandler } from "express";

export class HttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new HttpError(404, "not_found", "The requested resource was not found"));
};

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  _next
) => {
  if (error instanceof HttpError) {
    response.status(error.status).json({
      error: { code: error.code, message: error.message }
    });
    return;
  }

  const status =
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    Reflect.get(error, "type") === "entity.too.large"
      ? 413
      : 500;
  response.status(status).json({
    error: {
      code: status === 413 ? "payload_too_large" : "internal_error",
      message: status === 413 ? "The request payload is too large" : "The request failed"
    }
  });
};

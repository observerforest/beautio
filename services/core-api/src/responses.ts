import { BeautioError, type BeautioErrorCode } from "@beautio/domain";
import type { ServerResponse } from "node:http";

export function sendNotFound(response: ServerResponse): void {
  sendJson(response, 404, {
    error: { code: "INVALID_INPUT", message: "Route not found." },
  });
}

export function sendError(response: ServerResponse, error: unknown): void {
  if (!(error instanceof BeautioError)) {
    sendJson(response, 500, {
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
      },
    });
    return;
  }
  sendJson(response, statusFor(error.code), {
    error: {
      code: error.code,
      message: error.message,
      ...(error.ref === undefined ? {} : { ref: error.ref }),
    },
  });
}

export function statusFor(code: BeautioErrorCode): number {
  switch (code) {
    case "INVALID_INPUT":
    case "FILE_SOURCE_REJECTED":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "PRODUCT_NOT_FOUND":
    case "INVENTORY_ITEM_NOT_FOUND":
    case "IMAGE_ASSET_NOT_FOUND":
      return 404;
    case "INVENTORY_ITEM_TERMINAL":
    case "OPENED_ON_CONFLICT":
    case "IMAGE_ASSET_EXPIRED":
    case "BATCH_CONFLICT":
      return 409;
    case "UPLOAD_TOO_LARGE":
      return 413;
    case "UNSUPPORTED_MEDIA_TYPE":
      return 415;
    case "UPLOAD_FAILED":
      return 502;
    case "INTERNAL_ERROR":
      return 500;
  }
}

export function invalidInput(): BeautioError {
  return new BeautioError(
    "INVALID_INPUT",
    "input does not match the HTTP contract",
  );
}

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-beautio-mode": "managed",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

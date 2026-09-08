import { CommandExecutionError } from "@beautio/application";
import { BeautioError } from "@beautio/domain";
import type { ServerResponse } from "node:http";
import { sendJson } from "./responses.ts";
import { CustomGptResponseTooLargeError } from "./custom-gpt-payload-limits.ts";

/**
 * Maps read failures to fixed public messages without exception details or refs.
 * @param response - Pending authenticated Action response.
 * @param error - Untrusted failure from parsing, storage or an adapter.
 * @returns Nothing after a bounded error response; no raw error content is sent.
 */
export function sendCustomGptReadError(response: ServerResponse, error: unknown): void {
  if (error instanceof CustomGptResponseTooLargeError) {
    sendJson(response, 422, { error: { code: "RESPONSE_TOO_LARGE", message: `The complete read response exceeds the ${error.maximumBytes}-byte UTF-8 JSON limit. No result was returned or truncated. This does not establish the outcome of any earlier write. Do not automatically retry the same request or write.` } });
  } else if ((error instanceof BeautioError && error.code === "INVALID_INPUT") ||
      (error instanceof CommandExecutionError && error.code === "COMMAND_INPUT_INVALID")) {
    sendJson(response, 400, { error: { code: "INVALID_INPUT", message: "Invalid read request or request body deadline exceeded." } });
  } else if (error instanceof BeautioError && error.code === "UPLOAD_TOO_LARGE") {
    sendJson(response, 413, { error: { code: "UPLOAD_TOO_LARGE", message: "Read request body exceeds the size limit." } });
  } else if (error instanceof BeautioError && error.code === "INVENTORY_ITEM_NOT_FOUND") {
    sendJson(response, 404, { error: { code: "INVENTORY_ITEM_NOT_FOUND", message: "Inventory item does not exist." } });
  } else if (error instanceof BeautioError && error.code === "INTERNAL_ERROR" &&
      error.message === "inventory search exceeds the 1000-item safety limit") {
    sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Inventory search exceeds the 1000-item safety limit." } });
  } else {
    sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "The read request could not be completed." } });
  }
}

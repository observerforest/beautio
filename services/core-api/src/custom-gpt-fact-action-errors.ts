import { CommandExecutionError } from "@beautio/application";
import { customGptFactActionErrorSchema } from "@beautio/contracts";
import { BeautioError } from "@beautio/domain";
import type { ServerResponse } from "node:http";
import { sendJson } from "./responses.ts";

export type CustomGptFactActionErrorPhase =
  | "preparation"
  | "exclusive_queue"
  | "execution";

/**
 * Sends one fixed public error without exposing command payloads or persistence details.
 *
 * @param response - Pending authenticated Action response.
 * @param error - Untrusted failure raised while preparing, queueing, or executing.
 * @param phase - Furthest phase entered; execution failures are always treated as unknown.
 * @returns Nothing after a strict bounded JSON response is sent.
 */
export function sendCustomGptFactActionError(
  response: ServerResponse,
  error: unknown,
  phase: CustomGptFactActionErrorPhase,
): void {
  if (
    phase === "preparation" &&
    ((error instanceof BeautioError && error.code === "INVALID_INPUT") ||
      (error instanceof CommandExecutionError &&
        (error.code === "COMMAND_INPUT_INVALID" ||
          error.code === "COMMAND_RESULT_TOO_LARGE")))
  ) {
    sendFactError(response, 400, "INVALID_INPUT", "Invalid fact Action request or request body deadline exceeded.");
    return;
  }
  if (
    phase === "preparation" &&
    error instanceof BeautioError &&
    error.code === "UPLOAD_TOO_LARGE"
  ) {
    sendFactError(response, 413, "UPLOAD_TOO_LARGE", "Fact Action request body exceeds the size limit.");
    return;
  }
  if (
    (phase === "preparation" || phase === "exclusive_queue") &&
    error instanceof BeautioError &&
    error.code === "BATCH_CONFLICT"
  ) {
    sendFactError(response, 503, "COMMAND_STORE_BUSY", "Fact Actions are temporarily busy.");
    return;
  }
  if (
    error instanceof CommandExecutionError &&
    error.code === "COMMAND_PAYLOAD_CONFLICT"
  ) {
    sendFactError(response, 409, "COMMAND_PAYLOAD_CONFLICT", "command_id was already used for a different confirmed request.");
    return;
  }
  if (
    error instanceof CommandExecutionError &&
    error.code === "COMMAND_STORE_BUSY"
  ) {
    sendFactError(
      response,
      503,
      "COMMAND_STORE_BUSY",
      phase === "execution"
        ? "The command outcome may be unknown. Check command status and inventory facts before taking another action."
        : "Fact Actions are temporarily busy.",
    );
    return;
  }
  if (phase === "execution") {
    sendFactError(
      response,
      500,
      "COMMAND_STORE_FAILURE",
      "The command outcome is unknown. Check command status and inventory facts before taking another action.",
    );
    return;
  }
  sendFactError(response, 500, "INTERNAL_ERROR", "The fact Action could not be completed.");
}

/**
 * Sends the fixed unavailable response for a reserved fact Action route.
 * @param response - Pending authenticated Action response.
 * @returns Nothing after the response is sent.
 */
export function sendCustomGptFactActionNotFound(response: ServerResponse): void {
  sendFactError(response, 404, "NOT_FOUND", "Fact Action route is not available.");
}

function sendFactError(
  response: ServerResponse,
  statusCode: number,
  code:
    | "INVALID_INPUT"
    | "NOT_FOUND"
    | "UPLOAD_TOO_LARGE"
    | "COMMAND_PAYLOAD_CONFLICT"
    | "COMMAND_STORE_BUSY"
    | "COMMAND_STORE_FAILURE"
    | "INTERNAL_ERROR",
  message: string,
): void {
  sendJson(
    response,
    statusCode,
    customGptFactActionErrorSchema.parse({ error: { code, message } }),
  );
}

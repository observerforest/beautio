import { CommandExecutionError } from "@beautio/application";
import { customGptCreateActionErrorSchema } from "@beautio/contracts";
import { BeautioError } from "@beautio/domain";
import type { ServerResponse } from "node:http";
import { sendJson } from "./responses.ts";

export type CustomGptCreateActionErrorPhase =
  | "preparation"
  | "exclusive_queue"
  | "execution";

/**
 * Sends one fixed create-Action error without exposing input or persistence details.
 *
 * @param response - Pending authenticated Action response.
 * @param error - Untrusted failure raised while preparing, queueing, or executing.
 * @param phase - Furthest phase entered; execution failures always have an unknown outcome.
 * @returns Nothing after a strict bounded JSON response is sent.
 */
export function sendCustomGptCreateActionError(
  response: ServerResponse,
  error: unknown,
  phase: CustomGptCreateActionErrorPhase,
): void {
  if (
    phase === "preparation" &&
    ((error instanceof BeautioError && error.code === "INVALID_INPUT") ||
      (error instanceof CommandExecutionError &&
        (error.code === "COMMAND_INPUT_INVALID" ||
          error.code === "COMMAND_RESULT_TOO_LARGE")))
  ) {
    sendCreateError(
      response,
      400,
      "INVALID_INPUT",
      "Invalid create inventory Action request or request body deadline exceeded.",
    );
    return;
  }
  if (
    phase === "preparation" &&
    error instanceof BeautioError &&
    error.code === "UPLOAD_TOO_LARGE"
  ) {
    sendCreateError(
      response,
      413,
      "UPLOAD_TOO_LARGE",
      "Create inventory Action request body exceeds the size limit.",
    );
    return;
  }
  if (
    (phase === "preparation" || phase === "exclusive_queue") &&
    error instanceof BeautioError &&
    error.code === "BATCH_CONFLICT"
  ) {
    sendCreateError(
      response,
      503,
      "COMMAND_STORE_BUSY",
      "Create inventory Actions are temporarily busy.",
    );
    return;
  }
  if (
    error instanceof CommandExecutionError &&
    error.code === "COMMAND_PAYLOAD_CONFLICT"
  ) {
    sendCreateError(
      response,
      409,
      "COMMAND_PAYLOAD_CONFLICT",
      "command_id was already used for a different confirmed request.",
    );
    return;
  }
  if (
    error instanceof CommandExecutionError &&
    error.code === "COMMAND_STORE_BUSY"
  ) {
    sendCreateError(
      response,
      503,
      "COMMAND_STORE_BUSY",
      phase === "execution"
        ? "The command outcome may be unknown. Check command status and inventory facts before taking another action."
        : "Create inventory Actions are temporarily busy.",
    );
    return;
  }
  if (phase === "execution") {
    sendCreateError(
      response,
      500,
      "COMMAND_STORE_FAILURE",
      "The command outcome is unknown. Check command status and inventory facts before taking another action.",
    );
    return;
  }
  sendCreateError(
    response,
    500,
    "INTERNAL_ERROR",
    "The create inventory Action could not be completed.",
  );
}

/**
 * Sends the fixed unavailable response for the reserved create Action path.
 *
 * @param response - Pending authenticated Action response.
 * @returns Nothing after the response is sent.
 */
export function sendCustomGptCreateActionNotFound(
  response: ServerResponse,
): void {
  sendCreateError(
    response,
    404,
    "NOT_FOUND",
    "Create inventory Action route is not available.",
  );
}

function sendCreateError(
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
    customGptCreateActionErrorSchema.parse({ error: { code, message } }),
  );
}

import { CommandExecutionError } from "@beautio/application";
import { customGptImageActionErrorSchema } from "@beautio/contracts";
import { BeautioError } from "@beautio/domain";
import type { ServerResponse } from "node:http";
import { sendJson } from "./responses.ts";

export type CustomGptImageActionErrorPhase =
  | "preparation"
  | "claim_queue"
  | "claim"
  | "owned_preparation"
  | "final_queue"
  | "execution";

/**
 * Sends one fixed image-Action error without exposing file references or storage details.
 *
 * @param response - Pending authenticated Action response.
 * @param error - Untrusted failure raised while preparing, claiming, or executing.
 * @param phase - Furthest phase entered; failures after claim starts have an unknown outcome.
 * @returns Nothing after a strict bounded JSON response is sent.
 */
export function sendCustomGptImageActionError(
  response: ServerResponse,
  error: unknown,
  phase: CustomGptImageActionErrorPhase,
): void {
  if (
    phase === "preparation" &&
    ((error instanceof BeautioError && error.code === "INVALID_INPUT") ||
      (error instanceof CommandExecutionError &&
        (error.code === "COMMAND_INPUT_INVALID" ||
          error.code === "COMMAND_RESULT_TOO_LARGE")))
  ) {
    sendImageError(
      response,
      400,
      "INVALID_INPUT",
      "Invalid image Action request or request body deadline exceeded.",
    );
    return;
  }
  if (
    phase === "preparation" &&
    error instanceof BeautioError &&
    error.code === "UPLOAD_TOO_LARGE"
  ) {
    sendImageError(
      response,
      413,
      "UPLOAD_TOO_LARGE",
      "Image Action request body exceeds the size limit.",
    );
    return;
  }
  if (
    (phase === "preparation" || phase === "claim_queue") &&
    error instanceof BeautioError &&
    error.code === "BATCH_CONFLICT"
  ) {
    sendImageError(
      response,
      503,
      "COMMAND_STORE_BUSY",
      "Image Actions are temporarily busy.",
    );
    return;
  }
  if (
    error instanceof CommandExecutionError &&
    error.code === "COMMAND_PAYLOAD_CONFLICT"
  ) {
    sendImageError(
      response,
      409,
      "COMMAND_PAYLOAD_CONFLICT",
      "command_id was already used for a different confirmed request.",
    );
    return;
  }
  if (
    (phase === "preparation" || phase === "claim_queue") &&
    error instanceof CommandExecutionError &&
    error.code === "COMMAND_STORE_BUSY"
  ) {
    sendImageError(
      response,
      503,
      "COMMAND_STORE_BUSY",
      "Image Actions are temporarily busy.",
    );
    return;
  }
  if (
    phase === "claim" ||
    phase === "owned_preparation" ||
    phase === "final_queue" ||
    phase === "execution"
  ) {
    sendImageError(
      response,
      500,
      "COMMAND_STORE_FAILURE",
      "The command outcome is unknown. Check command status and image or Product facts before taking another action.",
    );
    return;
  }
  sendImageError(
    response,
    500,
    "INTERNAL_ERROR",
    "The image Action could not be completed.",
  );
}

/**
 * Sends the fixed unavailable response for reserved Custom GPT image paths.
 * @param response - Pending authenticated Action response.
 * @returns Nothing after the response is sent.
 */
export function sendCustomGptImageActionNotFound(
  response: ServerResponse,
): void {
  sendImageError(
    response,
    404,
    "NOT_FOUND",
    "Image Action route is not available.",
  );
}

function sendImageError(
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
    customGptImageActionErrorSchema.parse({ error: { code, message } }),
  );
}

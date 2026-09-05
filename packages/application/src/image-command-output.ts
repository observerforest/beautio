import {
  customGptSetDisplayImageCommandOutputSchema, customGptUploadImagesCommandOutputSchema,
  type ImageCommandFailureCode,
} from "@beautio/contracts";
import { CommandExecutionError, type CommandExecutionView, type SucceededCommandExecutionRecord } from "./command-execution-types.ts";
import type { ClaimedCommandExecution } from "./command-execution-service.ts";

export const imageCommandFailureMessages: Readonly<Record<ImageCommandFailureCode, string>> = {
  INVALID_INPUT: "The confirmed image request is invalid.", UPLOAD_TOO_LARGE: "The images exceed the upload limits.",
  UNSUPPORTED_MEDIA_TYPE: "An image is not a supported static image.", PRODUCT_NOT_FOUND: "The Product is unavailable.",
  REVISION_CONFLICT: "The Product changed since confirmation.", IMAGE_ASSET_NOT_FOUND: "The selected image is unavailable.",
  IMAGE_ASSET_EXPIRED: "The selected image expired.", BATCH_CONFLICT: "The image ownership does not allow this association.",
};

/** @returns A fixed unknown-outcome error without transport or storage details. */
export function unknownImageCommandOutcome(): CommandExecutionError {
  return new CommandExecutionError("COMMAND_STORE_FAILURE", "image command outcome is unknown; inspect command status before any new confirmation");
}
/** @param record - Persisted success. @param claim - Current owner. @returns Safe view only when persisted identity matches. */
export function imageCommandRecordView(record: SucceededCommandExecutionRecord, claim: ClaimedCommandExecution): CommandExecutionView {
  const { key, payloadSha256, ...state } = record;
  if (key.principal !== claim.key.principal || key.operationId !== claim.key.operationId ||
    key.commandId !== claim.key.commandId || payloadSha256 !== claim.payloadSha256) throw unknownImageCommandOutcome();
  return { ...state, operationId: key.operationId, commandId: key.commandId };
}
function fields(record: CommandExecutionView, commandId: string) {
  if (record.commandId !== commandId) throw unknownImageCommandOutcome();
  return { operation_id: record.operationId, command_id: record.commandId, status: record.status,
    created_at: record.createdAt, completed_at: record.completedAt,
    failure_code: record.status === "failed" ? record.failure?.code ?? null : null,
    result: record.status === "succeeded" ? record.result : null,
  };
}
/** @param record - Persisted or replayed state. @param commandId - Expected command. @returns Strict safe upload response. */
export function toImageUploadCommandOutput(record: CommandExecutionView, commandId: string) {
  return customGptUploadImagesCommandOutputSchema.parse(fields(record, commandId));
}
/** @param record - Persisted or replayed state. @param commandId - Expected command. @returns Strict safe display-image response. */
export function toSetDisplayImageCommandOutput(record: CommandExecutionView, commandId: string) {
  return customGptSetDisplayImageCommandOutputSchema.parse(fields(record, commandId));
}

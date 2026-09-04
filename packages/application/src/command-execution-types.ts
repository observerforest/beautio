import type {
  CommandExecutionPrincipal,
  CommandExecutionStatus,
  CommandId,
  ConsequentialCommandOperationId,
} from "@beautio/contracts";
import type { IsoInstant } from "@beautio/domain";

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

declare const commandPayloadSha256Brand: unique symbol;

export type CommandPayloadSha256 = string & {
  readonly [commandPayloadSha256Brand]: true;
};

declare const canonicalCommandPayloadBrand: unique symbol;

export interface CanonicalCommandPayload {
  readonly sha256: CommandPayloadSha256;
  readonly [canonicalCommandPayloadBrand]: true;
}

declare const safeCommandResultBrand: unique symbol;

export interface SafeCommandResult {
  readonly value: JsonObject;
  readonly serialized: string;
  readonly [safeCommandResultBrand]: true;
}

export interface KnownCommandFailure {
  readonly code: string;
  readonly message: string;
  readonly ref?: string;
}

export interface CommandExecutionKey {
  readonly principal: CommandExecutionPrincipal;
  readonly operationId: ConsequentialCommandOperationId;
  readonly commandId: CommandId;
}

interface CommandExecutionRecordBase {
  readonly key: CommandExecutionKey;
  readonly payloadSha256: CommandPayloadSha256;
  readonly status: CommandExecutionStatus;
  readonly createdAt: IsoInstant;
}

export interface InProgressCommandExecutionRecord
  extends CommandExecutionRecordBase {
  readonly status: "in_progress";
  readonly completedAt: null;
  readonly result: null;
  readonly failure: null;
}

export interface SucceededCommandExecutionRecord
  extends CommandExecutionRecordBase {
  readonly status: "succeeded";
  readonly completedAt: IsoInstant;
  readonly result: JsonObject;
  readonly failure: null;
}

export interface FailedCommandExecutionRecord extends CommandExecutionRecordBase {
  readonly status: "failed";
  readonly completedAt: IsoInstant;
  readonly result: null;
  readonly failure: KnownCommandFailure;
}

export type CommandExecutionRecord =
  | InProgressCommandExecutionRecord
  | SucceededCommandExecutionRecord
  | FailedCommandExecutionRecord;

export type CommandExecutionView = Omit<
  CommandExecutionRecord,
  "key" | "payloadSha256"
> & {
  readonly operationId: ConsequentialCommandOperationId;
  readonly commandId: CommandId;
};

export const maximumStoredCommandResultBytes = 4 * 1024;
export const maximumStoredCommandFailureCodeBytes = 64;
export const maximumStoredCommandFailureMessageBytes = 512;
export const maximumStoredCommandFailureRefBytes = 256;

export const commandExecutionErrorCodes = [
  "COMMAND_INPUT_INVALID",
  "COMMAND_PAYLOAD_CONFLICT",
  "COMMAND_STATE_CONFLICT",
  "COMMAND_RESULT_TOO_LARGE",
  "COMMAND_STORE_BUSY",
  "COMMAND_STORE_FAILURE",
] as const;

export type CommandExecutionErrorCode =
  (typeof commandExecutionErrorCodes)[number];

export class CommandExecutionError extends Error {
  readonly code: CommandExecutionErrorCode;

  /**
   * Creates a stable CommandExecution failure without retaining command payloads.
   *
   * @param code - Stable machine-readable failure category.
   * @param message - Safe explanation that excludes payloads, hashes, and credentials.
   */
  constructor(code: CommandExecutionErrorCode, message: string) {
    super(message);
    this.name = "CommandExecutionError";
    this.code = code;
  }
}

import {
  CommandExecutionError,
  createKnownCommandFailure,
  createSafeCommandResult,
  isCommandPayloadSha256,
  type ClaimCommandExecutionPersistenceInput,
  type ClaimCommandExecutionPersistenceResult,
  type CommandExecutionKey,
  type CommandExecutionRecord,
  type CompleteCommandExecutionFailurePersistenceInput,
  type CompleteCommandExecutionPersistenceResult,
  type CompleteCommandExecutionSuccessPersistenceInput,
} from "@beautio/application";
import {
  commandExecutionPrincipalSchema,
  commandExecutionStatusSchema,
  commandIdSchema,
  consequentialCommandOperationIdSchema,
} from "@beautio/contracts";
import { parseNullableIsoInstant } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";

interface CommandExecutionRow {
  readonly principal: string;
  readonly operation_id: string;
  readonly command_id: string;
  readonly payload_sha256: string;
  readonly status: string;
  readonly result_json: string | null;
  readonly failure_code: string | null;
  readonly failure_message: string | null;
  readonly failure_ref: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
}

export function claimCommandExecutionRecord(
  database: DatabaseSync,
  input: ClaimCommandExecutionPersistenceInput,
): ClaimCommandExecutionPersistenceResult {
  return inCommandExecutionTransaction(database, () => {
    const inserted = database
      .prepare(
        `INSERT INTO command_executions (
          principal,
          operation_id,
          command_id,
          payload_sha256,
          status,
          result_json,
          failure_code,
          failure_message,
          failure_ref,
          created_at,
          completed_at
        ) VALUES (?, ?, ?, ?, 'in_progress', NULL, NULL, NULL, NULL, ?, NULL)
        ON CONFLICT(principal, operation_id, command_id) DO NOTHING`,
      )
      .run(
        input.key.principal,
        input.key.operationId,
        input.key.commandId,
        input.payloadSha256,
        input.createdAt,
      );
    const record = readRequiredCommandExecutionRecord(database, input.key);
    return {
      inserted: inserted.changes === 1 || inserted.changes === 1n,
      record,
    };
  });
}

export function completeCommandExecutionSuccessRecord(
  database: DatabaseSync,
  input: CompleteCommandExecutionSuccessPersistenceInput,
): CompleteCommandExecutionPersistenceResult {
  return inCommandExecutionTransaction(database, () => completeCommandExecutionSuccessInTransaction(database, input));
}

/**
 * Performs the existing success CAS without opening or committing a transaction.
 * @param database - Connection inside a transaction owned by the caller.
 * @param input - Original claim, bounded result and completion candidate instant.
 * @returns CAS ownership and the persisted row for the caller's pre-commit verification.
 */
export function completeCommandExecutionSuccessInTransaction(
  database: DatabaseSync,
  input: CompleteCommandExecutionSuccessPersistenceInput,
): CompleteCommandExecutionPersistenceResult {
  const changes = database
      .prepare(
        `UPDATE command_executions
        SET status = 'succeeded',
            result_json = ?,
            completed_at = ?
        WHERE principal = ?
          AND operation_id = ?
          AND command_id = ?
          AND payload_sha256 = ?
          AND status = 'in_progress'`,
      )
      .run(
        input.result.serialized,
        input.completedAt,
        input.key.principal,
        input.key.operationId,
        input.key.commandId,
        input.payloadSha256,
      ).changes;
  return { updated: changes === 1 || changes === 1n, record: findCommandExecutionRecord(database, input.key) };
}

export function completeCommandExecutionKnownFailureRecord(
  database: DatabaseSync,
  input: CompleteCommandExecutionFailurePersistenceInput,
): CompleteCommandExecutionPersistenceResult {
  return settleCommandExecutionRecord(database, input.key, () =>
    database
      .prepare(
        `UPDATE command_executions
        SET status = 'failed',
            failure_code = ?,
            failure_message = ?,
            failure_ref = ?,
            completed_at = ?
        WHERE principal = ?
          AND operation_id = ?
          AND command_id = ?
          AND payload_sha256 = ?
          AND status = 'in_progress'`,
      )
      .run(
        input.failure.code,
        input.failure.message,
        input.failure.ref ?? null,
        input.completedAt,
        input.key.principal,
        input.key.operationId,
        input.key.commandId,
        input.payloadSha256,
      ).changes,
  );
}

export function findCommandExecutionRecord(
  database: DatabaseSync,
  key: CommandExecutionKey,
): CommandExecutionRecord | null {
  try {
    const row = database
      .prepare(
        `SELECT
          principal,
          operation_id,
          command_id,
          payload_sha256,
          status,
          result_json,
          failure_code,
          failure_message,
          failure_ref,
          created_at,
          completed_at
        FROM command_executions
        WHERE principal = ? AND operation_id = ? AND command_id = ?`,
      )
      .get(key.principal, key.operationId, key.commandId) as
      | CommandExecutionRow
      | undefined;
    return row === undefined ? null : mapCommandExecutionRow(row);
  } catch (error) {
    throw mapCommandStoreError(error);
  }
}

function settleCommandExecutionRecord(
  database: DatabaseSync,
  key: CommandExecutionKey,
  update: () => number | bigint,
): CompleteCommandExecutionPersistenceResult {
  return inCommandExecutionTransaction(database, () => {
    const changes = update();
    return {
      updated: changes === 1 || changes === 1n,
      record: findCommandExecutionRecord(database, key),
    };
  });
}

function readRequiredCommandExecutionRecord(
  database: DatabaseSync,
  key: CommandExecutionKey,
): CommandExecutionRecord {
  const record = findCommandExecutionRecord(database, key);
  if (record === null) {
    throw new CommandExecutionError(
      "COMMAND_STORE_FAILURE",
      "command claim could not be read after persistence",
    );
  }
  return record;
}

function mapCommandExecutionRow(row: CommandExecutionRow): CommandExecutionRecord {
  const principal = commandExecutionPrincipalSchema.safeParse(row.principal);
  const operationId = consequentialCommandOperationIdSchema.safeParse(
    row.operation_id,
  );
  const commandId = commandIdSchema.safeParse(row.command_id);
  const status = commandExecutionStatusSchema.safeParse(row.status);
  const createdAt = parseNullableIsoInstant(row.created_at, "created_at");
  const completedAt = parseNullableIsoInstant(row.completed_at, "completed_at");
  if (
    !principal.success ||
    !operationId.success ||
    !commandId.success ||
    !status.success ||
    !isCommandPayloadSha256(row.payload_sha256) ||
    createdAt === null
  ) {
    throw new CommandExecutionError(
      "COMMAND_STORE_FAILURE",
      "stored command record is invalid",
    );
  }
  const key = Object.freeze({
    principal: principal.data,
    operationId: operationId.data,
    commandId: commandId.data,
  });
  const base = {
    key,
    payloadSha256: row.payload_sha256,
    createdAt,
  } as const;

  switch (status.data) {
    case "in_progress":
      if (
        completedAt !== null ||
        row.result_json !== null ||
        row.failure_code !== null ||
        row.failure_message !== null ||
        row.failure_ref !== null
      ) {
        throw invalidStoredState();
      }
      return Object.freeze({
        ...base,
        status: "in_progress",
        completedAt: null,
        result: null,
        failure: null,
      });
    case "succeeded": {
      if (
        completedAt === null ||
        row.result_json === null ||
        row.failure_code !== null ||
        row.failure_message !== null ||
        row.failure_ref !== null
      ) {
        throw invalidStoredState();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.result_json) as unknown;
      } catch {
        throw invalidStoredState();
      }
      return Object.freeze({
        ...base,
        status: "succeeded",
        completedAt,
        result: createSafeCommandResult(parsed).value,
        failure: null,
      });
    }
    case "failed":
      if (
        completedAt === null ||
        row.result_json !== null ||
        row.failure_code === null ||
        row.failure_message === null
      ) {
        throw invalidStoredState();
      }
      return Object.freeze({
        ...base,
        status: "failed",
        completedAt,
        result: null,
        failure: createKnownCommandFailure({
          code: row.failure_code,
          message: row.failure_message,
          ...(row.failure_ref === null ? {} : { ref: row.failure_ref }),
        }),
      });
  }
}

function inCommandExecutionTransaction<T>(
  database: DatabaseSync,
  action: () => T,
): T {
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    throw mapCommandStoreError(error);
  }

  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original bounded failure; this connection must not auto-retry.
    }
    throw mapCommandStoreError(error);
  }
}

function mapCommandStoreError(error: unknown): CommandExecutionError {
  if (
    error instanceof CommandExecutionError &&
    (error.code === "COMMAND_STORE_BUSY" ||
      error.code === "COMMAND_STORE_FAILURE")
  ) {
    return error;
  }
  if (isSqliteBusyOrLocked(error)) {
    return new CommandExecutionError(
      "COMMAND_STORE_BUSY",
      "command store is busy; execution was not claimed or settled",
    );
  }
  return new CommandExecutionError(
    "COMMAND_STORE_FAILURE",
    "command store operation failed",
  );
}

function isSqliteBusyOrLocked(
  error: unknown,
): error is { readonly errcode: number } {
  if (
    typeof error !== "object" ||
    error === null ||
    !("errcode" in error) ||
    typeof error.errcode !== "number"
  ) {
    return false;
  }
  const primaryResultCode = error.errcode & 0xff;
  return primaryResultCode === 5 || primaryResultCode === 6;
}

function invalidStoredState(): CommandExecutionError {
  return new CommandExecutionError(
    "COMMAND_STORE_FAILURE",
    "stored command state is invalid",
  );
}

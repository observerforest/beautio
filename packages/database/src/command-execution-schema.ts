import {
  commandExecutionPrincipals,
  consequentialCommandOperationIds,
} from "@beautio/contracts";
import {
  maximumStoredCommandFailureCodeBytes,
  maximumStoredCommandFailureMessageBytes,
  maximumStoredCommandFailureRefBytes,
  maximumStoredCommandResultBytes,
} from "@beautio/application";
import type { DatabaseSync } from "node:sqlite";

/**
 * Creates the append-only CommandExecution state table without altering inventory.
 *
 * @param database - Open SQLite connection being migrated before request serving.
 * @returns Nothing after the repeat-safe table creation succeeds.
 */
export function createCommandExecutionTable(database: DatabaseSync): void {
  const principals = commandExecutionPrincipals.map(sqlLiteral).join(", ");
  const operations = consequentialCommandOperationIds
    .map(sqlLiteral)
    .join(", ");

  database.exec(`
    CREATE TABLE IF NOT EXISTS command_executions (
      principal TEXT NOT NULL CHECK (principal IN (${principals})),
      operation_id TEXT NOT NULL CHECK (operation_id IN (${operations})),
      command_id TEXT NOT NULL CHECK (
        length(command_id) = 36 AND
        command_id = lower(command_id) AND
        substr(command_id, 9, 1) = '-' AND
        substr(command_id, 14, 1) = '-' AND
        substr(command_id, 19, 1) = '-' AND
        substr(command_id, 24, 1) = '-' AND
        length(replace(command_id, '-', '')) = 32 AND
        replace(command_id, '-', '') NOT GLOB '*[^0-9a-f]*' AND
        substr(command_id, 15, 1) IN ('1', '2', '3', '4', '5', '6', '7', '8') AND
        substr(command_id, 20, 1) IN ('8', '9', 'a', 'b')
      ),
      payload_sha256 TEXT NOT NULL CHECK (
        length(payload_sha256) = 64 AND
        payload_sha256 = lower(payload_sha256) AND
        payload_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      status TEXT NOT NULL CHECK (
        status IN ('in_progress', 'succeeded', 'failed')
      ),
      result_json TEXT CHECK (
        result_json IS NULL OR (
          json_valid(result_json) = 1 AND
          json_type(result_json) = 'object' AND
          length(CAST(result_json AS BLOB)) <= ${maximumStoredCommandResultBytes}
        )
      ),
      failure_code TEXT CHECK (
        failure_code IS NULL OR (
          length(trim(failure_code)) > 0 AND
          length(CAST(failure_code AS BLOB)) <= ${maximumStoredCommandFailureCodeBytes}
        )
      ),
      failure_message TEXT CHECK (
        failure_message IS NULL OR (
          length(trim(failure_message)) > 0 AND
          length(CAST(failure_message AS BLOB)) <= ${maximumStoredCommandFailureMessageBytes}
        )
      ),
      failure_ref TEXT CHECK (
        failure_ref IS NULL OR (
          length(trim(failure_ref)) > 0 AND
          length(CAST(failure_ref AS BLOB)) <= ${maximumStoredCommandFailureRefBytes}
        )
      ),
      created_at TEXT NOT NULL CHECK (
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND
        created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
      ),
      completed_at TEXT CHECK (
        completed_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS NOT NULL AND
          completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at)
        )
      ),
      PRIMARY KEY (principal, operation_id, command_id),
      CHECK (
        (
          status = 'in_progress' AND
          result_json IS NULL AND
          failure_code IS NULL AND
          failure_message IS NULL AND
          failure_ref IS NULL AND
          completed_at IS NULL
        ) OR (
          status = 'succeeded' AND
          result_json IS NOT NULL AND
          failure_code IS NULL AND
          failure_message IS NULL AND
          failure_ref IS NULL AND
          completed_at IS NOT NULL
        ) OR (
          status = 'failed' AND
          result_json IS NULL AND
          failure_code IS NOT NULL AND
          failure_message IS NOT NULL AND
          completed_at IS NOT NULL
        )
      )
    ) STRICT;
  `);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

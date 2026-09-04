import type { IsoInstant } from "@beautio/domain";
import type {
  CommandExecutionKey,
  CommandExecutionRecord,
  CommandPayloadSha256,
  KnownCommandFailure,
  SafeCommandResult,
} from "./command-execution-types.ts";

export interface ClaimCommandExecutionPersistenceInput {
  readonly key: CommandExecutionKey;
  readonly payloadSha256: CommandPayloadSha256;
  readonly createdAt: IsoInstant;
}

export interface ClaimCommandExecutionPersistenceResult {
  readonly inserted: boolean;
  readonly record: CommandExecutionRecord;
}

export interface CompleteCommandExecutionSuccessPersistenceInput {
  readonly key: CommandExecutionKey;
  readonly payloadSha256: CommandPayloadSha256;
  readonly result: SafeCommandResult;
  readonly completedAt: IsoInstant;
}

export interface CompleteCommandExecutionFailurePersistenceInput {
  readonly key: CommandExecutionKey;
  readonly payloadSha256: CommandPayloadSha256;
  readonly failure: KnownCommandFailure;
  readonly completedAt: IsoInstant;
}

export interface CompleteCommandExecutionPersistenceResult {
  readonly updated: boolean;
  readonly record: CommandExecutionRecord | null;
}

export interface CommandExecutionRepository {
  /**
   * Atomically inserts an in-progress claim or reads the already persisted row.
   *
   * @param input - Complete authenticated key, canonical payload hash, and timestamp.
   * @returns Whether this caller inserted the claim and the authoritative row.
   */
  claimCommandExecution(
    input: ClaimCommandExecutionPersistenceInput,
  ): Promise<ClaimCommandExecutionPersistenceResult>;

  /**
   * Conditionally settles one in-progress command as succeeded.
   *
   * @param input - Original claim identity, bounded result, and completion timestamp.
   * @returns Whether the CAS updated and the authoritative row after the attempt.
   */
  completeCommandExecutionSuccess(
    input: CompleteCommandExecutionSuccessPersistenceInput,
  ): Promise<CompleteCommandExecutionPersistenceResult>;

  /**
   * Conditionally settles one proven zero-side-effect command as failed.
   *
   * @param input - Original claim identity, bounded safe failure, and completion timestamp.
   * @returns Whether the CAS updated and the authoritative row after the attempt.
   */
  completeCommandExecutionKnownFailure(
    input: CompleteCommandExecutionFailurePersistenceInput,
  ): Promise<CompleteCommandExecutionPersistenceResult>;

  /**
   * Reads one command by authenticated principal, operation, and command UUID.
   *
   * @param key - Complete three-part command identity.
   * @returns The authoritative record or null when absent.
   */
  findCommandExecution(
    key: CommandExecutionKey,
  ): Promise<CommandExecutionRecord | null>;
}

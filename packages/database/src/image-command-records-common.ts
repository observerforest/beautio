import { CommandExecutionError, createSafeCommandResult, type ClaimedCommandExecution, type CommandExecutionRecord, type SucceededCommandExecutionRecord } from "@beautio/application";
import { parseNullableIsoInstant, type ImageAsset } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { completeCommandExecutionSuccessInTransaction, findCommandExecutionRecord } from "./command-execution-records.ts";

/** @returns A fixed unknown-outcome storage error without SQL or stored values. */
export function imageCommandStoreFailure(): CommandExecutionError { return new CommandExecutionError("COMMAND_STORE_FAILURE", "image command transaction outcome is unknown"); }
/** @param database - Current transaction. @param claim - Owned command. @param operation - Expected operation. @returns Exact matching live command row. */
export function requireImageCommandOwner(database: DatabaseSync, claim: ClaimedCommandExecution, operation: "upload_product_images" | "set_product_display_image") {
  if (claim.key.principal !== "custom_gpt" || claim.key.operationId !== operation) throw imageCommandStoreFailure();
  const record = findCommandExecutionRecord(database, claim.key);
  if (record === null || record.status !== "in_progress" || record.payloadSha256 !== claim.payloadSha256 || record.result !== null || record.failure !== null) throw imageCommandStoreFailure();
  return record;
}
/** @param database - Caller transaction. @param original - Complete command snapshot before metadata-only changes. @returns Nothing only when metadata triggers left the command unchanged. */
export function verifyUnchangedImageCommand(database: DatabaseSync, original: CommandExecutionRecord): void {
  if (!isDeepStrictEqual(findCommandExecutionRecord(database, original.key), original)) throw imageCommandStoreFailure();
}
/** @param database - Caller transaction. @param claim - Owned command. @param original - Pre-mutation record. @param value - Strict minimal receipt. @param clock - Trusted synchronous completion clock. @returns Exact succeeded CAS readback. */
export function completeImageCommandInTransaction(database: DatabaseSync, claim: ClaimedCommandExecution, original: CommandExecutionRecord, value: unknown, clock: () => string): SucceededCommandExecutionRecord {
  const result = createSafeCommandResult(value);
  const completedAt = parseNullableIsoInstant(clock(), "completed_at");
  if (completedAt === null) throw imageCommandStoreFailure();
  const persisted = completeCommandExecutionSuccessInTransaction(database, { key: claim.key, payloadSha256: claim.payloadSha256, result, completedAt });
  const record = persisted.record;
  if (!persisted.updated || record === null || record.status !== "succeeded" || !isDeepStrictEqual(record.key, claim.key) ||
    record.payloadSha256 !== claim.payloadSha256 || record.createdAt !== original.createdAt || record.completedAt !== completedAt ||
    record.failure !== null || !isDeepStrictEqual(record.result, result.value)) throw imageCommandStoreFailure();
  return record;
}
/** @param asset - Expected domain metadata. @returns Every persisted scalar, including exact nulls. */
export function imageAssetStoredRow(asset: ImageAsset) {
  return { id: asset.id, storage_key: asset.storageKey, media_type: asset.mediaType, byte_size: asset.byteSize,
    status: asset.status, product_id: asset.productId, expires_at: asset.expiresAt, created_at: asset.createdAt };
}
/** @param database - Caller transaction. @param table - Fixed internal table. @param id - Exact row identity. @param expected - Complete raw row. @returns Nothing only for exact stored equality. */
export function verifyImageCommandRow(database: DatabaseSync, table: "products" | "image_assets", id: string, expected: object): void {
  const actual = database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (actual === undefined || !isDeepStrictEqual({ ...actual }, expected)) throw imageCommandStoreFailure();
}
/** @param database - Connection outside a transaction. @param action - Synchronous fixed operation. @returns Committed result; failures always remain unknown. */
export function imageCommandTransaction<T>(database: DatabaseSync, action: () => T): T {
  try { database.exec("BEGIN IMMEDIATE"); } catch { throw imageCommandStoreFailure(); }
  try { const result = action(); database.exec("COMMIT"); return result; }
  catch { try { database.exec("ROLLBACK"); } catch { throw imageCommandStoreFailure(); } throw imageCommandStoreFailure(); }
}

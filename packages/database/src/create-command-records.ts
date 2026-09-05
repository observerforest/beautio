import {
  CommandExecutionError, createCanonicalCommandPayload, createSafeCommandResult,
  type CreateCommandPersistenceInput, type CreateCommandPersistenceResult,
} from "@beautio/application";
import { canonicalUuidSchema, createCommandFailureCodeSchema, createCommandSuccessResultSchema, createInventoryBatchInputSchema } from "@beautio/contracts";
import { BeautioError, parseNullableIsoInstant } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { completeCommandExecutionSuccessInTransaction, findCommandExecutionRecord } from "./command-execution-records.ts";
import { prepareCreateCommandSnapshot, verifyCreateCommandSnapshot } from "./create-command-snapshot.ts";
import { readRevisionClock } from "./entity-revision-state.ts";
import { createInventoryBatchInTransaction } from "./inventory-batch-records.ts";
import { readInventoryItem, readProduct } from "./records.ts";

/**
 * Commits a confirmed batch and its minimal command success receipt atomically.
 * @param database - Connection outside a transaction; the first claim is already durable.
 * @param input - Owned command identity, normalized facts, UUIDs and trusted synchronous clock.
 * @returns A committed success row or a preflight-only rejection after verified rollback.
 */
export function executeCreateCommandRecord(database: DatabaseSync, input: CreateCommandPersistenceInput): CreateCommandPersistenceResult {
  try { database.exec("BEGIN IMMEDIATE"); } catch { throw storeFailure(); }
  let businessPreflight = false;
  try {
    const { claim } = input;
    if (claim.key.principal !== "custom_gpt" || claim.key.operationId !== "create_inventory_batch") throw storeFailure();
    const original = findCommandExecutionRecord(database, claim.key);
    if (original === null || original.status !== "in_progress" || original.payloadSha256 !== claim.payloadSha256) throw storeFailure();
    const parsedInput = createInventoryBatchInputSchema.parse(input.input);
    if (createCanonicalCommandPayload(parsedInput).sha256 !== claim.payloadSha256) throw storeFailure();
    readRevisionClock(database, true);
    if (parseNullableIsoInstant(input.now, "created_at") === null) throw storeFailure();
    if (input.productIds.length !== parsedInput.products.length || input.inventoryItemIds.length !== parsedInput.inventory_items.length) throw storeFailure();
    const ids = [...input.productIds, ...input.inventoryItemIds];
    if (new Set(ids).size !== ids.length) throw storeFailure();
    for (const id of ids) {
      canonicalUuidSchema.parse(id);
      if (readProduct(database, id) !== null || readInventoryItem(database, id) !== null) throw storeFailure();
    }
    businessPreflight = true;
    const expected = prepareCreateCommandSnapshot(database, input);
    businessPreflight = false;
    createInventoryBatchInTransaction(database, { products: expected.products, inventoryItems: expected.inventoryItems, now: input.now });
    const result = createSafeCommandResult(createCommandSuccessResultSchema.parse({ outcome: "created", inventory_item_ids: verifyCreateCommandSnapshot(database, expected) }));
    const completedAt = parseNullableIsoInstant(input.completionClock(), "completed_at");
    if (completedAt === null) throw storeFailure();
    const persisted = completeCommandExecutionSuccessInTransaction(database, {
      key: claim.key, payloadSha256: claim.payloadSha256, result, completedAt,
    });
    const record = persisted.record;
    if (!persisted.updated || record === null || record.status !== "succeeded" ||
      !isDeepStrictEqual(record.key, claim.key) || record.payloadSha256 !== claim.payloadSha256 ||
      record.createdAt !== original.createdAt || record.completedAt !== completedAt || record.failure !== null ||
      !isDeepStrictEqual(record.result, result.value)) throw storeFailure();
    createCommandSuccessResultSchema.parse(record.result);
    verifyCreateCommandSnapshot(database, expected);
    database.exec("COMMIT");
    return { outcome: "succeeded", record };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { throw storeFailure(); }
    if (businessPreflight && error instanceof BeautioError) {
      const code = createCommandFailureCodeSchema.safeParse(error.code);
      if (code.success) return { outcome: "known_failure", failureCode: code.data };
    }
    throw storeFailure();
  }
}

function storeFailure(): CommandExecutionError {
  return new CommandExecutionError("COMMAND_STORE_FAILURE", "create command transaction outcome is unknown");
}

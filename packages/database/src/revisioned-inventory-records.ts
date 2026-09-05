import {
  RevisionError,
  type CorrectInventoryItemFactsPersistenceInput,
  type ReviseProductProfilePersistenceInput,
  type VersionedInventoryItem,
  type VersionedProduct,
} from "@beautio/application";
import { BeautioError } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { readRevisionClock, revisionStoreFailure } from "./entity-revision-state.ts";
import { correctInventoryItemFactsInTransaction, readVersionedInventoryItem, reviseProductProfileInTransaction } from "./revisioned-inventory-transactions.ts";

/**
 * Reads bottle and shared Product revisions in one SQLite read snapshot.
 *
 * @param database - Open connection that is not already in a transaction.
 * @param inventoryItemId - Exact bottle identifier to read.
 * @returns A consistent snapshot, or null when the bottle does not exist.
 */
export function findVersionedInventoryItemRecord(
  database: DatabaseSync,
  inventoryItemId: string,
): VersionedInventoryItem | null {
  return inRevisionTransaction(database, "read", () => readVersionedInventoryItem(database, inventoryItemId));
}

/**
 * Compares and revises shared Product facts, including atomic PAO propagation.
 *
 * @param database - Open connection that is not already in a transaction.
 * @param input - Current expected revision and strictly limited profile patch.
 * @returns The committed Product snapshot; conflicts and failures leave no writes.
 */
export function reviseProductProfileRecord(
  database: DatabaseSync,
  input: ReviseProductProfilePersistenceInput,
): VersionedProduct {
  return inRevisionTransaction(database, "write", () => reviseProductProfileInTransaction(database, input));
}

/**
 * Compares and corrects bottle facts without altering lifecycle or association.
 *
 * @param database - Open connection that is not already in a transaction.
 * @param input - Expected bottle revision and strictly limited factual corrections.
 * @returns The committed bottle and Product snapshot from the same transaction.
 */
export function correctInventoryItemFactsRecord(
  database: DatabaseSync,
  input: CorrectInventoryItemFactsPersistenceInput,
): VersionedInventoryItem {
  return inRevisionTransaction(database, "write", () => correctInventoryItemFactsInTransaction(database, input));
}

function inRevisionTransaction<T>(
  database: DatabaseSync,
  mode: "read" | "write",
  action: () => T,
): T {
  try {
    database.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
  } catch {
    throw revisionStoreFailure();
  }
  try {
    readRevisionClock(database, mode === "write");
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      throw revisionStoreFailure();
    }
    if (error instanceof RevisionError || error instanceof BeautioError) {
      throw error;
    }
    throw revisionStoreFailure();
  }
}

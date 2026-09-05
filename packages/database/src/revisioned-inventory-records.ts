import {
  RevisionError,
  mergeInventoryFactsPatch,
  mergeProductProfilePatch,
  type CorrectInventoryItemFactsPersistenceInput,
  type ReviseProductProfilePersistenceInput,
  type VersionedInventoryItem,
  type VersionedProduct,
} from "@beautio/application";
import { BeautioError, parseEntityRevision, type EntityRevision } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { readEntityRevision, readRevisionClock, revisionStoreFailure } from "./entity-revision-state.ts";
import { cascadeProductPao, inheritProductPao } from "./product-pao-records.ts";
import { readInventoryItem, readProduct, updateInventoryRow } from "./records.ts";

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
  return inRevisionTransaction(database, "write", () => {
    const current = readVersionedProduct(database, input.productId);
    if (current === null) {
      throw new BeautioError("PRODUCT_NOT_FOUND", `Product ${input.productId} does not exist`);
    }
    assertExpectedRevision(current.revision, input.expectedRevision);
    const product = mergeProductProfilePatch(current.product, input.patch);
    database.prepare(`
      UPDATE products SET name = ?, alias = ?, brand = ?, category = ?, size_label = ?,
        pao_duration_months = ?, ingredient_list_text = ?, shared_notes = ?
      WHERE id = ?
    `).run(
      product.name, product.alias, product.brand, product.category, product.sizeLabel,
      product.paoDurationMonths, product.ingredientListText, product.sharedNotes, product.id,
    );
    if (input.patch.pao_duration_months !== undefined) {
      cascadeProductPao(database, product.id, product.paoDurationMonths);
    }
    const persisted = readVersionedProduct(database, product.id);
    if (persisted === null) {
      throw revisionStoreFailure();
    }
    return persisted;
  });
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
  return inRevisionTransaction(database, "write", () => {
    const current = readVersionedInventoryItem(database, input.inventoryItemId);
    if (current === null) {
      throw new BeautioError("INVENTORY_ITEM_NOT_FOUND", `inventory item ${input.inventoryItemId} does not exist`);
    }
    assertExpectedRevision(current.revision, input.expectedRevision);
    const merged = mergeInventoryFactsPatch(current.item, input.patch);
    const changedPao = input.patch.pao_duration_months !== undefined &&
      merged.paoDurationMonths !== current.item.paoDurationMonths;
    const item = current.product !== null && changedPao
      ? inheritProductPao(merged, current.product.product)
      : merged;
    updateInventoryRow(database, item);
    const persisted = readVersionedInventoryItem(database, item.id);
    if (persisted === null) {
      throw revisionStoreFailure();
    }
    return persisted;
  });
}

function readVersionedProduct(database: DatabaseSync, productId: string): VersionedProduct | null {
  const product = readProduct(database, productId);
  return product === null ? null : {
    product,
    revision: readEntityRevision(database, "product", product.id),
  };
}

function readVersionedInventoryItem(
  database: DatabaseSync,
  inventoryItemId: string,
): VersionedInventoryItem | null {
  const item = readInventoryItem(database, inventoryItemId);
  if (item === null) {
    return null;
  }
  const product = item.productId === null ? null : readVersionedProduct(database, item.productId);
  if (item.productId !== null && product === null) {
    throw revisionStoreFailure();
  }
  return { item, revision: readEntityRevision(database, "inventory_item", item.id), product };
}

function assertExpectedRevision(actual: EntityRevision, expected: EntityRevision): void {
  if (actual !== parseEntityRevision(expected)) {
    throw new RevisionError("REVISION_CONFLICT", "entity changed after the expected revision");
  }
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

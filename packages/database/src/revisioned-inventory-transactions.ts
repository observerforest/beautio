import {
  RevisionError, mergeInventoryFactsPatch, mergeProductProfilePatch,
  type CorrectInventoryItemFactsPersistenceInput, type ReviseProductProfilePersistenceInput,
  type VersionedInventoryItem, type VersionedProduct,
} from "@beautio/application";
import { BeautioError, parseEntityRevision, type EntityRevision } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { readEntityRevision, revisionStoreFailure } from "./entity-revision-state.ts";
import { cascadeProductPao, inheritProductPao } from "./product-pao-records.ts";
import { readInventoryItem, readProduct, updateInventoryRow } from "./records.ts";

/**
 * Revises shared profile facts inside an already-owned synchronous transaction.
 * @param database - Connection whose caller owns BEGIN, COMMIT and rollback.
 * @param input - Product target, expected revision and normalized partial profile.
 * @returns Readback with its revision; failures leave rollback to the transaction owner.
 */
export function reviseProductProfileInTransaction(database: DatabaseSync, input: ReviseProductProfilePersistenceInput): VersionedProduct {
  const current = readVersionedProduct(database, input.productId);
  if (current === null) throw new BeautioError("PRODUCT_NOT_FOUND", `Product ${input.productId} does not exist`);
  assertExpectedRevision(current.revision, input.expectedRevision);
  const product = mergeProductProfilePatch(current.product, input.patch);
  database.prepare(`
    UPDATE products SET name = ?, alias = ?, brand = ?, category = ?, size_label = ?,
      pao_duration_months = ?, ingredient_list_text = ?, shared_notes = ? WHERE id = ?
  `).run(product.name, product.alias, product.brand, product.category, product.sizeLabel,
    product.paoDurationMonths, product.ingredientListText, product.sharedNotes, product.id);
  if (input.patch.pao_duration_months !== undefined) cascadeProductPao(database, product.id, product.paoDurationMonths);
  const persisted = readVersionedProduct(database, product.id);
  if (persisted === null) throw revisionStoreFailure();
  return persisted;
}

/**
 * Corrects direct facts inside an already-owned synchronous transaction.
 * @param database - Connection whose caller owns transaction settlement.
 * @param input - Bottle target, expected revision and normalized factual patch.
 * @returns The same-transaction bottle and Product versions after domain validation.
 */
export function correctInventoryItemFactsInTransaction(database: DatabaseSync, input: CorrectInventoryItemFactsPersistenceInput): VersionedInventoryItem {
  const current = readVersionedInventoryItem(database, input.inventoryItemId);
  if (current === null) throw new BeautioError("INVENTORY_ITEM_NOT_FOUND", `inventory item ${input.inventoryItemId} does not exist`);
  assertExpectedRevision(current.revision, input.expectedRevision);
  const merged = mergeInventoryFactsPatch(current.item, input.patch);
  const changedPao = input.patch.pao_duration_months !== undefined && merged.paoDurationMonths !== current.item.paoDurationMonths;
  const item = current.product !== null && changedPao ? inheritProductPao(merged, current.product.product) : merged;
  updateInventoryRow(database, item);
  const persisted = readVersionedInventoryItem(database, item.id);
  if (persisted === null) throw revisionStoreFailure();
  return persisted;
}

/**
 * Reads a Product and its revision inside the caller's snapshot.
 * @param database - Connection participating in the caller's read or write transaction.
 * @param productId - Exact existing Product target.
 * @returns Versioned Product, or null when absent.
 */
export function readVersionedProduct(database: DatabaseSync, productId: string): VersionedProduct | null {
  const product = readProduct(database, productId);
  return product === null ? null : { product, revision: readEntityRevision(database, "product", product.id) };
}

/**
 * Reads bottle and Product versions inside one caller-owned snapshot.
 * @param database - Connection participating in the caller's transaction.
 * @param inventoryItemId - Exact inventory target.
 * @returns Coherent versioned facts, or null when the bottle is absent.
 */
export function readVersionedInventoryItem(database: DatabaseSync, inventoryItemId: string): VersionedInventoryItem | null {
  const item = readInventoryItem(database, inventoryItemId);
  if (item === null) return null;
  const product = item.productId === null ? null : readVersionedProduct(database, item.productId);
  if (item.productId !== null && product === null) throw revisionStoreFailure();
  return { item, revision: readEntityRevision(database, "inventory_item", item.id), product };
}

function assertExpectedRevision(actual: EntityRevision, expected: EntityRevision): void {
  if (actual !== parseEntityRevision(expected)) throw new RevisionError("REVISION_CONFLICT", "entity changed after the expected revision");
}

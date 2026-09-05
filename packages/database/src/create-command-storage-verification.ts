import type { InventoryItem, Product } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { CreateCommandSnapshot } from "./create-command-snapshot.ts";
import { revisionStoreFailure } from "./entity-revision-state.ts";

/**
 * Compares persisted scalar values before any mapper can normalize or derive them.
 * @param database - Connection in the caller's uncommitted create transaction.
 * @param expected - Complete expected facts, including exact nulls and normalized text.
 * @returns Nothing only when all relevant SQL columns match their intended stored values.
 */
export function verifyCreateCommandStoredFacts(database: DatabaseSync, expected: CreateCommandSnapshot): void {
  for (const product of expected.products) verifyRow(database, "products", product.id, productRow(product));
  // Existing Products are not rewritten by create; retain their exact stored
  // legacy representation rather than requiring a new normalization migration.
  for (const { product, storedRow } of expected.existingProducts) verifyRow(database, "products", product.id, storedRow);
  for (const item of expected.inventoryItems) verifyRow(database, "inventory_items", item.id, inventoryRow(item));
  for (const image of expected.images) {
    verifyRow(database, "image_assets", image.id, {
      id: image.id, storage_key: image.storageKey, media_type: image.mediaType, byte_size: image.byteSize,
      status: image.status, product_id: image.productId, expires_at: image.expiresAt, created_at: image.createdAt,
    });
  }
}

function productRow(product: Product) {
  return {
    id: product.id, name: product.name, alias: product.alias, brand: product.brand, category: product.category,
    size_label: product.sizeLabel, pao_duration_months: product.paoDurationMonths,
    image_asset_id: product.imageAssetId, image_ref: product.imageRef,
    ingredient_list_text: product.ingredientListText, shared_notes: product.sharedNotes,
  };
}

function inventoryRow(item: InventoryItem) {
  return {
    id: item.id, product_id: item.productId, created_at: item.createdAt,
    lifecycle_status: item.lifecycleStatus, opened_on: item.openedOn, opened_on_accuracy: item.openedOnAccuracy,
    expires_on: item.expiresOn, pao_duration_months: item.paoDurationMonths, pao_deadline: item.paoDeadline,
    usable_until: item.usableUntil, remaining_percent_estimate: item.remainingPercentEstimate, custom_notes: item.customNotes,
  };
}

function verifyRow(database: DatabaseSync, table: "products" | "inventory_items" | "image_assets", id: string, expected: Readonly<Record<string, unknown>>): void {
  const actual = database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (actual === undefined || !isDeepStrictEqual({ ...actual }, expected)) throw revisionStoreFailure();
}

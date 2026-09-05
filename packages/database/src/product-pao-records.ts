import {
  BeautioError,
  updateInventoryItemPao,
  type InventoryItem,
  type Product,
} from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { readInventoryItem, updateInventoryRow } from "./records.ts";

/**
 * Inherits shared Product PAO or rejects a conflicting explicit bottle duration.
 *
 * @param item - Validated bottle whose PAO is being created or explicitly changed.
 * @param product - Current associated Product read in the same write transaction.
 * @returns The bottle with derived deadlines; unknown shared PAO preserves its value.
 */
export function inheritProductPao(item: InventoryItem, product: Product): InventoryItem {
  if (product.paoDurationMonths === null) {
    return item;
  }
  if (item.paoDurationMonths !== null && item.paoDurationMonths !== product.paoDurationMonths) {
    throw new BeautioError(
      "INVALID_INPUT",
      "bottle pao_duration_months conflicts with the shared Product PAO",
    );
  }
  return updateInventoryItemPao(item, product.paoDurationMonths);
}

/**
 * Applies an explicit shared PAO edit to every associated bottle atomically.
 *
 * @param database - Connection inside the caller's write transaction.
 * @param productId - Product whose current associated bottles must be recalculated.
 * @param duration - New shared duration, including null for clearing PAO.
 * @returns Nothing after all bottle snapshots have been updated; failures propagate.
 */
export function cascadeProductPao(
  database: DatabaseSync,
  productId: string,
  duration: number | null,
): void {
  const bottles = database.prepare(
    "SELECT id FROM inventory_items WHERE product_id = ? ORDER BY id",
  ).all(productId);
  for (const bottle of bottles) {
    if (typeof bottle.id !== "string") {
      throw new BeautioError("INTERNAL_ERROR", "associated inventory item could not be read");
    }
    const item = readInventoryItem(database, bottle.id);
    if (item === null) {
      throw new BeautioError("INTERNAL_ERROR", "associated inventory item could not be read");
    }
    updateInventoryRow(database, updateInventoryItemPao(item, duration));
  }
}

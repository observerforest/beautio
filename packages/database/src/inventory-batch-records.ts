import type { InventoryBatchPersistenceInput } from "@beautio/application";
import { BeautioError, createInventoryItem } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { assertImageCanBeLinked, claimImageForProduct } from "./image-association-records.ts";
import { inheritProductPao } from "./product-pao-records.ts";
import { insertInventoryItem, insertProduct, readProduct } from "./records.ts";

/**
 * Runs the shared legacy batch write body inside its caller's transaction.
 * @param database - Connection in an existing synchronous write transaction.
 * @param input - Domain entities and creation instant; Product PAO is re-read before each bottle.
 * @returns Nothing after Product, image metadata and bottle inserts; does not commit.
 */
export function createInventoryBatchInTransaction(database: DatabaseSync, input: InventoryBatchPersistenceInput): void {
  for (const product of input.products) {
    if (product.imageAssetId !== null) assertImageCanBeLinked(database, product.imageAssetId, input.now);
    insertProduct(database, product);
    if (product.imageAssetId !== null) claimImageForProduct(database, product.imageAssetId, product.id, input.now);
  }
  for (const item of input.inventoryItems) {
    const product = item.productId === null ? null : readProduct(database, item.productId);
    if (product === null) throw new BeautioError("PRODUCT_NOT_FOUND", `Product ${item.productId ?? ""} does not exist`);
    insertInventoryItem(database, createInventoryItem({ ...inheritProductPao(item, product), createdAt: input.now }));
  }
}

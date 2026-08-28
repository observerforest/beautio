import {
  BeautioError,
  type InventoryItem,
  type Product,
} from "@beautio/domain";
import type { InventoryRepository } from "./ports.ts";

export async function loadProducts(
  repository: InventoryRepository,
  items: readonly InventoryItem[],
): Promise<ReadonlyMap<string, Product | null>> {
  const productIds = [
    ...new Set(
      items.flatMap((item) =>
        item.productId === null ? [] : [item.productId],
      ),
    ),
  ];
  const entries = await Promise.all(
    productIds.map(async (productId) =>
      [productId, await repository.findProductById(productId)] as const,
    ),
  );
  return new Map(entries);
}

export async function requireInventoryItem(
  repository: InventoryRepository,
  inventoryItemId: string,
): Promise<InventoryItem> {
  const item = await repository.findById(inventoryItemId);
  if (item === null) {
    throw new BeautioError(
      "INVENTORY_ITEM_NOT_FOUND",
      `inventory item ${inventoryItemId} does not exist`,
    );
  }
  return item;
}

export async function requireProduct(
  repository: InventoryRepository,
  productId: string,
): Promise<Product> {
  const product = await repository.findProductById(productId);
  if (product === null) {
    throw new BeautioError(
      "INTERNAL_ERROR",
      "committed Product could not be re-read",
    );
  }
  return product;
}

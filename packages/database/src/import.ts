import {
  BeautioError,
  type InventoryItem,
  type Product,
} from "@beautio/domain";
import { assertInventoryMatches, assertProductMatches } from "./errors.ts";

export interface InventoryImportData {
  readonly products: readonly Product[];
  readonly inventoryItems: readonly InventoryItem[];
}

export interface InventoryImportResult {
  readonly productsInserted: number;
  readonly productsExisting: number;
  readonly inventoryItemsInserted: number;
  readonly inventoryItemsExisting: number;
}

export interface InventoryImportOperations {
  readonly readProduct: (productId: string) => Product | null;
  readonly readInventoryItem: (inventoryItemId: string) => InventoryItem | null;
  readonly insertProduct: (product: Product) => void;
  readonly insertInventoryItem: (item: InventoryItem) => void;
  readonly inImmediateTransaction: <T>(action: () => T) => T;
}

export function seedInventoryItem(
  item: InventoryItem,
  insertInventoryItem: (item: InventoryItem) => void,
): void {
  insertInventoryItem(item);
}

export function importInventoryData(
  data: InventoryImportData,
  operations: InventoryImportOperations,
): InventoryImportResult {
  const result = {
    productsInserted: 0,
    productsExisting: 0,
    inventoryItemsInserted: 0,
    inventoryItemsExisting: 0,
  };

  return operations.inImmediateTransaction(() => {
    for (const product of data.products) {
      if (product.imageAssetId !== null) {
        throw new BeautioError(
          "INVALID_INPUT",
          "local import cannot create managed image associations",
        );
      }
      const existing = operations.readProduct(product.id);
      if (existing === null) {
        operations.insertProduct(product);
        result.productsInserted += 1;
      } else {
        assertProductMatches(existing, product);
        result.productsExisting += 1;
      }
    }

    for (const item of data.inventoryItems) {
      const existing = operations.readInventoryItem(item.id);
      if (existing === null) {
        operations.insertInventoryItem(item);
        result.inventoryItemsInserted += 1;
      } else {
        assertInventoryMatches(existing, item);
        result.inventoryItemsExisting += 1;
      }
    }

    return result;
  });
}

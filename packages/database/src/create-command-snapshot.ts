import { prepareInventoryBatchItems, prepareInventoryBatchProducts, type CreateCommandPersistenceInput } from "@beautio/application";
import { BeautioError, createInventoryItem, type ImageAsset, type InventoryItem, type Product } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { readEntityRevision, readRevisionClock, revisionStoreFailure } from "./entity-revision-state.ts";
import { assertImageCanBeLinked } from "./image-association-records.ts";
import { inheritProductPao } from "./product-pao-records.ts";
import { readImageAsset, readInventoryItem, readProduct } from "./records.ts";
import { verifyCreateCommandStoredFacts } from "./create-command-storage-verification.ts";

export interface CreateCommandSnapshot {
  readonly products: readonly Product[];
  readonly inventoryItems: readonly InventoryItem[];
  readonly existingProducts: readonly { readonly product: Product; readonly revision: number; readonly storedRow: Readonly<Record<string, unknown>> }[];
  readonly images: readonly ImageAsset[];
}

/**
 * Resolves domain facts and existing image availability before any business write.
 * @param database - Connection inside the create command's transaction.
 * @param input - Owned and identity-validated request with server-generated IDs.
 * @returns Complete expected facts; only explicit preflight business errors may be classified after rollback.
 */
export function prepareCreateCommandSnapshot(database: DatabaseSync, input: CreateCommandPersistenceInput): CreateCommandSnapshot {
  let productIndex = 0;
  let itemIndex = 0;
  const products = prepareInventoryBatchProducts(input.input, () => requireId(input.productIds, productIndex++));
  const currentProducts = new Map(products.map((product) => [product.id, product]));
  const existingProducts: { product: Product; revision: number; storedRow: Readonly<Record<string, unknown>> }[] = [];
  const existingIds = new Set<string>();
  // An explicit existing reference must resolve in storage, even if a newly
  // generated identity happens to equal that otherwise missing target.
  for (const item of input.input.inventory_items) {
    if (item.product_ref.kind === "existing" && !existingIds.has(item.product_ref.product_id)) {
      const product = readProduct(database, item.product_ref.product_id);
      if (product === null) throw new BeautioError("PRODUCT_NOT_FOUND", "A referenced Product does not exist.");
      existingIds.add(product.id);
      currentProducts.set(product.id, product);
      const storedRow = database.prepare("SELECT * FROM products WHERE id = ?").get(product.id);
      if (storedRow === undefined) throw revisionStoreFailure();
      existingProducts.push({ product, revision: readEntityRevision(database, "product", product.id), storedRow: { ...storedRow } });
    }
  }
  const rawItems = prepareInventoryBatchItems(input.input, products, () => requireId(input.inventoryItemIds, itemIndex++), input.now);
  const inventoryItems = rawItems.map((item) => {
    const product = item.productId === null ? undefined : currentProducts.get(item.productId);
    if (product === undefined) throw revisionStoreFailure();
    return createInventoryItem({ ...inheritProductPao(item, product), createdAt: input.now });
  });
  const seenImages = new Set<string>();
  const images: ImageAsset[] = [];
  for (const product of products) {
    if (product.imageAssetId === null) continue;
    if (seenImages.has(product.imageAssetId)) throw new BeautioError("BATCH_CONFLICT", "An image is referenced more than once.");
    seenImages.add(product.imageAssetId);
    assertImageCanBeLinked(database, product.imageAssetId, input.now);
    const asset = readImageAsset(database, product.imageAssetId);
    if (asset === null) throw revisionStoreFailure();
    images.push({ ...asset, status: "linked", productId: product.id });
  }
  return { products, inventoryItems, existingProducts, images };
}

/**
 * Verifies every created fact and association, including after command CAS triggers.
 * @param database - Connection before the atomic business-and-receipt COMMIT.
 * @param expected - Pre-write domain facts and image metadata snapshot.
 * @returns Actual bottle IDs in confirmed input order, only after all facts and revisions match.
 */
export function verifyCreateCommandSnapshot(database: DatabaseSync, expected: CreateCommandSnapshot): string[] {
  readRevisionClock(database, false);
  verifyCreateCommandStoredFacts(database, expected);
  for (const product of expected.products) {
    if (!isDeepStrictEqual(readProduct(database, product.id), product)) throw revisionStoreFailure();
    readEntityRevision(database, "product", product.id);
  }
  for (const { product, revision } of expected.existingProducts) {
    if (!isDeepStrictEqual(readProduct(database, product.id), product) || readEntityRevision(database, "product", product.id) !== revision) throw revisionStoreFailure();
  }
  for (const image of expected.images) {
    if (!isDeepStrictEqual(readImageAsset(database, image.id), image)) throw revisionStoreFailure();
  }
  return expected.inventoryItems.map((item) => {
    const actual = readInventoryItem(database, item.id);
    if (actual === null || !isDeepStrictEqual(actual, item)) throw revisionStoreFailure();
    readEntityRevision(database, "inventory_item", actual.id);
    return actual.id;
  });
}

function requireId(ids: readonly string[], index: number): string {
  const id = ids[index];
  if (id === undefined) throw revisionStoreFailure();
  return id;
}

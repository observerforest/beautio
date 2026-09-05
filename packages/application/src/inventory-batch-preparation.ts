import type { CreateInventoryBatchInput } from "@beautio/contracts";
import { BeautioError, createInventoryItemFromFacts, createProduct, type Product } from "@beautio/domain";
import { ensureUniqueRefs } from "./input-parsing.ts";

/**
 * Checks batch-local references without generating identities or reading persistence.
 * @param input - Strictly parsed legacy or command batch input.
 * @returns Nothing when each reference resolves and every new Product has a bottle.
 */
export function validateInventoryBatchReferences(input: CreateInventoryBatchInput): void {
  ensureUniqueRefs(input.products.map((product) => product.batch_ref), "product");
  ensureUniqueRefs(input.inventory_items.map((item) => item.batch_ref), "inventory item");
  const referenced = new Set(input.inventory_items.flatMap((item) => item.product_ref.kind === "new" ? [item.product_ref.batch_ref] : []));
  const products = new Set(input.products.map((product) => product.batch_ref));
  for (const ref of products) if (!referenced.has(ref)) {
    throw new BeautioError("INVALID_INPUT", `new Product ${ref} is not referenced by inventory`);
  }
  for (const ref of referenced) if (!products.has(ref)) {
    throw new BeautioError("INVALID_INPUT", `inventory references missing Product ${ref}`);
  }
}

/**
 * Constructs new Products with the existing shared-PAO inference semantics.
 * @param input - Validated batch with complete local references.
 * @param generateId - Caller-owned identity generator, called once per new Product.
 * @returns Products in input order; explicit null PAO never triggers legacy inference.
 */
export function prepareInventoryBatchProducts(input: CreateInventoryBatchInput, generateId: () => string): Product[] {
  return input.products.map((product) => createProduct({
    id: generateId(), name: product.name, alias: product.alias ?? null, brand: product.brand ?? null,
    category: product.category ?? null, sizeLabel: product.size_label ?? null,
    paoDurationMonths: product.pao_duration_months === undefined
      ? inferLegacyProductPao(input.inventory_items.flatMap((item) => item.product_ref.kind === "new" && item.product_ref.batch_ref === product.batch_ref ? [item.pao_duration_months ?? null] : []))
      : product.pao_duration_months,
    imageAssetId: product.image_asset_id ?? null, imageRef: null,
    ingredientListText: product.ingredient_list_text ?? null, sharedNotes: product.shared_notes ?? null,
  }));
}

/**
 * Constructs bottle facts before repository-time Product PAO inheritance.
 * @param input - Validated batch, retaining input order and existing Product targets.
 * @param products - New Products in the corresponding Product input order.
 * @param generateId - Caller-owned identity generator, called once per bottle.
 * @param now - Validated creation instant shared by the batch.
 * @returns Domain-validated bottles; the repository must still resolve current Product PAO.
 */
export function prepareInventoryBatchItems(input: CreateInventoryBatchInput, products: readonly Product[], generateId: () => string, now: string) {
  const ids = new Map(input.products.map((product, index) => [product.batch_ref, products[index]?.id]));
  return input.inventory_items.map((item) => {
    const productId = item.product_ref.kind === "existing" ? item.product_ref.product_id : ids.get(item.product_ref.batch_ref);
    if (productId === undefined) throw new BeautioError("INVALID_INPUT", "inventory references a missing batch Product");
    return createInventoryItemFromFacts({ id: generateId(), productId, createdAt: now }, {
      lifecycleStatus: item.lifecycle_status, openedOn: item.opened_on ?? null,
      openedOnAccuracy: item.opened_on_accuracy ?? null, expiresOn: item.expires_on ?? null,
      paoDurationMonths: item.pao_duration_months ?? null, customNotes: item.custom_notes ?? null,
    });
  });
}

function inferLegacyProductPao(durations: readonly (number | null)[]): number | null {
  const known = new Set(durations.filter((duration) => duration !== null));
  return known.size === 1 ? (known.values().next().value ?? null) : null;
}

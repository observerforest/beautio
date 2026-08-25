import type {
  InventoryListItemOutput,
  InventoryReadModelOutput,
  InventorySearchItemOutput,
  InventoryStateOutput,
} from "@beautio/contracts";
import {
  BeautioError,
  deriveInventorySnapshot,
  parseIsoDate,
  type InventoryItem,
  type InventorySnapshot,
  type Product,
} from "@beautio/domain";

export function toInventoryReadModelOutput(
  item: InventoryItem,
  product: Product | null,
  asOf: ReturnType<typeof parseIsoDate> | null,
): InventoryReadModelOutput {
  const derivedSnapshot =
    asOf === null ? null : deriveInventorySnapshot(item, asOf);

  return {
    inventory_item_id: item.id,
    product_id: product === null ? null : item.productId,
    product: product === null ? null : toReadInventoryProductOutput(product),
    lifecycle_status: item.lifecycleStatus,
    opened_on: item.openedOn,
    opened_on_accuracy: item.openedOnAccuracy,
    expires_on: item.expiresOn,
    pao_duration_months: item.paoDurationMonths,
    pao_deadline: item.paoDeadline,
    pao_deadline_accuracy:
      item.paoDeadline === null ? null : item.openedOnAccuracy,
    usable_until: item.usableUntil,
    custom_notes: item.customNotes,
    derived_status:
      asOf === null || derivedSnapshot === null
        ? null
        : {
            as_of: asOf,
            usability_status: derivedSnapshot.usabilityStatus,
            warnings: [...derivedSnapshot.warnings],
          },
  };
}

function toReadInventoryProductOutput(
  product: Product,
): NonNullable<InventoryReadModelOutput["product"]> {
  return {
    product_id: product.id,
    name: product.name,
    category: product.category,
    size_label: product.sizeLabel,
    ingredient_list_text: product.ingredientListText,
    shared_notes: product.sharedNotes,
    has_image: product.imageAssetId !== null,
  };
}

export function toInventorySearchItemOutput(
  item: InventoryItem,
  product: Product | null,
  asOf: ReturnType<typeof parseIsoDate> | null,
): InventorySearchItemOutput {
  const complete = toInventoryReadModelOutput(item, product, asOf);
  return {
    inventory_item_id: complete.inventory_item_id,
    product_id: complete.product_id,
    product_name: product?.name ?? null,
    category: product?.category ?? null,
    size_label: product?.sizeLabel ?? null,
    lifecycle_status: complete.lifecycle_status,
    opened_on: complete.opened_on,
    expires_on: complete.expires_on,
    usable_until: complete.usable_until,
    has_image: product !== null && product.imageAssetId !== null,
    derived_status: complete.derived_status,
  };
}

export function inventoryMatchesQuery(
  item: InventoryItem,
  product: Product | null,
  normalizedQuery: string | null,
): boolean {
  if (normalizedQuery === null) {
    return true;
  }

  const fields: readonly (string | null)[] = [
    item.id,
    product === null ? null : item.productId,
    product?.name ?? null,
    product?.category ?? null,
    product?.sizeLabel ?? null,
    product?.ingredientListText ?? null,
    product?.sharedNotes ?? null,
    item.customNotes,
  ];

  return fields.some(
    (value) => value?.toLowerCase().includes(normalizedQuery) === true,
  );
}

export function toInventoryStateOutput(
  snapshot: InventorySnapshot,
): InventoryStateOutput {
  return {
    inventory_item_id: snapshot.inventoryItemId,
    lifecycle_status: snapshot.lifecycleStatus,
    opened_on: snapshot.openedOn,
    opened_on_accuracy: snapshot.openedOnAccuracy,
    expires_on: snapshot.expiresOn,
    pao_duration_months: snapshot.paoDurationMonths,
    pao_deadline: snapshot.paoDeadline,
    pao_deadline_accuracy: snapshot.paoDeadlineAccuracy,
    usable_until: snapshot.usableUntil,
    usability_status: snapshot.usabilityStatus,
    warnings: [...snapshot.warnings],
    custom_notes: snapshot.customNotes,
  };
}

export function toProductOutput(product: Product): {
  readonly product_id: string;
  readonly name: string;
  readonly category: string | null;
  readonly size_label: string | null;
  readonly image_asset_id: string | null;
  readonly image_ref: string | null;
  readonly ingredient_list_text: string | null;
  readonly shared_notes: string | null;
} {
  return {
    product_id: product.id,
    name: product.name,
    category: product.category,
    size_label: product.sizeLabel,
    image_asset_id: product.imageAssetId,
    image_ref: product.imageRef,
    ingredient_list_text: product.ingredientListText,
    shared_notes: product.sharedNotes,
  };
}

export function toInventoryListItemOutput(
  item: InventoryItem,
  asOf: ReturnType<typeof parseIsoDate>,
  product: Product | null,
  productInventoryPosition: number | null,
  productInventoryCount: number | null,
): InventoryListItemOutput {
  return {
    ...toInventoryStateOutput(deriveInventorySnapshot(item, asOf)),
    product_id: item.productId,
    product: product === null ? null : toProductOutput(product),
    product_inventory_position: productInventoryPosition,
    product_inventory_count: productInventoryCount,
  };
}

export function countInventoryByProduct(
  items: readonly InventoryItem[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.productId !== null) {
      counts.set(item.productId, (counts.get(item.productId) ?? 0) + 1);
    }
  }
  return counts;
}

export function requireProductId(item: InventoryItem): string {
  if (item.productId === null) {
    throw new BeautioError(
      "BATCH_CONFLICT",
      `inventory item ${item.id} has no Product`,
    );
  }
  return item.productId;
}

export function asActiveLifecycle(
  item: InventoryItem,
): "unopened" | "opened" {
  if (
    item.lifecycleStatus !== "unopened" &&
    item.lifecycleStatus !== "opened"
  ) {
    throw new BeautioError(
      "INTERNAL_ERROR",
      "active inventory write produced a terminal lifecycle",
    );
  }
  return item.lifecycleStatus;
}

export function assertValidClock(value: Date): void {
  if (Number.isNaN(value.getTime())) {
    throw new BeautioError("INTERNAL_ERROR", "clock returned an invalid date");
  }
}

export function requireArrayItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new BeautioError("INTERNAL_ERROR", "result ordering failed");
  }
  return item;
}

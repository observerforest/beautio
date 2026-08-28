import {
  createInventoryItem,
  createProduct,
  type ImageAsset,
  type ImageAssetStatus,
  type ImageMediaType,
  type InventoryItem,
  type LifecycleStatus,
  type OpenedOnAccuracy,
  type Product,
} from "@beautio/domain";

export interface InventoryRow {
  readonly id: string;
  readonly product_id: string | null;
  readonly created_at: string | null;
  readonly lifecycle_status: LifecycleStatus;
  readonly opened_on: string | null;
  readonly opened_on_accuracy: OpenedOnAccuracy | null;
  readonly expires_on: string | null;
  readonly pao_duration_months: number | null;
  readonly pao_deadline: string | null;
  readonly usable_until: string | null;
  readonly custom_notes: string | null;
}

export interface ProductRow {
  readonly id: string;
  readonly name: string;
  readonly alias: string | null;
  readonly brand: string | null;
  readonly category: string | null;
  readonly size_label: string | null;
  readonly image_asset_id: string | null;
  readonly image_ref: string | null;
  readonly ingredient_list_text: string | null;
  readonly shared_notes: string | null;
}

export interface ImageAssetRow {
  readonly id: string;
  readonly storage_key: string;
  readonly media_type: ImageMediaType;
  readonly byte_size: number;
  readonly status: ImageAssetStatus;
  readonly product_id: string | null;
  readonly expires_at: string;
  readonly created_at: string;
}

export function mapInventoryRow(row: InventoryRow): InventoryItem {
  return createInventoryItem({
    id: row.id,
    productId: row.product_id,
    createdAt: row.created_at,
    lifecycleStatus: row.lifecycle_status,
    openedOn: row.opened_on,
    openedOnAccuracy: row.opened_on_accuracy,
    expiresOn: row.expires_on,
    paoDurationMonths: row.pao_duration_months,
    paoDeadline: row.pao_deadline,
    usableUntil: row.usable_until,
    customNotes: row.custom_notes,
  });
}

export function mapProductRow(row: ProductRow): Product {
  return createProduct({
    id: row.id,
    name: row.name,
    alias: row.alias,
    brand: row.brand,
    category: row.category,
    sizeLabel: row.size_label,
    imageAssetId: row.image_asset_id,
    imageRef: row.image_ref,
    ingredientListText: row.ingredient_list_text,
    sharedNotes: row.shared_notes,
  });
}

export function mapImageAssetRow(row: ImageAssetRow): ImageAsset {
  return {
    id: row.id,
    storageKey: row.storage_key,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    status: row.status,
    productId: row.product_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

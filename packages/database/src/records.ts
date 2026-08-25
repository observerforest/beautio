import {
  BeautioError,
  type ImageAsset,
  type InventoryItem,
  type Product,
} from "@beautio/domain";
import { DatabaseSync } from "node:sqlite";
import { mapSqliteConflict } from "./errors.ts";
import {
  mapImageAssetRow,
  mapInventoryRow,
  mapProductRow,
  type ImageAssetRow,
  type InventoryRow,
  type ProductRow,
} from "./row-mappers.ts";

export function readInventoryItem(
  database: DatabaseSync,
  inventoryItemId: string,
): InventoryItem | null {
  const row = database
    .prepare(
      `SELECT
        id,
        product_id,
        lifecycle_status,
        opened_on,
        opened_on_accuracy,
        expires_on,
        pao_duration_months,
        pao_deadline,
        usable_until,
        custom_notes
      FROM inventory_items
      WHERE id = ?`,
    )
    .get(inventoryItemId) as InventoryRow | undefined;
  return row === undefined ? null : mapInventoryRow(row);
}

export function readProduct(
  database: DatabaseSync,
  productId: string,
): Product | null {
  const row = database
    .prepare(
      `SELECT
        id,
        name,
        category,
        size_label,
        image_asset_id,
        image_ref,
        ingredient_list_text,
        shared_notes
      FROM products
      WHERE id = ?`,
    )
    .get(productId) as ProductRow | undefined;
  return row === undefined ? null : mapProductRow(row);
}

export function readImageAsset(
  database: DatabaseSync,
  imageAssetId: string,
): ImageAsset | null {
  const row = database
    .prepare(
      `SELECT
        id,
        storage_key,
        media_type,
        byte_size,
        status,
        product_id,
        expires_at,
        created_at
      FROM image_assets
      WHERE id = ?`,
    )
    .get(imageAssetId) as ImageAssetRow | undefined;
  return row === undefined ? null : mapImageAssetRow(row);
}

export function insertProduct(database: DatabaseSync, product: Product): void {
  try {
    database
      .prepare(
        `INSERT INTO products (
          id,
          name,
          category,
          size_label,
          image_asset_id,
          image_ref,
          ingredient_list_text,
          shared_notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        product.id,
        product.name,
        product.category,
        product.sizeLabel,
        product.imageAssetId,
        product.imageRef,
        product.ingredientListText,
        product.sharedNotes,
      );
  } catch (error) {
    throw mapSqliteConflict(error, `Product ${product.id} conflicts`);
  }
}

export function insertInventoryItem(
  database: DatabaseSync,
  item: InventoryItem,
): void {
  try {
    database
      .prepare(
        `INSERT INTO inventory_items (
          id,
          product_id,
          lifecycle_status,
          opened_on,
          opened_on_accuracy,
          expires_on,
          pao_duration_months,
          pao_deadline,
          usable_until,
          custom_notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.productId,
        item.lifecycleStatus,
        item.openedOn,
        item.openedOnAccuracy,
        item.expiresOn,
        item.paoDurationMonths,
        item.paoDeadline,
        item.usableUntil,
        item.customNotes,
      );
  } catch (error) {
    throw mapSqliteConflict(error, `inventory item ${item.id} conflicts`);
  }
}

export function updateInventoryRow(
  database: DatabaseSync,
  item: InventoryItem,
): void {
  const result = database
    .prepare(
      `UPDATE inventory_items SET
        lifecycle_status = ?,
        opened_on = ?,
        opened_on_accuracy = ?,
        expires_on = ?,
        pao_duration_months = ?,
        pao_deadline = ?,
        usable_until = ?
      WHERE id = ?`,
    )
    .run(
      item.lifecycleStatus,
      item.openedOn,
      item.openedOnAccuracy,
      item.expiresOn,
      item.paoDurationMonths,
      item.paoDeadline,
      item.usableUntil,
      item.id,
    );

  if (result.changes !== 1) {
    throw new BeautioError(
      "INVENTORY_ITEM_NOT_FOUND",
      `inventory item ${item.id} does not exist`,
    );
  }
}

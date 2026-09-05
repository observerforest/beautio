import { BeautioError } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { readImageAsset } from "./records.ts";

/**
 * Checks existing temporary-image availability without changing metadata.
 * @param database - Connection held by the caller's transaction.
 * @param imageAssetId - Existing managed image identity, never a filesystem path.
 * @param now - Validated instant used for the existing expiry rule.
 * @returns Nothing if the unowned temporary image may be linked.
 */
export function assertImageCanBeLinked(database: DatabaseSync, imageAssetId: string, now: string): void {
  const asset = readImageAsset(database, imageAssetId);
  if (asset === null) throw new BeautioError("IMAGE_ASSET_NOT_FOUND", `image asset ${imageAssetId} does not exist`);
  if (asset.status === "temporary" && asset.expiresAt <= now) throw new BeautioError("IMAGE_ASSET_EXPIRED", `image asset ${imageAssetId} is expired`);
  if (asset.status !== "temporary" || asset.productId !== null) throw new BeautioError("BATCH_CONFLICT", `image asset ${imageAssetId} is not available`);
}

/**
 * Conditionally links one existing temporary image to a Product, without file I/O.
 * @param database - Connection held by the caller's transaction.
 * @param imageAssetId - Existing image whose ownership is being claimed.
 * @param productId - Product receiving the association.
 * @param now - Validated instant for the conditional expiry check.
 * @returns Nothing after exactly one association succeeds; rejection propagates.
 */
export function claimImageForProduct(database: DatabaseSync, imageAssetId: string, productId: string, now: string): void {
  const result = database.prepare(`UPDATE image_assets SET status = 'linked', product_id = ?
    WHERE id = ? AND status = 'temporary' AND product_id IS NULL AND expires_at > ?`).run(productId, imageAssetId, now);
  if (result.changes !== 1) {
    assertImageCanBeLinked(database, imageAssetId, now);
    throw new BeautioError("BATCH_CONFLICT", `image asset ${imageAssetId} could not be associated`);
  }
}

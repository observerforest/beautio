import type { FinalizeImageUploadPersistenceInput, ImageUploadPersistenceInput } from "@beautio/application";
import { canonicalUuidSchema, uploadImagesCommandSuccessResultSchema } from "@beautio/contracts";
import { imageMediaTypes, parseNullableIsoInstant, type ImageAsset } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { completeImageCommandInTransaction, imageAssetStoredRow, imageCommandStoreFailure, imageCommandTransaction, requireImageCommandOwner, verifyImageCommandRow, verifyUnchangedImageCommand } from "./image-command-records-common.ts";

/** @param database - Connection outside transactions. @param input - Owned generated batch. @returns Completion after staging every exact row atomically. */
export function stageImageUploadCommandRecord(database: DatabaseSync, input: ImageUploadPersistenceInput): void {
  imageCommandTransaction(database, () => {
    const original = requireImageCommandOwner(database, input.claim, "upload_product_images");
    validateAssets(input.assets);
    for (const asset of input.assets) {
      database.prepare(`INSERT INTO image_assets (id, storage_key, media_type, byte_size, status, product_id, expires_at, created_at)
        VALUES (?, ?, ?, ?, 'staging', NULL, ?, ?)`).run(asset.id, asset.storageKey, asset.mediaType, asset.byteSize, asset.expiresAt, asset.createdAt);
    }
    for (const asset of input.assets) verifyImageCommandRow(database, "image_assets", asset.id, imageAssetStoredRow(asset));
    verifyUnchangedImageCommand(database, original);
  });
}

/** @param database - Connection outside transactions. @param input - Verified files' staging metadata and owned claim. @returns Atomically published assets and complete durable ID receipt. */
export function finalizeImageUploadCommandRecord(database: DatabaseSync, input: FinalizeImageUploadPersistenceInput) {
  return imageCommandTransaction(database, () => {
    const original = requireImageCommandOwner(database, input.claim, "upload_product_images");
    validateAssets(input.assets);
    const completedAt = parseNullableIsoInstant(input.completionClock(), "completed_at");
    if (completedAt === null) throw imageCommandStoreFailure();
    for (const asset of input.assets) {
      verifyImageCommandRow(database, "image_assets", asset.id, imageAssetStoredRow(asset));
      if (asset.expiresAt <= completedAt) throw imageCommandStoreFailure();
      const result = database.prepare(`UPDATE image_assets SET status = 'temporary'
        WHERE id = ? AND status = 'staging' AND product_id IS NULL AND expires_at > ?`).run(asset.id, completedAt);
      if (result.changes !== 1) throw imageCommandStoreFailure();
    }
    const verify = () => { for (const asset of input.assets) verifyImageCommandRow(database, "image_assets", asset.id, imageAssetStoredRow({ ...asset, status: "temporary" })); };
    verify();
    const value = uploadImagesCommandSuccessResultSchema.parse({ outcome: "uploaded", image_asset_ids: input.assets.map((asset) => asset.id), expires_at: input.assets[0]!.expiresAt });
    const record = completeImageCommandInTransaction(database, input.claim, original, value, () => completedAt);
    verify();
    return record;
  });
}

/** @param database - Connection outside transactions. @param input - Pre-finalization owned batch. @returns Completion after only matching inaccessible metadata is marked for cleanup. */
export function abandonImageUploadCommandRecord(database: DatabaseSync, input: ImageUploadPersistenceInput): void {
  imageCommandTransaction(database, () => {
    const original = requireImageCommandOwner(database, input.claim, "upload_product_images");
    validateAssets(input.assets);
    for (const asset of input.assets) {
      const row = database.prepare("SELECT * FROM image_assets WHERE id = ?").get(asset.id);
      if (row === undefined) continue;
      if (row.status !== "staging" && row.status !== "pending_cleanup") throw imageCommandStoreFailure();
      verifyImageCommandRow(database, "image_assets", asset.id, imageAssetStoredRow({ ...asset, status: row.status }));
      database.prepare("UPDATE image_assets SET status = 'pending_cleanup' WHERE id = ? AND status IN ('staging', 'pending_cleanup') AND product_id IS NULL").run(asset.id);
      verifyImageCommandRow(database, "image_assets", asset.id, imageAssetStoredRow({ ...asset, status: "pending_cleanup" }));
    }
    verifyUnchangedImageCommand(database, original);
  });
}

function validateAssets(assets: readonly ImageAsset[]): void {
  if (assets.length < 1 || assets.length > 10) throw imageCommandStoreFailure();
  const identifiers = new Set<string>();
  let total = 0;
  for (const asset of assets) {
    for (const id of [asset.id, asset.storageKey]) {
      canonicalUuidSchema.parse(id);
      if (identifiers.has(id)) throw imageCommandStoreFailure();
      identifiers.add(id);
    }
    total += asset.byteSize;
    if (asset.status !== "staging" || asset.productId !== null || !imageMediaTypes.includes(asset.mediaType) ||
      !Number.isSafeInteger(asset.byteSize) || asset.byteSize < 1 || asset.byteSize > 20 * 1024 * 1024 || total > 50 * 1024 * 1024 ||
      parseNullableIsoInstant(asset.createdAt, "created_at") === null || parseNullableIsoInstant(asset.expiresAt, "expires_at") === null ||
      asset.createdAt !== assets[0]!.createdAt || asset.expiresAt !== assets[0]!.expiresAt ||
      Date.parse(asset.expiresAt) - Date.parse(asset.createdAt) !== 86_400_000) throw imageCommandStoreFailure();
  }
}

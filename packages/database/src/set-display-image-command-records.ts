import { RevisionError, createCanonicalCommandPayload, type SetDisplayImageCommandPersistenceInput, type SetDisplayImageCommandPersistenceResult } from "@beautio/application";
import { customGptSetDisplayImageCommandInputSchema, setDisplayImageCommandSuccessResultSchema, type ImageCommandFailureCode } from "@beautio/contracts";
import { BeautioError, parseNullableIsoInstant } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { assertImageCanBeLinked, replaceProductImageAssociation } from "./image-association-records.ts";
import { completeImageCommandInTransaction, imageAssetStoredRow, imageCommandStoreFailure, requireImageCommandOwner, verifyImageCommandRow } from "./image-command-records-common.ts";
import { readEntityRevision, readRevisionClock } from "./entity-revision-state.ts";
import { readImageAsset, readProduct } from "./records.ts";

const preflightCodes: readonly ImageCommandFailureCode[] = ["PRODUCT_NOT_FOUND", "REVISION_CONFLICT", "IMAGE_ASSET_NOT_FOUND", "IMAGE_ASSET_EXPIRED", "BATCH_CONFLICT"];

/** @param database - Connection outside a transaction. @param input - Owned expected-version image replacement. @returns Atomic raw-verified mutation and receipt, or rollback-proven preflight rejection. */
export function executeSetDisplayImageCommandRecord(database: DatabaseSync, input: SetDisplayImageCommandPersistenceInput): SetDisplayImageCommandPersistenceResult {
  try { database.exec("BEGIN IMMEDIATE"); } catch { throw imageCommandStoreFailure(); }
  let preflight = false;
  try {
    const original = requireImageCommandOwner(database, input.claim, "set_product_display_image");
    const parsed = customGptSetDisplayImageCommandInputSchema.parse({ command_id: input.claim.key.commandId, ...input.input });
    if (createCanonicalCommandPayload({ product_id: input.productId, expected_revision: parsed.expected_revision, image_asset_id: parsed.image_asset_id }).sha256 !== input.claim.payloadSha256 ||
      parseNullableIsoInstant(input.now, "now") === null || parseNullableIsoInstant(input.unlinkedExpiresAt, "unlinkedExpiresAt") === null ||
      Date.parse(input.unlinkedExpiresAt) - Date.parse(input.now) !== 86_400_000) throw imageCommandStoreFailure();
    readRevisionClock(database, false);
    preflight = true;
    const existing = readProduct(database, input.productId);
    if (existing === null) throw new BeautioError("PRODUCT_NOT_FOUND", "Product is unavailable");
    const beforeRevision = readEntityRevision(database, "product", existing.id);
    if (beforeRevision !== parsed.expected_revision) throw new RevisionError("REVISION_CONFLICT", "Product revision changed");
    const oldImage = existing.imageAssetId === null ? null : readImageAsset(database, existing.imageAssetId);
    if (existing.imageAssetId !== null && (oldImage === null || oldImage.status !== "linked" || oldImage.productId !== existing.id)) throw new BeautioError("BATCH_CONFLICT", "current image ownership is inconsistent");
    const changed = existing.imageAssetId !== parsed.image_asset_id;
    if (changed) assertImageCanBeLinked(database, parsed.image_asset_id, input.now);
    const selected = readImageAsset(database, parsed.image_asset_id);
    if (selected === null) throw new BeautioError("IMAGE_ASSET_NOT_FOUND", "selected image is unavailable");
    if (!changed && (selected.status !== "linked" || selected.productId !== existing.id)) throw new BeautioError("BATCH_CONFLICT", "selected image ownership is inconsistent");
    preflight = false;
    if (changed) readRevisionClock(database, true);
    const rawProduct = database.prepare("SELECT * FROM products WHERE id = ?").get(existing.id);
    if (rawProduct === undefined) throw imageCommandStoreFailure();
    replaceProductImageAssociation(database, existing, parsed.image_asset_id, input.now, input.unlinkedExpiresAt);
    if (database.prepare("UPDATE products SET image_asset_id = ? WHERE id = ?").run(parsed.image_asset_id, existing.id).changes !== 1) throw imageCommandStoreFailure();
    const verify = () => {
      verifyImageCommandRow(database, "products", existing.id, { ...rawProduct, image_asset_id: parsed.image_asset_id });
      verifyImageCommandRow(database, "image_assets", selected.id, imageAssetStoredRow({ ...selected, status: "linked", productId: existing.id }));
      if (changed && oldImage !== null) verifyImageCommandRow(database, "image_assets", oldImage.id, imageAssetStoredRow({ ...oldImage, status: "temporary", productId: null, expiresAt: input.unlinkedExpiresAt }));
      const revision = readEntityRevision(database, "product", existing.id);
      if (changed ? revision <= beforeRevision : revision !== beforeRevision) throw imageCommandStoreFailure();
      return revision;
    };
    const revision = verify();
    const receipt = setDisplayImageCommandSuccessResultSchema.parse({ outcome: "updated", product_id: existing.id, revision });
    const record = completeImageCommandInTransaction(database, input.claim, original, receipt, input.completionClock);
    if (verify() !== revision) throw imageCommandStoreFailure();
    database.exec("COMMIT");
    return { outcome: "succeeded", record };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { throw imageCommandStoreFailure(); }
    if (preflight && (error instanceof BeautioError || error instanceof RevisionError)) {
      const code = preflightCodes.find((value) => value === error.code);
      if (code !== undefined) return { outcome: "known_failure", failureCode: code };
    }
    throw imageCommandStoreFailure();
  }
}

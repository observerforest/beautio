import { canonicalUuidSchema, uploadImagesCommandSuccessResultSchema } from "@beautio/contracts";
import type { ImageAsset, IsoInstant } from "@beautio/domain";
import { isDeepStrictEqual } from "node:util";
import { createSafeCommandResult } from "./canonical-json.ts";
import type { ClaimedCommandExecution } from "./command-execution-service.ts";
import type { ImageCommandRepository, ImageCommandStorage, ReservedImageObject } from "./image-command-port.ts";
import type { ConsumedProductImageUpload } from "./prepared-product-image-upload.ts";
import { imageCommandRecordView, unknownImageCommandOutcome } from "./image-command-output.ts";

export interface ImageUploadWriterOptions {
  readonly repository: ImageCommandRepository;
  readonly storage: ImageCommandStorage;
  readonly claim: ClaimedCommandExecution;
  readonly consumed: ConsumedProductImageUpload;
  readonly now: IsoInstant;
  readonly expiresAt: IsoInstant;
  readonly generateId: () => string;
  readonly completionClock: () => IsoInstant;
}

/**
 * Writes one owned image batch and atomically publishes its durable complete receipt.
 * @param options - Consumed semantic snapshots, owned claim, bounded storage and trusted clocks.
 * @returns Verified success view; any persistence/compensation uncertainty remains unknown.
 */
export async function persistImageUploadCommand(options: ImageUploadWriterOptions) {
  const { repository, storage, claim, consumed } = options;
  const generated = new Set<string>();
  const next = () => {
    const value = canonicalUuidSchema.parse(options.generateId());
    if (generated.has(value)) throw unknownImageCommandOutcome();
    generated.add(value);
    return value;
  };
  const reservations: ReservedImageObject[] = [];
  let assets: readonly ImageAsset[] = [];
  let stageStarted = false;
  let finalizationStarted = false;
  try {
    assets = consumed.entries.map((entry): ImageAsset => ({
      id: next(), storageKey: next(), mediaType: entry.mediaType, byteSize: entry.bytes.byteLength,
      status: "staging", productId: null, createdAt: options.now, expiresAt: options.expiresAt,
    }));
    const expectedResult = uploadImagesCommandSuccessResultSchema.parse({ outcome: "uploaded", image_asset_ids: assets.map((asset) => asset.id), expires_at: options.expiresAt });
    createSafeCommandResult(expectedResult);
    for (const asset of assets) reservations.push(await storage.reserve(asset.storageKey));
    stageStarted = true;
    await repository.stageImageUploadCommand({ claim, assets });
    for (const [index, reservation] of reservations.entries()) {
      await storage.writeReserved(reservation, consumed.entries[index]!.bytes);
    }
    for (const [index, reservation] of reservations.entries()) {
      await storage.verifyReserved(reservation, consumed.entries[index]!.bytes);
    }
    finalizationStarted = true;
    const record = await repository.finalizeImageUploadCommand({ claim, assets, completionClock: options.completionClock });
    if (!isDeepStrictEqual(record.result, expectedResult)) throw unknownImageCommandOutcome();
    return imageCommandRecordView(record, claim);
  } catch {
    if (!finalizationStarted) {
      if (stageStarted) await repository.abandonImageUploadCommand({ claim, assets });
      for (const [index, reservation] of reservations.entries()) {
        await storage.discardReserved(reservation);
        if (stageStarted) await repository.deleteClaimedImageAsset(assets[index]!.id);
      }
    }
    throw unknownImageCommandOutcome();
  } finally {
    // Release all capabilities even if one close fails, without deleting published bytes.
    const releases = await Promise.allSettled(reservations.map((reservation) => storage.releaseReserved(reservation)));
    consumed.release();
    if (releases.some((result) => result.status === "rejected")) throw unknownImageCommandOutcome();
  }
}

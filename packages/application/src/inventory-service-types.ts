import type { BeautioBackup } from "@beautio/contracts";
import type {
  GeneratedIdKind,
  ImageAssetStorage,
  ImageInspector,
  ImageRenditionProvider,
} from "./ports.ts";

export interface ImageUploadInput {
  readonly source_ref: string;
  readonly bytes: Uint8Array;
}

export interface ImageUploadOperationOptions {
  readonly signal?: AbortSignal;
}

export interface BackupOperationOptions {
  readonly signal?: AbortSignal;
}

/**
 * Carries one fully schema-validated backup from the HTTP upload phase into the
 * serialized restore phase without parsing the untrusted payload again.
 */
export interface PreparedBackupRestore {
  readonly backup: BeautioBackup;
}

export type BackupChunkWriter = (chunk: string) => Promise<void>;

export interface BackupExportPlan {
  readonly createdAt: string;
  readonly products: number;
  readonly inventoryItems: number;
  readonly images: number;

  /**
   * Writes one valid versioned JSON backup one metadata record or image at a time.
   *
   * @param write - Backpressure-aware destination for serialized JSON chunks.
   * @param options - Optional cancellation checked between every serialized record.
   * @returns Nothing after the closing JSON delimiter has been accepted.
   */
  readonly writeTo: (
    write: BackupChunkWriter,
    options?: BackupOperationOptions,
  ) => Promise<void>;
}

export interface InventoryApplicationServiceOptions {
  readonly idGenerator?: (kind: GeneratedIdKind) => string;
  readonly clock?: () => Date;
  readonly imageStorage?: ImageAssetStorage;
  readonly imageInspector?: ImageInspector;
  readonly imageRenditions?: ImageRenditionProvider;
}

export type ImageAssetReadVariant = "original" | "card";

export interface ReadImageAssetOutput {
  readonly image_asset_id: string;
  readonly media_type: "image/jpeg" | "image/png" | "image/webp";
  readonly byte_size: number;
  readonly bytes: Uint8Array;
}

export interface CleanupImageAssetsOutput {
  readonly claimed: number;
  readonly deleted: number;
  readonly failed: number;
}

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

import type {
  ImageAsset,
  ImageMediaType,
  InventoryItem,
  Product,
} from "@beautio/domain";

export type GeneratedIdKind =
  | "product"
  | "inventory_item"
  | "image_asset"
  | "storage_key";

export interface InventoryBatchPersistenceInput {
  readonly products: readonly Product[];
  readonly inventoryItems: readonly InventoryItem[];
  readonly now: string;
}

export interface InventoryBackupSnapshot {
  readonly products: readonly Product[];
  readonly inventoryItems: readonly InventoryItem[];
  readonly imageAssets: readonly ImageAsset[];
}

export interface InventoryBackupReplacement {
  readonly products: readonly Product[];
  readonly inventoryItems: readonly InventoryItem[];
  readonly imageAssets: readonly InventoryBackupReplacementImage[];
}

export interface InventoryBackupReplacementImage {
  readonly stagingImageAssetId: string;
  readonly imageAsset: ImageAsset;
}

export interface ProductFactsPersistenceInput {
  readonly productId: string;
  readonly name: string;
  readonly alias?: string | null;
  readonly brand?: string | null;
  readonly category: string | null;
  readonly sizeLabel: string | null;
  readonly imageAssetId: string | null;
  readonly ingredientListText: string | null;
  readonly sharedNotes: string | null;
  readonly now: string;
  readonly unlinkedExpiresAt: string;
}

export interface InventoryItemCustomNotesPersistenceInput {
  readonly inventoryItemId: string;
  readonly customNotes: string | null;
}

export interface ProductImagePersistenceInput {
  readonly productId: string;
  readonly imageAssetId: string;
  readonly now: string;
  readonly unlinkedExpiresAt: string;
}

export interface ImageInspection {
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly animated: boolean;
}

export interface ImageAssetStorage {
  /**
   * Stores bytes under an opaque server-generated key.
   *
   * @param storageKey - Internal opaque key, never an external path.
   * @param bytes - Complete validated upload bytes.
   * @param signal - Optional cancellation that storage must settle before rejecting.
   * @returns Nothing after durable storage succeeds.
   */
  put(
    storageKey: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void>;

  /**
   * Reads all bytes for one internal storage key.
   *
   * @param storageKey - Internal key loaded from trusted metadata.
   * @returns A copy or immutable view of the stored bytes.
   */
  get(storageKey: string, signal?: AbortSignal): Promise<Uint8Array>;

  /**
   * Deletes one key idempotently, including when its file is already absent.
   *
   * @param storageKey - Internal key loaded from trusted metadata.
   * @returns Nothing after the key is absent.
   */
  delete(storageKey: string): Promise<void>;
}

export interface ImageInspector {
  /**
   * Decodes image metadata from untrusted bytes.
   *
   * @param bytes - Complete candidate image bytes.
   * @returns Actual media type, decoded dimensions, and animation state.
   */
  inspect(bytes: Uint8Array): Promise<ImageInspection>;
}

export interface ImageRendition {
  readonly mediaType: ImageMediaType;
  readonly bytes: Uint8Array;
}

export interface ImageRenditionProvider {
  /**
   * Reads or creates the non-authoritative card rendition for one original image.
   *
   * @param storageKey - Internal opaque key of the original managed image.
   * @param loadOriginal - Lazy reader invoked only when no positive or negative cache exists.
   * @returns A private card rendition, or null when conservative processing declines.
   */
  readOrCreateCard(
    storageKey: string,
    loadOriginal: () => Promise<Uint8Array>,
  ): Promise<ImageRendition | null>;

  /**
   * Deletes every cached rendition derived from one original image.
   *
   * @param storageKey - Internal opaque key of the original managed image.
   * @returns Nothing after all known rendition files are absent.
   */
  deleteForAsset(storageKey: string): Promise<void>;
}

export interface InventoryRepository {
  /**
   * Finds one inventory item without creating missing data.
   *
   * @param inventoryItemId - Stable inventory item identifier.
   * @returns The stored item, or null when it does not exist.
   */
  findById(inventoryItemId: string): Promise<InventoryItem | null>;

  /**
   * Lists every persisted inventory item in stable repository-defined order.
   *
   * @returns All stored inventory items without creating or mutating data.
   */
  findAll(): Promise<readonly InventoryItem[]>;

  /**
   * Finds shared product information without creating a missing product.
   *
   * @param productId - Stable product identifier referenced by inventory.
   * @returns The shared product, or null when the reference cannot be resolved.
   */
  findProductById(productId: string): Promise<Product | null>;

  /**
   * Persists a complete inventory item state.
   *
   * @param item - Valid domain state to store atomically.
   * @returns A promise resolved after persistence succeeds.
   */
  save(item: InventoryItem): Promise<void>;

  /**
   * Atomically inserts all batch entities and claims any referenced images.
   *
   * @param input - Server-generated entities and an explicit timestamp for image expiry checks.
   * @returns Nothing after the complete transaction commits.
   */
  createBatch(input: InventoryBatchPersistenceInput): Promise<void>;

  /**
   * Atomically replaces Product facts and transfers image associations.
   *
   * @param input - Complete Product facts plus deterministic lifecycle timestamps.
   * @returns The Product re-read after commit.
   */
  updateProductFacts(input: ProductFactsPersistenceInput): Promise<Product>;

  /**
   * Atomically replaces only a Product's shared managed display image.
   *
   * @param input - Existing Product, temporary image, and deterministic lifecycle timestamps.
   * @returns The Product re-read after the image association commits.
   */
  setProductDisplayImage(input: ProductImagePersistenceInput): Promise<Product>;

  /**
   * Persists recalculated direct and derived inventory facts.
   *
   * @param item - Complete validated inventory state for an existing row.
   * @returns The item re-read after persistence.
   */
  updateInventoryItemFacts(item: InventoryItem): Promise<InventoryItem>;

  /**
   * Replaces only one bottle's optional custom notes for any lifecycle state.
   *
   * @param input - Existing inventory identifier and normalized notes value.
   * @returns The inventory item re-read after persistence.
   */
  updateInventoryItemCustomNotes(
    input: InventoryItemCustomNotesPersistenceInput,
  ): Promise<InventoryItem>;

  /**
   * Stages inaccessible metadata before any corresponding file write.
   *
   * @param assets - New staging assets created by the application service.
   * @returns Nothing after all metadata rows are inserted atomically.
   */
  stageImageAssets(assets: readonly ImageAsset[]): Promise<void>;

  /**
   * Makes a complete staged upload visible as temporary assets atomically.
   *
   * @param imageAssetIds - Every asset in the upload call.
   * @returns Nothing after all rows transition from staging to temporary.
   */
  activateStagedImageAssets(imageAssetIds: readonly string[]): Promise<void>;

  /**
   * Makes failed upload assets inaccessible and eligible for retry cleanup.
   *
   * @param imageAssetIds - Assets belonging to the failed upload call.
   * @returns Nothing after every existing unlinked row is pending cleanup.
   */
  markImageAssetsForCleanup(imageAssetIds: readonly string[]): Promise<void>;

  /**
   * Finds image metadata without exposing its internal key externally.
   *
   * @param imageAssetId - Stable opaque asset identifier.
   * @returns Stored metadata, or null when absent.
   */
  findImageAssetById(imageAssetId: string): Promise<ImageAsset | null>;

  /**
   * Atomically claims expired temporary assets and returns pending retry work.
   *
   * @param now - Explicit RFC 3339 timestamp used for the expiry boundary.
   * @returns Assets that are inaccessible and may have their files deleted.
   */
  claimExpiredImageAssets(now: string): Promise<readonly ImageAsset[]>;

  /**
   * Deletes metadata only after its pending-cleanup file is absent.
   *
   * @param imageAssetId - Claimed image asset identifier.
   * @returns Nothing after the pending metadata row is absent.
   */
  deleteClaimedImageAsset(imageAssetId: string): Promise<void>;
}

export interface BackupInventoryRepository extends InventoryRepository {
  /**
   * Lists every Product and linked image metadata needed for a complete backup.
   *
   * @returns A consistent logical snapshot without image bytes.
   */
  readBackupSnapshot(): Promise<InventoryBackupSnapshot>;

  /**
   * Atomically replaces the complete single-user logical dataset.
   *
   * Existing image rows become pending cleanup work in the same transaction;
   * staged replacement rows are promoted to their backup identifiers.
   *
   * @param replacement - Fully validated entities whose managed image files already exist under staged metadata.
   * @returns Displaced assets under their new pending-cleanup identifiers.
   */
  replaceFromBackup(
    replacement: InventoryBackupReplacement,
  ): Promise<readonly ImageAsset[]>;
}

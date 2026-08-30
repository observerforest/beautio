import type {
  BackupInventoryRepository,
  InventoryBatchPersistenceInput,
  InventoryBackupReplacement,
  InventoryBackupSnapshot,
  InventoryItemCustomNotesPersistenceInput,
  ProductFactsPersistenceInput,
  ProductImagePersistenceInput,
} from "@beautio/application";
import {
  BeautioError,
  createInventoryItem,
  type ImageAsset,
  type InventoryItem,
  type Product,
} from "@beautio/domain";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mapSqliteConflict } from "./errors.ts";
import {
  importInventoryData as importInventoryDataWithOperations,
  type InventoryImportData,
  type InventoryImportResult,
} from "./import.ts";
import {
  mapImageAssetRow,
  mapInventoryRow,
  mapProductRow,
  type ImageAssetRow,
  type InventoryRow,
  type ProductRow,
} from "./row-mappers.ts";
import {
  insertInventoryItem as insertInventoryItemRecord,
  insertProduct as insertProductRecord,
  readImageAsset as readImageAssetRecord,
  readInventoryItem as readInventoryItemRecord,
  readProduct as readProductRecord,
  updateInventoryRow as updateInventoryRecord,
} from "./records.ts";
import { applySchema } from "./schema.ts";

export type { InventoryImportData, InventoryImportResult } from "./import.ts";

export class SqliteInventoryRepository implements BackupInventoryRepository {
  readonly #database: DatabaseSync;

  /**
   * Opens a local SQLite repository and applies additive or preserving migrations.
   *
   * @param databasePath - File path used for durable storage; tests may use a temporary file.
   */
  constructor(databasePath: string) {
    if (databasePath.trim().length === 0) {
      throw new BeautioError("INVALID_INPUT", "database path is required");
    }

    this.#database = new DatabaseSync(databasePath);
    applySchema(this.#database);
  }

  /** @inheritdoc */
  async findById(inventoryItemId: string): Promise<InventoryItem | null> {
    return this.readInventoryItem(inventoryItemId);
  }

  /** @inheritdoc */
  async findAll(): Promise<readonly InventoryItem[]> {
    const rows = this.#database
      .prepare(
        `SELECT
          id,
          product_id,
          created_at,
          lifecycle_status,
          opened_on,
          opened_on_accuracy,
          expires_on,
          pao_duration_months,
          pao_deadline,
          usable_until,
          custom_notes
        FROM inventory_items
        ORDER BY id ASC`,
      )
      .all() as unknown as readonly InventoryRow[];

    return rows.map(mapInventoryRow);
  }

  /** @inheritdoc */
  async readBackupSnapshot(): Promise<InventoryBackupSnapshot> {
    return this.inImmediateTransaction(() => {
      const products = this.#database
        .prepare(
          `SELECT
            id,
            name,
            alias,
            brand,
            category,
            size_label,
            image_asset_id,
            image_ref,
            ingredient_list_text,
            shared_notes
          FROM products
          ORDER BY id ASC`,
        )
        .all() as unknown as readonly ProductRow[];
      const inventoryItems = this.#database
        .prepare(
          `SELECT
            id,
            product_id,
            created_at,
            lifecycle_status,
            opened_on,
            opened_on_accuracy,
            expires_on,
            pao_duration_months,
            pao_deadline,
            usable_until,
            custom_notes
          FROM inventory_items
          ORDER BY id ASC`,
        )
        .all() as unknown as readonly InventoryRow[];
      const imageAssets = this.#database
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
          WHERE status = 'linked' AND product_id IS NOT NULL
          ORDER BY id ASC`,
        )
        .all() as unknown as readonly ImageAssetRow[];

      return {
        products: products.map(mapProductRow),
        inventoryItems: inventoryItems.map(mapInventoryRow),
        imageAssets: imageAssets.map(mapImageAssetRow),
      };
    });
  }

  /** @inheritdoc */
  async replaceFromBackup(
    replacement: InventoryBackupReplacement,
  ): Promise<readonly ImageAsset[]> {
    return this.inImmediateTransaction(() => {
      const stagingIds = new Set(
        replacement.imageAssets.map((entry) => entry.stagingImageAssetId),
      );
      const existingAssets = this.readAllImageAssets();
      for (const entry of replacement.imageAssets) {
        const staged = existingAssets.find(
          (asset) => asset.id === entry.stagingImageAssetId,
        );
        if (
          staged === undefined ||
          staged.status !== "staging" ||
          staged.productId !== null ||
          staged.storageKey !== entry.imageAsset.storageKey ||
          staged.mediaType !== entry.imageAsset.mediaType ||
          staged.byteSize !== entry.imageAsset.byteSize
        ) {
          throw new BeautioError(
            "BATCH_CONFLICT",
            "backup staging image metadata is inconsistent",
          );
        }
      }
      const displacedAssets = existingAssets.filter(
        (asset) => !stagingIds.has(asset.id),
      );
      const occupiedIds = new Set(existingAssets.map((asset) => asset.id));

      this.#database.exec(`
        DELETE FROM inventory_items;
        UPDATE products SET image_asset_id = NULL;
      `);

      const cleanupAssets: ImageAsset[] = [];
      for (const asset of displacedAssets) {
        let cleanupId: string;
        do {
          cleanupId = `restore-cleanup-${randomUUID()}`;
        } while (occupiedIds.has(cleanupId));
        occupiedIds.add(cleanupId);
        const renamed = this.#database
          .prepare(
            `UPDATE image_assets
            SET id = ?, status = 'pending_cleanup', product_id = NULL
            WHERE id = ?`,
          )
          .run(cleanupId, asset.id);
        if (renamed.changes !== 1) {
          throw new BeautioError(
            "BATCH_CONFLICT",
            `displaced image asset ${asset.id} could not be retained for cleanup`,
          );
        }
        cleanupAssets.push({
          ...asset,
          id: cleanupId,
          status: "pending_cleanup",
          productId: null,
        });
      }

      this.#database.exec("DELETE FROM products");

      for (const entry of replacement.imageAssets) {
        const asset = entry.imageAsset;
        const promoted = this.#database
          .prepare(
            `UPDATE image_assets
            SET id = ?, status = 'temporary', product_id = NULL,
              expires_at = ?, created_at = ?
            WHERE id = ? AND status = 'staging' AND product_id IS NULL`,
          )
          .run(
            asset.id,
            asset.expiresAt,
            asset.createdAt,
            entry.stagingImageAssetId,
          );
        if (promoted.changes !== 1) {
          throw new BeautioError(
            "BATCH_CONFLICT",
            `backup staging image ${entry.stagingImageAssetId} could not be promoted`,
          );
        }
      }
      for (const product of replacement.products) {
        this.insertProduct(product);
      }
      for (const entry of replacement.imageAssets) {
        const asset = entry.imageAsset;
        const result = this.#database
          .prepare(
            `UPDATE image_assets
            SET status = 'linked', product_id = ?
            WHERE id = ? AND status = 'temporary' AND product_id IS NULL`,
          )
          .run(asset.productId, asset.id);
        if (result.changes !== 1) {
          throw new BeautioError(
            "BATCH_CONFLICT",
            `backup image asset ${asset.id} could not be linked`,
          );
        }
      }
      for (const item of replacement.inventoryItems) {
        this.insertInventoryItem(item);
      }
      return cleanupAssets;
    });
  }

  /** @inheritdoc */
  async findProductById(productId: string): Promise<Product | null> {
    return this.readProduct(productId);
  }

  /** @inheritdoc */
  async save(item: InventoryItem): Promise<void> {
    this.updateInventoryRow(item);
  }

  /** @inheritdoc */
  async createBatch(input: InventoryBatchPersistenceInput): Promise<void> {
    this.inImmediateTransaction(() => {
      for (const product of input.products) {
        if (product.imageAssetId !== null) {
          this.assertImageCanBeLinked(product.imageAssetId, input.now);
        }
        this.insertProduct(product);
        if (product.imageAssetId !== null) {
          this.claimImageForProduct(product.imageAssetId, product.id, input.now);
        }
      }

      for (const item of input.inventoryItems) {
        if (
          item.productId === null ||
          this.readProduct(item.productId) === null
        ) {
          throw new BeautioError(
            "PRODUCT_NOT_FOUND",
            `Product ${item.productId ?? ""} does not exist`,
          );
        }
        this.insertInventoryItem(
          createInventoryItem({
            ...item,
            createdAt: input.now,
          }),
        );
      }
    });
  }

  /** @inheritdoc */
  async updateProductFacts(
    input: ProductFactsPersistenceInput,
  ): Promise<Product> {
    this.inImmediateTransaction(() => {
      const existing = this.readProduct(input.productId);
      if (existing === null) {
        throw new BeautioError(
          "PRODUCT_NOT_FOUND",
          `Product ${input.productId} does not exist`,
        );
      }

      this.replaceProductImageAssociation(
        existing,
        input.imageAssetId,
        input.now,
        input.unlinkedExpiresAt,
      );

      const result = this.#database
        .prepare(
          `UPDATE products SET
            name = ?,
            alias = ?,
            brand = ?,
            category = ?,
            size_label = ?,
            image_asset_id = ?,
            ingredient_list_text = ?,
            shared_notes = ?
          WHERE id = ?`,
        )
        .run(
          input.name,
          input.alias === undefined ? existing.alias : input.alias,
          input.brand === undefined ? existing.brand : input.brand,
          input.category,
          input.sizeLabel,
          input.imageAssetId,
          input.ingredientListText,
          input.sharedNotes,
          input.productId,
        );
      if (result.changes !== 1) {
        throw new BeautioError(
          "PRODUCT_NOT_FOUND",
          `Product ${input.productId} does not exist`,
        );
      }
    });

    const product = this.readProduct(input.productId);
    if (product === null) {
      throw new BeautioError(
        "INTERNAL_ERROR",
        "updated Product could not be re-read",
      );
    }
    return product;
  }

  /** @inheritdoc */
  async setProductDisplayImage(
    input: ProductImagePersistenceInput,
  ): Promise<Product> {
    return this.inImmediateTransaction(() => {
      const existing = this.readProduct(input.productId);
      if (existing === null) {
        throw new BeautioError(
          "PRODUCT_NOT_FOUND",
          `Product ${input.productId} does not exist`,
        );
      }
      this.replaceProductImageAssociation(
        existing,
        input.imageAssetId,
        input.now,
        input.unlinkedExpiresAt,
      );
      const result = this.#database
        .prepare("UPDATE products SET image_asset_id = ? WHERE id = ?")
        .run(input.imageAssetId, input.productId);
      if (result.changes !== 1) {
        throw new BeautioError(
          "PRODUCT_NOT_FOUND",
          `Product ${input.productId} does not exist`,
        );
      }
      const product = this.readProduct(input.productId);
      if (product === null) {
        throw new BeautioError(
          "INTERNAL_ERROR",
          "updated Product could not be re-read",
        );
      }
      return product;
    });
  }

  /** @inheritdoc */
  async updateInventoryItemFacts(item: InventoryItem): Promise<InventoryItem> {
    return this.inImmediateTransaction(() => {
      this.updateInventoryRow(item);
      const committed = this.readInventoryItem(item.id);
      if (committed === null) {
        throw new BeautioError(
          "INTERNAL_ERROR",
          "updated inventory item could not be re-read",
        );
      }
      return committed;
    });
  }

  /** @inheritdoc */
  async updateInventoryItemCustomNotes(
    input: InventoryItemCustomNotesPersistenceInput,
  ): Promise<InventoryItem> {
    return this.inImmediateTransaction(() => {
      const result = this.#database
        .prepare(
          "UPDATE inventory_items SET custom_notes = ? WHERE id = ?",
        )
        .run(input.customNotes, input.inventoryItemId);
      if (result.changes !== 1) {
        throw new BeautioError(
          "INVENTORY_ITEM_NOT_FOUND",
          `inventory item ${input.inventoryItemId} does not exist`,
        );
      }
      const committed = this.readInventoryItem(input.inventoryItemId);
      if (committed === null) {
        throw new BeautioError(
          "INTERNAL_ERROR",
          "updated inventory item could not be re-read",
        );
      }
      return committed;
    });
  }

  /** @inheritdoc */
  async stageImageAssets(assets: readonly ImageAsset[]): Promise<void> {
    this.inImmediateTransaction(() => {
      for (const asset of assets) {
        if (asset.status !== "staging" || asset.productId !== null) {
          throw new BeautioError(
            "INVALID_INPUT",
            "new image metadata must be unlinked and staging",
          );
        }
        try {
          this.#database
            .prepare(
              `INSERT INTO image_assets (
                id,
                storage_key,
                media_type,
                byte_size,
                status,
                product_id,
                expires_at,
                created_at
              ) VALUES (?, ?, ?, ?, 'staging', NULL, ?, ?)`,
            )
            .run(
              asset.id,
              asset.storageKey,
              asset.mediaType,
              asset.byteSize,
              asset.expiresAt,
              asset.createdAt,
            );
        } catch (error) {
          throw mapSqliteConflict(error, "image asset metadata conflicts");
        }
      }
    });
  }

  /** @inheritdoc */
  async activateStagedImageAssets(
    imageAssetIds: readonly string[],
  ): Promise<void> {
    this.inImmediateTransaction(() => {
      for (const imageAssetId of imageAssetIds) {
        const result = this.#database
          .prepare(
            `UPDATE image_assets
            SET status = 'temporary'
            WHERE id = ? AND status = 'staging' AND product_id IS NULL`,
          )
          .run(imageAssetId);
        if (result.changes !== 1) {
          throw new BeautioError(
            "BATCH_CONFLICT",
            `image asset ${imageAssetId} cannot be activated`,
          );
        }
      }
    });
  }

  /** @inheritdoc */
  async markImageAssetsForCleanup(
    imageAssetIds: readonly string[],
  ): Promise<void> {
    this.inImmediateTransaction(() => {
      for (const imageAssetId of imageAssetIds) {
        const asset = this.readImageAsset(imageAssetId);
        if (asset === null || asset.status === "pending_cleanup") {
          continue;
        }
        if (asset.status === "linked" || asset.productId !== null) {
          throw new BeautioError(
            "BATCH_CONFLICT",
            `linked image asset ${imageAssetId} cannot be cleaned as an upload failure`,
          );
        }
        this.#database
          .prepare(
            `UPDATE image_assets
            SET status = 'pending_cleanup'
            WHERE id = ? AND status IN ('staging', 'temporary')
              AND product_id IS NULL`,
          )
          .run(imageAssetId);
      }
    });
  }

  /** @inheritdoc */
  async findImageAssetById(imageAssetId: string): Promise<ImageAsset | null> {
    return this.readImageAsset(imageAssetId);
  }

  /** @inheritdoc */
  async claimExpiredImageAssets(now: string): Promise<readonly ImageAsset[]> {
    return this.inImmediateTransaction(() => {
      this.#database
        .prepare(
          `UPDATE image_assets
          SET status = 'pending_cleanup'
          WHERE status IN ('staging', 'temporary')
            AND product_id IS NULL
            AND expires_at <= ?`,
        )
        .run(now);
      const rows = this.#database
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
          WHERE status = 'pending_cleanup' AND product_id IS NULL
          ORDER BY id ASC`,
        )
        .all() as unknown as readonly ImageAssetRow[];
      return rows.map(mapImageAssetRow);
    });
  }

  /** @inheritdoc */
  async deleteClaimedImageAsset(imageAssetId: string): Promise<void> {
    this.#database
      .prepare(
        `DELETE FROM image_assets
        WHERE id = ? AND status = 'pending_cleanup' AND product_id IS NULL`,
      )
      .run(imageAssetId);
  }

  /**
   * Inserts a complete item for local development and automated tests only.
   *
   * @param item - Valid domain item to pre-populate before exercising tools.
   * @returns A promise resolved after the row is inserted.
   */
  async seedInventoryItem(item: InventoryItem): Promise<void> {
    this.insertInventoryItem(item);
  }

  /**
   * Adds absent products and inventory items without updating or deleting rows.
   *
   * Re-importing identical data is an idempotent no-op. A conflicting existing
   * identifier aborts the whole transaction so previously stored facts remain intact.
   *
   * @param data - Valid domain entities to add to the local repository.
   * @returns Inserted and already-existing entity counts.
   */
  async importInventoryData(
    data: InventoryImportData,
  ): Promise<InventoryImportResult> {
    return importInventoryDataWithOperations(data, {
      readProduct: (productId) => this.readProduct(productId),
      readInventoryItem: (inventoryItemId) =>
        this.readInventoryItem(inventoryItemId),
      insertProduct: (product) => this.insertProduct(product),
      insertInventoryItem: (item) => this.insertInventoryItem(item),
      inImmediateTransaction: (action) => this.inImmediateTransaction(action),
    });
  }

  /**
   * Closes the underlying SQLite connection.
   *
   * @returns Nothing after the connection is closed.
   */
  close(): void {
    this.#database.close();
  }

  private readInventoryItem(inventoryItemId: string): InventoryItem | null {
    return readInventoryItemRecord(this.#database, inventoryItemId);
  }

  private readProduct(productId: string): Product | null {
    return readProductRecord(this.#database, productId);
  }

  private readImageAsset(imageAssetId: string): ImageAsset | null {
    return readImageAssetRecord(this.#database, imageAssetId);
  }

  private readAllImageAssets(): readonly ImageAsset[] {
    const rows = this.#database
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
        ORDER BY id ASC`,
      )
      .all() as unknown as readonly ImageAssetRow[];
    return rows.map(mapImageAssetRow);
  }

  private insertProduct(product: Product): void {
    insertProductRecord(this.#database, product);
  }

  private insertInventoryItem(item: InventoryItem): void {
    insertInventoryItemRecord(this.#database, item);
  }

  private updateInventoryRow(item: InventoryItem): void {
    updateInventoryRecord(this.#database, item);
  }

  private assertImageCanBeLinked(imageAssetId: string, now: string): void {
    const asset = this.readImageAsset(imageAssetId);
    if (asset === null) {
      throw new BeautioError(
        "IMAGE_ASSET_NOT_FOUND",
        `image asset ${imageAssetId} does not exist`,
      );
    }
    if (asset.status === "temporary" && asset.expiresAt <= now) {
      throw new BeautioError(
        "IMAGE_ASSET_EXPIRED",
        `image asset ${imageAssetId} is expired`,
      );
    }
    if (asset.status !== "temporary" || asset.productId !== null) {
      throw new BeautioError(
        "BATCH_CONFLICT",
        `image asset ${imageAssetId} is not available`,
      );
    }
  }

  private replaceProductImageAssociation(
    existing: Product,
    imageAssetId: string | null,
    now: string,
    unlinkedExpiresAt: string,
  ): void {
    if (existing.imageAssetId !== imageAssetId) {
      if (existing.imageAssetId !== null) {
        const released = this.#database
          .prepare(
            `UPDATE image_assets SET
              status = 'temporary',
              product_id = NULL,
              expires_at = ?
            WHERE id = ? AND status = 'linked' AND product_id = ?`,
          )
          .run(unlinkedExpiresAt, existing.imageAssetId, existing.id);
        if (released.changes !== 1) {
          throw new BeautioError(
            "BATCH_CONFLICT",
            "the existing Product image association is inconsistent",
          );
        }
      }
      if (imageAssetId !== null) {
        this.claimImageForProduct(imageAssetId, existing.id, now);
      }
      return;
    }

    if (imageAssetId !== null) {
      const currentAsset = this.readImageAsset(imageAssetId);
      if (
        currentAsset === null ||
        currentAsset.status !== "linked" ||
        currentAsset.productId !== existing.id
      ) {
        throw new BeautioError(
          "BATCH_CONFLICT",
          "the Product image association is inconsistent",
        );
      }
    }
  }

  private claimImageForProduct(
    imageAssetId: string,
    productId: string,
    now: string,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE image_assets SET status = 'linked', product_id = ?
        WHERE id = ?
          AND status = 'temporary'
          AND product_id IS NULL
          AND expires_at > ?`,
      )
      .run(productId, imageAssetId, now);
    if (result.changes !== 1) {
      this.assertImageCanBeLinked(imageAssetId, now);
      throw new BeautioError(
        "BATCH_CONFLICT",
        `image asset ${imageAssetId} could not be associated`,
      );
    }
  }

  private inImmediateTransaction<T>(action: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

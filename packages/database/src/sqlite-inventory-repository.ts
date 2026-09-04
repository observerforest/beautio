import type {
  BackupInventoryRepository,
  ClaimCommandExecutionPersistenceInput,
  ClaimCommandExecutionPersistenceResult,
  CommandExecutionKey,
  CommandExecutionRecord,
  CommandExecutionRepository,
  CompleteCommandExecutionFailurePersistenceInput,
  CompleteCommandExecutionPersistenceResult,
  CompleteCommandExecutionSuccessPersistenceInput,
  InventoryBatchPersistenceInput,
  InventoryBackupReplacement,
  InventoryBackupSnapshot,
  InventoryItemCustomNotesPersistenceInput,
  InventoryCollectionReadOptions,
  ProductFactsPersistenceInput,
  ProductImagePersistenceInput,
  RecordProductOpenedPersistenceInput,
  RecordProductOpenedPersistenceResult,
} from "@beautio/application";
import {
  BeautioError,
  createInventoryItem,
  endInventoryItem as endInventoryItemTransition,
  openInventoryItem,
  updateInventoryItemPao,
  type ImageAsset,
  type InventoryItem,
  type Product,
} from "@beautio/domain";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  claimCommandExecutionRecord,
  completeCommandExecutionKnownFailureRecord,
  completeCommandExecutionSuccessRecord,
  findCommandExecutionRecord,
} from "./command-execution-records.ts";
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

export type {
  InventoryImportData,
  InventoryImportProduct,
  InventoryImportResult,
} from "./import.ts";

export class SqliteInventoryRepository
  implements BackupInventoryRepository, CommandExecutionRepository
{
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
  async claimCommandExecution(
    input: ClaimCommandExecutionPersistenceInput,
  ): Promise<ClaimCommandExecutionPersistenceResult> {
    return claimCommandExecutionRecord(this.#database, input);
  }

  /** @inheritdoc */
  async completeCommandExecutionSuccess(
    input: CompleteCommandExecutionSuccessPersistenceInput,
  ): Promise<CompleteCommandExecutionPersistenceResult> {
    return completeCommandExecutionSuccessRecord(this.#database, input);
  }

  /** @inheritdoc */
  async completeCommandExecutionKnownFailure(
    input: CompleteCommandExecutionFailurePersistenceInput,
  ): Promise<CompleteCommandExecutionPersistenceResult> {
    return completeCommandExecutionKnownFailureRecord(this.#database, input);
  }

  /** @inheritdoc */
  async findCommandExecution(
    key: CommandExecutionKey,
  ): Promise<CommandExecutionRecord | null> {
    return findCommandExecutionRecord(this.#database, key);
  }

  /** @inheritdoc */
  async findById(inventoryItemId: string): Promise<InventoryItem | null> {
    return this.readInventoryItem(inventoryItemId);
  }

  /** @inheritdoc */
  async findAll(
    options?: InventoryCollectionReadOptions,
  ): Promise<readonly InventoryItem[]> {
    const maximumItems =
      options === undefined
        ? null
        : requirePositiveReadLimit(options.maximumItems);
    const statement = this.#database.prepare(
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
          remaining_percent_estimate,
          custom_notes
        FROM inventory_items
        ORDER BY id ASC${maximumItems === null ? "" : "\n        LIMIT ?"}`,
    );
    const rows = (maximumItems === null
      ? statement.all()
      : statement.all(maximumItems)) as unknown as readonly InventoryRow[];

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
            pao_duration_months,
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
            remaining_percent_estimate,
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
      const occupiedIds = new Set([
        ...existingAssets.map((asset) => asset.id),
        ...replacement.imageAssets.map((entry) => entry.imageAsset.id),
      ]);

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
    this.inImmediateTransaction(() => {
      const current = this.readInventoryItem(item.id);
      if (current === null) {
        throw new BeautioError(
          "INVENTORY_ITEM_NOT_FOUND",
          `inventory item ${item.id} does not exist`,
        );
      }
      const product =
        current.productId === null ? null : this.readProduct(current.productId);
      const duration = current.paoDurationMonths ??
        (current.lifecycleStatus === "unopened" && item.lifecycleStatus === "opened"
          ? product?.paoDurationMonths ?? null
          : null);
      this.updateInventoryRow(updateInventoryItemPao(item, duration));
    });
  }

  /** @inheritdoc */
  async recordProductOpened(
    input: RecordProductOpenedPersistenceInput,
  ): Promise<RecordProductOpenedPersistenceResult> {
    this.beginImmediateForRecordProductOpened();
    try {
      let current = this.readInventoryItem(input.inventoryItemId);
      if (current === null) {
        throw new BeautioError(
          "INVENTORY_ITEM_NOT_FOUND",
          `inventory item ${input.inventoryItemId} does not exist`,
        );
      }

      if (
        current.lifecycleStatus === "unopened" &&
        current.paoDurationMonths === null &&
        current.productId !== null
      ) {
        const product = this.readProduct(current.productId);
        current = updateInventoryItemPao(
          current,
          product?.paoDurationMonths ?? null,
        );
      }

      const transition = openInventoryItem(
        current,
        input.openedOn,
        input.openedOnAccuracy,
      );
      if (transition.outcome === "opened") {
        this.updateInventoryRow(transition.item);
      }

      const persisted = this.readInventoryItem(input.inventoryItemId);
      if (
        persisted === null ||
        persisted.lifecycleStatus !== "opened" ||
        persisted.openedOn !== input.openedOn ||
        persisted.openedOnAccuracy !== input.openedOnAccuracy
      ) {
        throw new BeautioError(
          "INTERNAL_ERROR",
          "database write could not be verified",
        );
      }
      this.#database.exec("COMMIT");
      return { outcome: transition.outcome, item: persisted };
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        throw new BeautioError(
          "INTERNAL_ERROR",
          "database transaction recovery failed",
        );
      }
      throw error;
    }
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
        const product =
          item.productId === null ? null : this.readProduct(item.productId);
        if (product === null) {
          throw new BeautioError(
            "PRODUCT_NOT_FOUND",
            `Product ${item.productId ?? ""} does not exist`,
          );
        }
        this.insertInventoryItem(
          createInventoryItem({
            ...this.inheritProductPao(item, product),
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
            pao_duration_months = ?,
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
          input.paoDurationMonths === undefined
            ? existing.paoDurationMonths
            : input.paoDurationMonths,
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
      if (input.paoDurationMonths !== undefined) {
        const bottles = this.#database
          .prepare("SELECT id FROM inventory_items WHERE product_id = ?")
          .all(input.productId) as unknown as readonly { readonly id: string }[];
        for (const bottle of bottles) {
          const item = this.readInventoryItem(bottle.id);
          if (item === null) {
            throw new BeautioError(
              "INTERNAL_ERROR",
              "associated inventory item could not be read",
            );
          }
          this.updateInventoryRow(
            updateInventoryItemPao(item, input.paoDurationMonths),
          );
        }
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
  async updateInventoryItemFacts(
    item: InventoryItem,
    expectedPaoDurationMonths?: number | null,
  ): Promise<InventoryItem> {
    return this.inImmediateTransaction(() => {
      const existing = this.readInventoryItem(item.id);
      if (existing === null) {
        throw new BeautioError(
          "INVENTORY_ITEM_NOT_FOUND",
          `inventory item ${item.id} does not exist`,
        );
      }
      if (
        expectedPaoDurationMonths !== undefined &&
        existing.paoDurationMonths !== expectedPaoDurationMonths
      ) {
        throw new BeautioError(
          "BATCH_CONFLICT",
          "bottle PAO changed while its facts were being edited",
        );
      }
      const product =
        existing.productId === null ? null : this.readProduct(existing.productId);
      const openingWithoutPao =
        existing.lifecycleStatus === "unopened" &&
        item.lifecycleStatus === "opened" &&
        existing.paoDurationMonths === null &&
        item.paoDurationMonths === null;
      const durationChanged = item.paoDurationMonths !== existing.paoDurationMonths;
      this.updateInventoryRow(
        product !== null && (openingWithoutPao || durationChanged)
          ? this.inheritProductPao(item, product)
          : item,
      );
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
  async endInventoryItem(item: InventoryItem): Promise<InventoryItem> {
    return this.inImmediateTransaction(() => {
      const current = this.readInventoryItem(item.id);
      if (current === null) {
        throw new BeautioError(
          "INVENTORY_ITEM_NOT_FOUND",
          `inventory item ${item.id} does not exist`,
        );
      }
      let terminal: InventoryItem;
      if (item.lifecycleStatus === "finished") {
        terminal = endInventoryItemTransition(current, {
          lifecycleStatus: "finished",
        });
      } else if (item.lifecycleStatus === "discarded") {
        terminal = endInventoryItemTransition(current, {
          lifecycleStatus: "discarded",
          remainingPercentEstimate: item.remainingPercentEstimate,
        });
      } else {
        throw new BeautioError(
          "INVALID_INPUT",
          "end-use persistence requires a terminal inventory item",
        );
      }

      this.updateInventoryRow(terminal);
      const committed = this.readInventoryItem(item.id);
      if (committed === null) {
        throw new BeautioError(
          "INTERNAL_ERROR",
          "ended inventory item could not be re-read",
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

  private inheritProductPao(item: InventoryItem, product: Product): InventoryItem {
    if (product.paoDurationMonths === null) {
      return item;
    }
    if (
      item.paoDurationMonths !== null &&
      item.paoDurationMonths !== product.paoDurationMonths
    ) {
      throw new BeautioError(
        "INVALID_INPUT",
        "bottle pao_duration_months conflicts with the shared Product PAO",
      );
    }
    return updateInventoryItemPao(item, product.paoDurationMonths);
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

  private beginImmediateForRecordProductOpened(): void {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (isSqliteBusyOrLocked(error)) {
        throw new BeautioError(
          "BATCH_CONFLICT",
          "inventory is busy; no write was performed",
        );
      }
      throw new BeautioError("INTERNAL_ERROR", "database write failed");
    }
  }
}

function requirePositiveReadLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("maximumItems must be a positive safe integer");
  }
  return value;
}

function isSqliteBusyOrLocked(
  error: unknown,
): error is { readonly errcode: number } {
  if (
    typeof error !== "object" ||
    error === null ||
    !("errcode" in error) ||
    typeof error.errcode !== "number"
  ) {
    return false;
  }
  const primaryResultCode = error.errcode & 0xff;
  return primaryResultCode === 5 || primaryResultCode === 6;
}

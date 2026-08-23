import type {
  InventoryBatchPersistenceInput,
  InventoryItemCustomNotesPersistenceInput,
  InventoryRepository,
  ProductFactsPersistenceInput,
  ProductImagePersistenceInput,
} from "@beautio/application";
import {
  BeautioError,
  createInventoryItem,
  createProduct,
  type ImageAsset,
  type ImageAssetStatus,
  type ImageMediaType,
  type InventoryItem,
  type LifecycleStatus,
  type OpenedOnAccuracy,
  type Product,
} from "@beautio/domain";
import { DatabaseSync } from "node:sqlite";

interface InventoryRow {
  readonly id: string;
  readonly product_id: string | null;
  readonly lifecycle_status: LifecycleStatus;
  readonly opened_on: string | null;
  readonly opened_on_accuracy: OpenedOnAccuracy | null;
  readonly expires_on: string | null;
  readonly pao_duration_months: number | null;
  readonly pao_deadline: string | null;
  readonly usable_until: string | null;
  readonly custom_notes: string | null;
}

interface ProductRow {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly size_label: string | null;
  readonly image_asset_id: string | null;
  readonly image_ref: string | null;
  readonly ingredient_list_text: string | null;
  readonly shared_notes: string | null;
}

interface ImageAssetRow {
  readonly id: string;
  readonly storage_key: string;
  readonly media_type: ImageMediaType;
  readonly byte_size: number;
  readonly status: ImageAssetStatus;
  readonly product_id: string | null;
  readonly expires_at: string;
  readonly created_at: string;
}

interface TableInfoRow {
  readonly name: string;
  readonly notnull: 0 | 1;
}

export interface InventoryImportData {
  readonly products: readonly Product[];
  readonly inventoryItems: readonly InventoryItem[];
}

export interface InventoryImportResult {
  readonly productsInserted: number;
  readonly productsExisting: number;
  readonly inventoryItemsInserted: number;
  readonly inventoryItemsExisting: number;
}

export class SqliteInventoryRepository implements InventoryRepository {
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
    this.#database.exec("PRAGMA foreign_keys = OFF");
    this.createCurrentTables();
    this.addProductReferenceToLegacyInventory();
    this.addImageReferenceToLegacyProducts();
    this.addImageAssetReferenceToLegacyProducts();
    this.addOpeningAccuracyToLegacyInventory();
    this.addTextFieldsToLegacyProducts();
    this.addCustomNotesToLegacyInventory();
    this.rebuildProductsForNullableCategory();
    this.#database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS products_image_asset_unique
      ON products(image_asset_id)
      WHERE image_asset_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS image_assets_product_unique
      ON image_assets(product_id)
      WHERE product_id IS NOT NULL;
    `);
    this.#database.exec("PRAGMA foreign_keys = ON");
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
        this.insertInventoryItem(item);
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
            category = ?,
            size_label = ?,
            image_asset_id = ?,
            ingredient_list_text = ?,
            shared_notes = ?
          WHERE id = ?`,
        )
        .run(
          input.name,
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
    const result = {
      productsInserted: 0,
      productsExisting: 0,
      inventoryItemsInserted: 0,
      inventoryItemsExisting: 0,
    };

    return this.inImmediateTransaction(() => {
      for (const product of data.products) {
        if (product.imageAssetId !== null) {
          throw new BeautioError(
            "INVALID_INPUT",
            "local import cannot create managed image associations",
          );
        }
        const existing = this.readProduct(product.id);
        if (existing === null) {
          this.insertProduct(product);
          result.productsInserted += 1;
        } else {
          assertProductMatches(existing, product);
          result.productsExisting += 1;
        }
      }

      for (const item of data.inventoryItems) {
        const existing = this.readInventoryItem(item.id);
        if (existing === null) {
          this.insertInventoryItem(item);
          result.inventoryItemsInserted += 1;
        } else {
          assertInventoryMatches(existing, item);
          result.inventoryItemsExisting += 1;
        }
      }

      return result;
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

  private createCurrentTables(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        category TEXT CHECK (
          category IS NULL OR length(trim(category)) > 0
        ),
        size_label TEXT CHECK (
          size_label IS NULL OR length(trim(size_label)) > 0
        ),
        image_asset_id TEXT REFERENCES image_assets(id),
        image_ref TEXT CHECK (
          image_ref IS NULL OR length(trim(image_ref)) > 0
        ),
        ingredient_list_text TEXT CHECK (
          ingredient_list_text IS NULL OR (
            length(trim(ingredient_list_text)) > 0 AND
            length(trim(ingredient_list_text)) <= 5000
          )
        ),
        shared_notes TEXT CHECK (
          shared_notes IS NULL OR (
            length(trim(shared_notes)) > 0 AND
            length(trim(shared_notes)) <= 1000
          )
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS inventory_items (
        id TEXT PRIMARY KEY,
        product_id TEXT REFERENCES products(id),
        lifecycle_status TEXT NOT NULL CHECK (
          lifecycle_status IN ('unopened', 'opened', 'finished', 'discarded')
        ),
        opened_on TEXT,
        opened_on_accuracy TEXT CHECK (
          opened_on_accuracy IS NULL OR
          opened_on_accuracy IN ('exact', 'estimated', 'legacy_unknown')
        ),
        expires_on TEXT,
        pao_duration_months INTEGER CHECK (
          pao_duration_months IS NULL OR
          (pao_duration_months >= 1 AND pao_duration_months <= 120)
        ),
        pao_deadline TEXT,
        usable_until TEXT,
        custom_notes TEXT CHECK (
          custom_notes IS NULL OR (
            length(trim(custom_notes)) > 0 AND
            length(trim(custom_notes)) <= 1000
          )
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS image_assets (
        id TEXT PRIMARY KEY,
        storage_key TEXT NOT NULL UNIQUE CHECK (length(trim(storage_key)) > 0),
        media_type TEXT NOT NULL CHECK (
          media_type IN ('image/jpeg', 'image/png', 'image/webp')
        ),
        byte_size INTEGER NOT NULL CHECK (byte_size > 0),
        status TEXT NOT NULL CHECK (
          status IN ('staging', 'temporary', 'linked', 'pending_cleanup')
        ),
        product_id TEXT REFERENCES products(id),
        expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
        created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
        CHECK (
          (status = 'linked' AND product_id IS NOT NULL) OR
          (status <> 'linked' AND product_id IS NULL)
        )
      ) STRICT;
    `);
  }

  private addProductReferenceToLegacyInventory(): void {
    if (this.tableHasColumn("inventory_items", "product_id")) {
      return;
    }
    this.#database.exec(
      "ALTER TABLE inventory_items ADD COLUMN product_id TEXT REFERENCES products(id)",
    );
  }

  private addImageReferenceToLegacyProducts(): void {
    if (this.tableHasColumn("products", "image_ref")) {
      return;
    }
    this.#database.exec(
      `ALTER TABLE products ADD COLUMN image_ref TEXT CHECK (
        image_ref IS NULL OR length(trim(image_ref)) > 0
      )`,
    );
  }

  private addImageAssetReferenceToLegacyProducts(): void {
    if (this.tableHasColumn("products", "image_asset_id")) {
      return;
    }
    this.#database.exec(
      "ALTER TABLE products ADD COLUMN image_asset_id TEXT REFERENCES image_assets(id)",
    );
  }

  private addOpeningAccuracyToLegacyInventory(): void {
    if (!this.tableHasColumn("inventory_items", "opened_on_accuracy")) {
      this.#database.exec(
        `ALTER TABLE inventory_items ADD COLUMN opened_on_accuracy TEXT CHECK (
          opened_on_accuracy IS NULL OR
          opened_on_accuracy IN ('exact', 'estimated', 'legacy_unknown')
        )`,
      );
    }
    this.#database.exec(
      `UPDATE inventory_items
      SET opened_on_accuracy = 'legacy_unknown'
      WHERE opened_on IS NOT NULL AND opened_on_accuracy IS NULL`,
    );
  }

  private addTextFieldsToLegacyProducts(): void {
    if (!this.tableHasColumn("products", "ingredient_list_text")) {
      this.#database.exec(
        `ALTER TABLE products ADD COLUMN ingredient_list_text TEXT CHECK (
          ingredient_list_text IS NULL OR (
            length(trim(ingredient_list_text)) > 0 AND
            length(trim(ingredient_list_text)) <= 5000
          )
        )`,
      );
    }
    if (!this.tableHasColumn("products", "shared_notes")) {
      this.#database.exec(
        `ALTER TABLE products ADD COLUMN shared_notes TEXT CHECK (
          shared_notes IS NULL OR (
            length(trim(shared_notes)) > 0 AND
            length(trim(shared_notes)) <= 1000
          )
        )`,
      );
    }
  }

  private addCustomNotesToLegacyInventory(): void {
    if (this.tableHasColumn("inventory_items", "custom_notes")) {
      return;
    }
    this.#database.exec(
      `ALTER TABLE inventory_items ADD COLUMN custom_notes TEXT CHECK (
        custom_notes IS NULL OR (
          length(trim(custom_notes)) > 0 AND
          length(trim(custom_notes)) <= 1000
        )
      )`,
    );
  }

  private rebuildProductsForNullableCategory(): void {
    const category = this.tableColumns("products").find(
      (column) => column.name === "category",
    );
    if (category === undefined || category.notnull === 0) {
      return;
    }

    this.#database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE products_next (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        category TEXT CHECK (
          category IS NULL OR length(trim(category)) > 0
        ),
        size_label TEXT CHECK (
          size_label IS NULL OR length(trim(size_label)) > 0
        ),
        image_asset_id TEXT REFERENCES image_assets(id),
        image_ref TEXT CHECK (
          image_ref IS NULL OR length(trim(image_ref)) > 0
        ),
        ingredient_list_text TEXT CHECK (
          ingredient_list_text IS NULL OR (
            length(trim(ingredient_list_text)) > 0 AND
            length(trim(ingredient_list_text)) <= 5000
          )
        ),
        shared_notes TEXT CHECK (
          shared_notes IS NULL OR (
            length(trim(shared_notes)) > 0 AND
            length(trim(shared_notes)) <= 1000
          )
        )
      ) STRICT;
      INSERT INTO products_next (
        id,
        name,
        category,
        size_label,
        image_asset_id,
        image_ref,
        ingredient_list_text,
        shared_notes
      )
      SELECT
        id,
        name,
        category,
        size_label,
        image_asset_id,
        image_ref,
        ingredient_list_text,
        shared_notes
      FROM products;
      DROP TABLE products;
      ALTER TABLE products_next RENAME TO products;
      COMMIT;
    `);
  }

  private tableColumns(tableName: string): readonly TableInfoRow[] {
    return this.#database
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as unknown as readonly TableInfoRow[];
  }

  private tableHasColumn(tableName: string, columnName: string): boolean {
    return this.tableColumns(tableName).some(
      (column) => column.name === columnName,
    );
  }

  private readInventoryItem(inventoryItemId: string): InventoryItem | null {
    const row = this.#database
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

  private readProduct(productId: string): Product | null {
    const row = this.#database
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

  private readImageAsset(imageAssetId: string): ImageAsset | null {
    const row = this.#database
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

  private insertProduct(product: Product): void {
    try {
      this.#database
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

  private insertInventoryItem(item: InventoryItem): void {
    try {
      this.#database
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

  private updateInventoryRow(item: InventoryItem): void {
    const result = this.#database
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

function mapInventoryRow(row: InventoryRow): InventoryItem {
  return createInventoryItem({
    id: row.id,
    productId: row.product_id,
    lifecycleStatus: row.lifecycle_status,
    openedOn: row.opened_on,
    openedOnAccuracy: row.opened_on_accuracy,
    expiresOn: row.expires_on,
    paoDurationMonths: row.pao_duration_months,
    paoDeadline: row.pao_deadline,
    usableUntil: row.usable_until,
    customNotes: row.custom_notes,
  });
}

function mapProductRow(row: ProductRow): Product {
  return createProduct({
    id: row.id,
    name: row.name,
    category: row.category,
    sizeLabel: row.size_label,
    imageAssetId: row.image_asset_id,
    imageRef: row.image_ref,
    ingredientListText: row.ingredient_list_text,
    sharedNotes: row.shared_notes,
  });
}

function mapImageAssetRow(row: ImageAssetRow): ImageAsset {
  return {
    id: row.id,
    storageKey: row.storage_key,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    status: row.status,
    productId: row.product_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function assertProductMatches(existing: Product, incoming: Product): void {
  if (
    existing.name !== incoming.name ||
    existing.category !== incoming.category ||
    existing.sizeLabel !== incoming.sizeLabel ||
    existing.imageAssetId !== incoming.imageAssetId ||
    existing.imageRef !== incoming.imageRef ||
    existing.ingredientListText !== incoming.ingredientListText ||
    existing.sharedNotes !== incoming.sharedNotes
  ) {
    throw importConflict("product", incoming.id);
  }
}

function assertInventoryMatches(
  existing: InventoryItem,
  incoming: InventoryItem,
): void {
  if (
    existing.productId !== incoming.productId ||
    existing.lifecycleStatus !== incoming.lifecycleStatus ||
    existing.openedOn !== incoming.openedOn ||
    existing.openedOnAccuracy !== incoming.openedOnAccuracy ||
    existing.expiresOn !== incoming.expiresOn ||
    existing.paoDurationMonths !== incoming.paoDurationMonths ||
    existing.paoDeadline !== incoming.paoDeadline ||
    existing.usableUntil !== incoming.usableUntil ||
    existing.customNotes !== incoming.customNotes
  ) {
    throw importConflict("inventory item", incoming.id);
  }
}

function importConflict(entityName: string, id: string): BeautioError {
  return new BeautioError(
    "INVALID_INPUT",
    `${entityName} ${id} already exists with different data`,
  );
}

function mapSqliteConflict(error: unknown, message: string): BeautioError {
  if (error instanceof BeautioError) {
    return error;
  }
  if (isSqliteConstraintError(error)) {
    return new BeautioError("BATCH_CONFLICT", message);
  }
  return new BeautioError("INTERNAL_ERROR", "database write failed");
}

function isSqliteConstraintError(
  error: unknown,
): error is { readonly errcode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    typeof error.errcode === "number" &&
    (error.errcode & 0xff) === 19
  );
}

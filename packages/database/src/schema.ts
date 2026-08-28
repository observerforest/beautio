import { productAliasMaximumLength } from "@beautio/domain";
import { DatabaseSync } from "node:sqlite";

interface TableInfoRow {
  readonly name: string;
  readonly notnull: 0 | 1;
}

export function applySchema(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF");
  createCurrentTables(database);
  addProductReferenceToLegacyInventory(database);
  addImageReferenceToLegacyProducts(database);
  addImageAssetReferenceToLegacyProducts(database);
  addOpeningAccuracyToLegacyInventory(database);
  addTextFieldsToLegacyProducts(database);
  addBrandToLegacyProducts(database);
  addAliasToLegacyProducts(database);
  addCustomNotesToLegacyInventory(database);
  rebuildProductsForNullableCategory(database);
  addInventoryCreationTimestamp(database);
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS products_image_asset_unique
    ON products(image_asset_id)
    WHERE image_asset_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS image_assets_product_unique
    ON image_assets(product_id)
    WHERE product_id IS NOT NULL;
  `);
  database.exec("PRAGMA foreign_keys = ON");
}

function createCurrentTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      alias TEXT CHECK (
        alias IS NULL OR (
          length(trim(alias)) > 0 AND
          length(trim(alias)) <= ${productAliasMaximumLength}
        )
      ),
      brand TEXT CHECK (
        brand IS NULL OR length(trim(brand)) > 0
      ),
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
      created_at TEXT CHECK (
        created_at IS NULL OR length(trim(created_at)) > 0
      ),
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

function addProductReferenceToLegacyInventory(database: DatabaseSync): void {
  if (tableHasColumn(database, "inventory_items", "product_id")) {
    return;
  }
  database.exec(
    "ALTER TABLE inventory_items ADD COLUMN product_id TEXT REFERENCES products(id)",
  );
}

function addImageReferenceToLegacyProducts(database: DatabaseSync): void {
  if (tableHasColumn(database, "products", "image_ref")) {
    return;
  }
  database.exec(
    `ALTER TABLE products ADD COLUMN image_ref TEXT CHECK (
      image_ref IS NULL OR length(trim(image_ref)) > 0
    )`,
  );
}

function addImageAssetReferenceToLegacyProducts(database: DatabaseSync): void {
  if (tableHasColumn(database, "products", "image_asset_id")) {
    return;
  }
  database.exec(
    "ALTER TABLE products ADD COLUMN image_asset_id TEXT REFERENCES image_assets(id)",
  );
}

function addOpeningAccuracyToLegacyInventory(database: DatabaseSync): void {
  if (!tableHasColumn(database, "inventory_items", "opened_on_accuracy")) {
    database.exec(
      `ALTER TABLE inventory_items ADD COLUMN opened_on_accuracy TEXT CHECK (
        opened_on_accuracy IS NULL OR
        opened_on_accuracy IN ('exact', 'estimated', 'legacy_unknown')
      )`,
    );
  }
  database.exec(
    `UPDATE inventory_items
    SET opened_on_accuracy = 'legacy_unknown'
    WHERE opened_on IS NOT NULL AND opened_on_accuracy IS NULL`,
  );
}

function addTextFieldsToLegacyProducts(database: DatabaseSync): void {
  if (!tableHasColumn(database, "products", "ingredient_list_text")) {
    database.exec(
      `ALTER TABLE products ADD COLUMN ingredient_list_text TEXT CHECK (
        ingredient_list_text IS NULL OR (
          length(trim(ingredient_list_text)) > 0 AND
          length(trim(ingredient_list_text)) <= 5000
        )
      )`,
    );
  }
  if (!tableHasColumn(database, "products", "shared_notes")) {
    database.exec(
      `ALTER TABLE products ADD COLUMN shared_notes TEXT CHECK (
        shared_notes IS NULL OR (
          length(trim(shared_notes)) > 0 AND
          length(trim(shared_notes)) <= 1000
        )
      )`,
    );
  }
}

function addBrandToLegacyProducts(database: DatabaseSync): void {
  if (tableHasColumn(database, "products", "brand")) {
    return;
  }
  database.exec(
    `ALTER TABLE products ADD COLUMN brand TEXT CHECK (
      brand IS NULL OR length(trim(brand)) > 0
    )`,
  );
}

function addAliasToLegacyProducts(database: DatabaseSync): void {
  if (tableHasColumn(database, "products", "alias")) {
    return;
  }
  database.exec(
    `ALTER TABLE products ADD COLUMN alias TEXT CHECK (
      alias IS NULL OR (
        length(trim(alias)) > 0 AND
        length(trim(alias)) <= ${productAliasMaximumLength}
      )
    )`,
  );
}

function addCustomNotesToLegacyInventory(database: DatabaseSync): void {
  if (tableHasColumn(database, "inventory_items", "custom_notes")) {
    return;
  }
  database.exec(
    `ALTER TABLE inventory_items ADD COLUMN custom_notes TEXT CHECK (
      custom_notes IS NULL OR (
        length(trim(custom_notes)) > 0 AND
        length(trim(custom_notes)) <= 1000
      )
    )`,
  );
}

function rebuildProductsForNullableCategory(database: DatabaseSync): void {
  const category = tableColumns(database, "products").find(
    (column) => column.name === "category",
  );
  if (category === undefined || category.notnull === 0) {
    return;
  }

  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE products_next (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      alias TEXT CHECK (
        alias IS NULL OR (
          length(trim(alias)) > 0 AND
          length(trim(alias)) <= ${productAliasMaximumLength}
        )
      ),
      brand TEXT CHECK (
        brand IS NULL OR length(trim(brand)) > 0
      ),
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
      alias,
      brand,
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
      alias,
      brand,
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

function addInventoryCreationTimestamp(database: DatabaseSync): void {
  if (tableHasColumn(database, "inventory_items", "created_at")) {
    return;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      ALTER TABLE inventory_items ADD COLUMN created_at TEXT CHECK (
        created_at IS NULL OR length(trim(created_at)) > 0
      )
    `);
    database.exec(`
      UPDATE inventory_items
      SET created_at = (
        SELECT image_assets.created_at
        FROM products
        JOIN image_assets ON image_assets.id = products.image_asset_id
        WHERE products.id = inventory_items.product_id
          AND image_assets.product_id = products.id
          AND image_assets.status = 'linked'
          AND image_assets.created_at = strftime(
            '%Y-%m-%dT%H:%M:%fZ',
            image_assets.created_at
          )
      )
      WHERE created_at IS NULL
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function tableColumns(
  database: DatabaseSync,
  tableName: string,
): readonly TableInfoRow[] {
  return database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as unknown as readonly TableInfoRow[];
}

function tableHasColumn(
  database: DatabaseSync,
  tableName: string,
  columnName: string,
): boolean {
  return tableColumns(database, tableName).some(
    (column) => column.name === columnName,
  );
}

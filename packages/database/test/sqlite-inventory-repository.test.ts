import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InventoryApplicationService,
  type GeneratedIdKind,
  type ImageAssetStorage,
  type ImageInspector,
} from "@beautio/application";
import {
  BeautioError,
  createInventoryItem,
  createProduct,
  type ImageAsset,
} from "@beautio/domain";
import { DatabaseSync } from "node:sqlite";
import { SqliteInventoryRepository } from "../src/index.ts";

test("SQLite persists opened facts across repository instances", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-sqlite-"));
  const databasePath = join(directory, "inventory.sqlite");
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const firstRepository = new SqliteInventoryRepository(databasePath);
  await firstRepository.seedInventoryItem(
    createInventoryItem({
      id: "persistent-inventory",
      lifecycleStatus: "unopened",
      expiresOn: "2028-01-01",
      paoDurationMonths: 12,
    }),
  );
  const firstService = new InventoryApplicationService(firstRepository);
  await firstService.recordProductOpened({
    inventory_item_id: "persistent-inventory",
    opened_on: "2026-08-18",
  });
  firstRepository.close();

  const reopenedRepository = new SqliteInventoryRepository(databasePath);
  const reopenedService = new InventoryApplicationService(reopenedRepository);
  const readback = await reopenedService.getInventoryItem({
    inventory_item_id: "persistent-inventory",
    as_of: "2026-08-18",
  });

  assert.equal(readback.lifecycle_status, "opened");
  assert.equal(readback.opened_on, "2026-08-18");
  assert.equal(readback.opened_on_accuracy, "legacy_unknown");
  assert.equal(readback.pao_deadline, "2027-08-18");
  assert.equal(readback.pao_deadline_accuracy, "legacy_unknown");
  assert.equal(readback.usable_until, "2027-08-18");
  reopenedRepository.close();
});

test("SQLite lists inventory in stable identifier order", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-list-"));
  const databasePath = join(directory, "inventory.sqlite");
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const repository = new SqliteInventoryRepository(databasePath);
  await repository.seedInventoryItem(
    createInventoryItem({ id: "inventory-z", lifecycleStatus: "unopened" }),
  );
  await repository.seedInventoryItem(
    createInventoryItem({ id: "inventory-a", lifecycleStatus: "finished" }),
  );

  const items = await repository.findAll();

  assert.deepEqual(
    items.map((item) => item.id),
    ["inventory-a", "inventory-z"],
  );
  repository.close();
});

test("SQLite migrates a legacy inventory database without changing its row", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-legacy-"));
  const databasePath = join(directory, "inventory.sqlite");
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE inventory_items (
      id TEXT PRIMARY KEY,
      lifecycle_status TEXT NOT NULL,
      opened_on TEXT,
      expires_on TEXT,
      pao_duration_months INTEGER,
      pao_deadline TEXT,
      usable_until TEXT
    ) STRICT;
    INSERT INTO inventory_items VALUES (
      'legacy-bottle',
      'opened',
      '2026-08-18',
      '2027-01-31',
      6,
      '2027-02-18',
      '2027-01-31'
    );
  `);
  legacy.close();

  const repository = new SqliteInventoryRepository(databasePath);
  const item = await repository.findById("legacy-bottle");

  assert.deepEqual(item, {
    id: "legacy-bottle",
    productId: null,
    createdAt: null,
    lifecycleStatus: "opened",
    openedOn: "2026-08-18",
    openedOnAccuracy: "legacy_unknown",
    expiresOn: "2027-01-31",
    paoDurationMonths: 6,
    paoDeadline: "2027-02-18",
    usableUntil: "2027-01-31",
    customNotes: null,
  });
  repository.close();
});

test("SQLite adds a nullable image reference to an existing Product table", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-product-image-"));
  const databasePath = join(directory, "inventory.sqlite");
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      size_label TEXT
    ) STRICT;
    CREATE TABLE inventory_items (
      id TEXT PRIMARY KEY,
      product_id TEXT REFERENCES products(id),
      lifecycle_status TEXT NOT NULL,
      opened_on TEXT,
      expires_on TEXT,
      pao_duration_months INTEGER,
      pao_deadline TEXT,
      usable_until TEXT
    ) STRICT;
    INSERT INTO products VALUES (
      'legacy-product',
      'Legacy product',
      'serum',
      '30 ml'
    );
    INSERT INTO inventory_items VALUES (
      'legacy-product-bottle',
      'legacy-product',
      'unopened',
      NULL,
      '2027-01-31',
      NULL,
      NULL,
      '2027-01-31'
    );
  `);
  legacy.close();

  const repository = new SqliteInventoryRepository(databasePath);

  assert.deepEqual(await repository.findProductById("legacy-product"), {
    id: "legacy-product",
    name: "Legacy product",
    alias: null,
    brand: null,
    category: "serum",
    sizeLabel: "30 ml",
    imageAssetId: null,
    imageRef: null,
    ingredientListText: null,
    sharedNotes: null,
  });
  assert.equal(
    (await repository.findById("legacy-product-bottle"))?.productId,
    "legacy-product",
  );
  repository.close();
});

test("BD-DATA-002 migrates the 4ef93b5 schema without changing legacy image_ref", async (
  context,
) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-baseline-migration-"));
  const databasePath = join(directory, "inventory.sqlite");
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const baseline = new DatabaseSync(databasePath);
  baseline.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      category TEXT NOT NULL CHECK (length(trim(category)) > 0),
      size_label TEXT,
      image_ref TEXT
    ) STRICT;
    CREATE TABLE inventory_items (
      id TEXT PRIMARY KEY,
      product_id TEXT REFERENCES products(id),
      lifecycle_status TEXT NOT NULL,
      opened_on TEXT,
      expires_on TEXT,
      pao_duration_months INTEGER,
      pao_deadline TEXT,
      usable_until TEXT
    ) STRICT;
    INSERT INTO products VALUES (
      'baseline-product',
      'Baseline serum',
      'serum',
      '30 ml',
      '/local-assets/baseline.webp'
    );
    INSERT INTO inventory_items VALUES (
      'baseline-bottle',
      'baseline-product',
      'opened',
      '2026-08-01',
      '2027-01-01',
      6,
      '2027-02-01',
      '2027-01-01'
    );
  `);
  baseline.close();

  const repository = new SqliteInventoryRepository(databasePath);
  assert.deepEqual(await repository.findProductById("baseline-product"), {
    id: "baseline-product",
    name: "Baseline serum",
    alias: null,
    brand: null,
    category: "serum",
    sizeLabel: "30 ml",
    imageAssetId: null,
    imageRef: "/local-assets/baseline.webp",
    ingredientListText: null,
    sharedNotes: null,
  });
  assert.equal(
    (await repository.findById("baseline-bottle"))?.openedOnAccuracy,
    "legacy_unknown",
  );
  repository.close();

  const migrated = new DatabaseSync(databasePath);
  migrated.exec(
    "UPDATE products SET category = NULL WHERE id = 'baseline-product'",
  );
  const productRow = migrated
    .prepare(
      "SELECT category, image_ref FROM products WHERE id = 'baseline-product'",
    )
    .get() as { readonly category: string | null; readonly image_ref: string | null };
  const foreignKeyViolations = migrated
    .prepare("PRAGMA foreign_key_check")
    .all();
  assert.deepEqual({ ...productRow }, {
    category: null,
    image_ref: "/local-assets/baseline.webp",
  });
  assert.deepEqual(foreignKeyViolations, []);
  migrated.close();
});

test("BD-DATA-004 migrates managed-image production shape without changing associations", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-text-migration-"));
  const databasePath = join(directory, "inventory.sqlite");
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const previous = new DatabaseSync(databasePath);
  previous.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      size_label TEXT,
      image_asset_id TEXT REFERENCES image_assets(id),
      image_ref TEXT
    ) STRICT;
    CREATE TABLE inventory_items (
      id TEXT PRIMARY KEY,
      product_id TEXT REFERENCES products(id),
      lifecycle_status TEXT NOT NULL,
      opened_on TEXT,
      opened_on_accuracy TEXT,
      expires_on TEXT,
      pao_duration_months INTEGER,
      pao_deadline TEXT,
      usable_until TEXT
    ) STRICT;
    CREATE TABLE image_assets (
      id TEXT PRIMARY KEY,
      storage_key TEXT NOT NULL UNIQUE,
      media_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      status TEXT NOT NULL,
      product_id TEXT REFERENCES products(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO products VALUES (
      'managed-product', 'Managed serum', NULL, '30 ml', NULL, NULL
    );
    INSERT INTO image_assets VALUES (
      'managed-asset', 'managed/original.webp', 'image/webp', 321,
      'linked', 'managed-product', '2026-08-21T00:00:00.000Z',
      '2026-08-20T00:00:00.000Z'
    );
    UPDATE products SET image_asset_id = 'managed-asset'
    WHERE id = 'managed-product';
    INSERT INTO inventory_items VALUES (
      'managed-bottle', 'managed-product', 'unopened', NULL, NULL,
      '2027-08-20', NULL, NULL, '2027-08-20'
    );
  `);
  previous.close();

  const migrated = new SqliteInventoryRepository(databasePath);
  assert.deepEqual(await migrated.findProductById("managed-product"), {
    id: "managed-product",
    name: "Managed serum",
    alias: null,
    brand: null,
    category: null,
    sizeLabel: "30 ml",
    imageAssetId: "managed-asset",
    imageRef: null,
    ingredientListText: null,
    sharedNotes: null,
  });
  assert.equal(
    (await migrated.findImageAssetById("managed-asset"))?.productId,
    "managed-product",
  );
  const migratedBottle = await migrated.findById("managed-bottle");
  assert.equal(migratedBottle?.customNotes, null);
  assert.equal(migratedBottle?.createdAt, "2026-08-20T00:00:00.000Z");
  migrated.close();

  const reopened = new SqliteInventoryRepository(databasePath);
  assert.equal(
    (await reopened.findProductById("managed-product"))?.imageAssetId,
    "managed-asset",
  );
  assert.equal(
    (await reopened.findById("managed-bottle"))?.createdAt,
    "2026-08-20T00:00:00.000Z",
  );
  reopened.close();
});

test("local import is idempotent and preserves shared product relationships", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const product = createProduct({
    id: "product-imported",
    name: "Example product",
    category: "serum",
    sizeLabel: "30 ml",
    ingredientListText: "Water, Glycerin",
    sharedNotes: "Imported shared notes",
  });
  const inventoryItems = [
    createInventoryItem({
      id: "imported-bottle-1",
      productId: product.id,
      lifecycleStatus: "unopened",
      customNotes: "Imported bottle one",
    }),
    createInventoryItem({
      id: "imported-bottle-2",
      productId: product.id,
      lifecycleStatus: "unopened",
      customNotes: "Imported bottle two",
    }),
  ];

  const first = await repository.importInventoryData({
    products: [product],
    inventoryItems,
  });
  const second = await repository.importInventoryData({
    products: [product],
    inventoryItems,
  });

  assert.deepEqual(first, {
    productsInserted: 1,
    productsExisting: 0,
    inventoryItemsInserted: 2,
    inventoryItemsExisting: 0,
  });
  assert.deepEqual(second, {
    productsInserted: 0,
    productsExisting: 1,
    inventoryItemsInserted: 0,
    inventoryItemsExisting: 2,
  });
  assert.equal((await repository.findAll()).length, 2);
  assert.deepEqual(await repository.findProductById(product.id), product);
  repository.close();
});

test("a conflicting import rolls back every new row", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const existingProduct = createProduct({
    id: "product-existing",
    name: "Original name",
    category: "serum",
  });
  await repository.importInventoryData({
    products: [existingProduct],
    inventoryItems: [],
  });

  await assert.rejects(
    repository.importInventoryData({
      products: [
        createProduct({
          id: "product-new-before-conflict",
          name: "Should roll back",
          category: "cream",
        }),
        createProduct({
          ...existingProduct,
          name: "Conflicting name",
        }),
      ],
      inventoryItems: [],
    }),
    /already exists with different data/,
  );

  assert.equal(
    await repository.findProductById("product-new-before-conflict"),
    null,
  );
  assert.deepEqual(
    await repository.findProductById(existingProduct.id),
    existingProduct,
  );
  repository.close();
});

test("BD-DATA-002 inventory fact update and readback are one repository transaction", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  await repository.seedInventoryItem(
    createInventoryItem({
      id: "concurrent-update",
      createdAt: "2026-08-19T00:00:00.000Z",
      lifecycleStatus: "unopened",
    }),
  );
  const firstState = createInventoryItem({
    id: "concurrent-update",
    lifecycleStatus: "unopened",
    expiresOn: "2027-01-01",
  });
  const secondState = createInventoryItem({
    id: "concurrent-update",
    lifecycleStatus: "unopened",
    expiresOn: "2028-02-02",
  });

  const [firstResult, secondResult] = await Promise.all([
    repository.updateInventoryItemFacts(firstState),
    repository.updateInventoryItemFacts(secondState),
  ]);

  assert.equal(firstResult.expiresOn, "2027-01-01");
  assert.equal(secondResult.expiresOn, "2028-02-02");
  assert.equal(firstResult.createdAt, "2026-08-19T00:00:00.000Z");
  assert.equal(secondResult.createdAt, "2026-08-19T00:00:00.000Z");
  assert.equal((await repository.findById("concurrent-update"))?.expiresOn, "2028-02-02");
  assert.equal(
    (await repository.findById("concurrent-update"))?.createdAt,
    "2026-08-19T00:00:00.000Z",
  );
  repository.close();
});

test("BD-DATA-002 image metadata collisions use stable errors and roll back staged peers", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const original = temporaryAsset({
    id: "asset-original",
    expiresAt: "2026-08-20T00:00:00.000Z",
  });
  await repository.stageImageAssets([original]);

  await assert.rejects(
    repository.stageImageAssets([
      { ...original, storageKey: "another-storage-key" },
    ]),
    hasBeautioCode("BATCH_CONFLICT"),
  );

  const peerBeforeConflict = temporaryAsset({
    id: "asset-peer",
    expiresAt: "2026-08-20T00:00:00.000Z",
  });
  const storageKeyCollision = temporaryAsset({
    id: "asset-storage-collision",
    expiresAt: "2026-08-20T00:00:00.000Z",
  });
  await assert.rejects(
    repository.stageImageAssets([
      peerBeforeConflict,
      { ...storageKeyCollision, storageKey: original.storageKey },
    ]),
    hasBeautioCode("BATCH_CONFLICT"),
  );

  assert.equal(await repository.findImageAssetById(peerBeforeConflict.id), null);
  assert.deepEqual(await repository.findImageAssetById(original.id), original);
  repository.close();
});

test("BD-DATA-002 image linking and cleanup claims stay mutually exclusive across connections", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-image-race-"));
  const databasePath = join(directory, "inventory.sqlite");
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const first = new SqliteInventoryRepository(databasePath);
  const second = new SqliteInventoryRepository(databasePath);
  const expiresAt = "2026-08-20T00:00:00.000Z";
  const linkWins = temporaryAsset({ id: "asset-link-wins", expiresAt });
  const cleanupWins = temporaryAsset({ id: "asset-cleanup-wins", expiresAt });
  await first.stageImageAssets([linkWins]);
  await first.activateStagedImageAssets([linkWins.id]);

  const productOne = createProduct({
    id: "product-link-wins",
    name: "Link wins",
    imageAssetId: linkWins.id,
  });
  const itemOne = createInventoryItem({
    id: "item-link-wins",
    productId: productOne.id,
    lifecycleStatus: "unopened",
  });
  const [, claimedAfterLink] = await Promise.all([
    first.createBatch({
      products: [productOne],
      inventoryItems: [itemOne],
      now: "2026-08-19T23:59:59.999Z",
    }),
    second.claimExpiredImageAssets(expiresAt),
  ]);
  assert.deepEqual(claimedAfterLink, []);
  assert.equal(
    (await second.findImageAssetById(linkWins.id))?.status,
    "linked",
  );

  await first.stageImageAssets([cleanupWins]);
  await first.activateStagedImageAssets([cleanupWins.id]);

  const productTwo = createProduct({
    id: "product-cleanup-wins",
    name: "Cleanup wins",
    imageAssetId: cleanupWins.id,
  });
  const itemTwo = createInventoryItem({
    id: "item-cleanup-wins",
    productId: productTwo.id,
    lifecycleStatus: "unopened",
  });
  const [claimResult, linkResult] = await Promise.allSettled([
    first.claimExpiredImageAssets(expiresAt),
    second.createBatch({
      products: [productTwo],
      inventoryItems: [itemTwo],
      now: "2026-08-19T23:59:59.999Z",
    }),
  ]);
  assert.equal(claimResult.status, "fulfilled");
  assert.equal(
    claimResult.status === "fulfilled" ? claimResult.value[0]?.id : null,
    cleanupWins.id,
  );
  assert.equal(linkResult.status, "rejected");
  assert.ok(
    linkResult.status === "rejected" &&
      linkResult.reason instanceof BeautioError &&
      linkResult.reason.code === "BATCH_CONFLICT",
  );
  assert.equal(await first.findProductById(productTwo.id), null);

  first.close();
  second.close();
});

test("BD-DATA-002 stale staging metadata becomes retryable cleanup work", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const asset = temporaryAsset({
    id: "asset-stale-staging",
    expiresAt: "2026-08-20T00:00:00.000Z",
  });
  await repository.stageImageAssets([asset]);

  assert.deepEqual(
    (await repository.claimExpiredImageAssets(asset.expiresAt)).map(
      (claimed) => claimed.id,
    ),
    [asset.id],
  );
  assert.equal(
    (await repository.findImageAssetById(asset.id))?.status,
    "pending_cleanup",
  );
  repository.close();
});

test("BD-DATA-002 creates a minimal Product and separate bottles, then survives reopen", async (
  context,
) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-batch-"));
  const databasePath = join(directory, "inventory.sqlite");
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const repository = new SqliteInventoryRepository(databasePath);
  const service = new InventoryApplicationService(repository, {
    idGenerator: sequentialIdGenerator(),
    clock: () => new Date("2026-08-19T00:00:00.000Z"),
  });

  const result = await service.createInventoryBatch({
    as_of: "2026-08-19",
    products: [
      {
        batch_ref: "product_1",
        name: "Example serum",
        alias: "Purple Jar",
        brand: "Beautio Lab",
      },
    ],
    inventory_items: [
      {
        batch_ref: "bottle_1",
        product_ref: { kind: "new", batch_ref: "product_1" },
        lifecycle_status: "opened",
        opened_on: "2026-08-01",
        opened_on_accuracy: "estimated",
        pao_duration_months: 6,
      },
      {
        batch_ref: "bottle_2",
        product_ref: { kind: "new", batch_ref: "product_1" },
        lifecycle_status: "unopened",
      },
    ],
  });

  assert.equal(result.products.length, 1);
  assert.equal(result.products[0]?.alias, "Purple Jar");
  assert.equal(result.products[0]?.brand, "Beautio Lab");
  assert.equal(result.products[0]?.category, null);
  assert.equal(result.products[0]?.size_label, null);
  assert.equal(result.products[0]?.image_asset_id, null);
  assert.equal(result.products[0]?.ingredient_list_text, null);
  assert.equal(result.products[0]?.shared_notes, null);
  assert.equal(result.inventory_items.length, 2);
  assert.notEqual(
    result.inventory_items[0]?.inventory_item_id,
    result.inventory_items[1]?.inventory_item_id,
  );
  assert.equal(result.inventory_items[0]?.opened_on_accuracy, "estimated");
  assert.equal(result.inventory_items[0]?.custom_notes, null);
  assert.equal(result.inventory_items[0]?.pao_deadline, "2027-02-01");
  assert.equal(
    result.inventory_items[0]?.pao_deadline_accuracy,
    "estimated",
  );
  repository.close();

  const reopened = new SqliteInventoryRepository(databasePath);
  const reopenedService = new InventoryApplicationService(reopened);
  const readback = await reopenedService.listInventory({
    as_of: "2026-08-19",
  });
  assert.equal(readback.items.length, 2);
  assert.equal(readback.items[0]?.product?.name, "Example serum");
  assert.equal(readback.items[0]?.product?.alias, "Purple Jar");
  assert.equal(readback.items[0]?.product?.brand, "Beautio Lab");
  assert.equal(readback.items[0]?.product_inventory_count, 2);
  assert.equal(readback.items[0]?.opened_on_accuracy, "estimated");
  assert.deepEqual(
    readback.items.map((item) => item.created_at),
    ["2026-08-19T00:00:00.000Z", "2026-08-19T00:00:00.000Z"],
  );
  const legacyUpdate = await reopenedService.updateProduct(
    result.products[0]?.product_id ?? "",
    {
      name: "Example serum renamed",
      category: null,
      size_label: null,
      image_asset_id: null,
      ingredient_list_text: null,
      shared_notes: null,
    },
  );
  assert.equal(legacyUpdate.product.alias, "Purple Jar");
  assert.equal(legacyUpdate.product.brand, "Beautio Lab");
  const explicitClear = await reopenedService.updateProduct(
    result.products[0]?.product_id ?? "",
    {
      name: "Example serum renamed",
      alias: null,
      brand: null,
      category: null,
      size_label: null,
      image_asset_id: null,
      ingredient_list_text: null,
      shared_notes: null,
    },
  );
  assert.equal(explicitClear.product.alias, null);
  assert.equal(explicitClear.product.brand, null);
  reopened.close();
});

test("BD-DATA-004 batch text survives repository restart with shared and per-bottle scope", async (
  context,
) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-notes-restart-"));
  const databasePath = join(directory, "inventory.sqlite");
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const repository = new SqliteInventoryRepository(databasePath);
  const service = new InventoryApplicationService(repository, {
    idGenerator: sequentialIdGenerator(),
    clock: () => new Date("2026-08-20T00:00:00.000Z"),
  });

  const result = await service.createInventoryBatch({
    as_of: "2026-08-20",
    products: [
      {
        batch_ref: "product_1",
        name: "Text serum",
        ingredient_list_text: "  Water,\nGlycerin, Niacinamide  ",
        shared_notes: "  Confirmed from the package  ",
      },
    ],
    inventory_items: [
      {
        batch_ref: "bottle_1",
        product_ref: { kind: "new", batch_ref: "product_1" },
        lifecycle_status: "unopened",
        custom_notes: "  First bottle  ",
      },
      {
        batch_ref: "bottle_2",
        product_ref: { kind: "new", batch_ref: "product_1" },
        lifecycle_status: "opened",
        opened_on: "2026-08-01",
        opened_on_accuracy: "estimated",
        custom_notes: "Second bottle",
      },
    ],
  });

  assert.equal(
    result.products[0]?.ingredient_list_text,
    "Water,\nGlycerin, Niacinamide",
  );
  assert.equal(result.products[0]?.shared_notes, "Confirmed from the package");
  assert.deepEqual(
    result.inventory_items.map((item) => item.custom_notes),
    ["First bottle", "Second bottle"],
  );
  const productId = result.products[0]?.product_id;
  assert.ok(productId);
  repository.close();

  const reopened = new SqliteInventoryRepository(databasePath);
  const reopenedService = new InventoryApplicationService(reopened);
  const list = await reopenedService.listInventory({ as_of: "2026-08-20" });
  assert.deepEqual(
    list.items.map((item) => item.custom_notes),
    ["First bottle", "Second bottle"],
  );
  assert.equal(
    list.items[0]?.product?.ingredient_list_text,
    "Water,\nGlycerin, Niacinamide",
  );
  assert.equal(
    (await reopened.findProductById(productId))?.sharedNotes,
    "Confirmed from the package",
  );
  reopened.close();
});

test("BD-DATA-004 invalid batch text leaves the complete SQLite batch absent", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const service = new InventoryApplicationService(repository, {
    idGenerator: sequentialIdGenerator(),
  });

  await assert.rejects(
    service.createInventoryBatch({
      as_of: "2026-08-20",
      products: [
        {
          batch_ref: "product_1",
          name: "Must not persist",
          ingredient_list_text: "i".repeat(5000),
        },
      ],
      inventory_items: [
        {
          batch_ref: "bottle_1",
          product_ref: { kind: "new", batch_ref: "product_1" },
          lifecycle_status: "unopened",
          custom_notes: "valid peer",
        },
        {
          batch_ref: "bottle_2",
          product_ref: { kind: "new", batch_ref: "product_1" },
          lifecycle_status: "unopened",
          custom_notes: "x".repeat(1001),
        },
      ],
    }),
    hasBeautioCode("INVALID_INPUT"),
  );

  assert.deepEqual(await repository.findAll(), []);
  assert.equal(await repository.findProductById("product-1"), null);
  repository.close();
});

test("BD-DATA-004 maximum legal text batch stays below the existing 1 MiB boundary", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const service = new InventoryApplicationService(repository, {
    idGenerator: sequentialIdGenerator(),
  });
  const products = Array.from({ length: 25 }, (_, index) => ({
    batch_ref: `product_${index}`,
    name: `Product ${index}`,
    ingredient_list_text: "成".repeat(5000),
    shared_notes: "共".repeat(1000),
  }));
  const inventoryItems = Array.from({ length: 100 }, (_, index) => ({
    batch_ref: `bottle_${index}`,
    product_ref: {
      kind: "new" as const,
      batch_ref: `product_${Math.floor(index / 4)}`,
    },
    lifecycle_status: "unopened" as const,
    custom_notes: "瓶".repeat(1000),
  }));
  const input = {
    as_of: "2026-08-20",
    products,
    inventory_items: inventoryItems,
  };

  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 1024 * 1024);
  const output = await service.createInventoryBatch(input);

  assert.equal(output.products.length, 25);
  assert.equal(output.inventory_items.length, 100);
  assert.equal(output.products[24]?.ingredient_list_text?.length, 5000);
  assert.equal(output.inventory_items[99]?.custom_notes?.length, 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) < 1024 * 1024);
  repository.close();
});

test("BD-DATA-004 custom notes update preserves terminal facts and sibling notes", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const product = createProduct({
    id: "product-terminal-notes",
    name: "Terminal notes",
    ingredientListText: "Water",
    sharedNotes: "Shared facts",
  });
  const finished = createInventoryItem({
    id: "bottle-finished-notes",
    productId: product.id,
    lifecycleStatus: "finished",
    expiresOn: "2027-01-01",
    paoDurationMonths: 6,
    customNotes: "Finished before",
  });
  const discarded = createInventoryItem({
    id: "bottle-discarded-notes",
    productId: product.id,
    lifecycleStatus: "discarded",
    expiresOn: "2027-02-02",
    customNotes: "Discarded sibling",
  });
  await repository.importInventoryData({
    products: [product],
    inventoryItems: [finished, discarded],
  });
  const service = new InventoryApplicationService(repository);

  await service.updateProduct(product.id, {
    name: product.name,
    alias: "Purple Jar",
    brand: "Beautio Lab",
    category: null,
    size_label: null,
    image_asset_id: null,
    ingredient_list_text: "Water, Glycerin",
    shared_notes: "Updated shared facts",
  });
  const sharedReadback = await service.listInventory({ as_of: "2026-08-20" });
  assert.deepEqual(
    sharedReadback.items.map((item) => item.product?.shared_notes),
    ["Updated shared facts", "Updated shared facts"],
  );

  assert.deepEqual(
    await service.updateInventoryItemCustomNotes(finished.id, {
      custom_notes: "  Finished after  ",
    }),
    {
      inventory_item: {
        inventory_item_id: finished.id,
        custom_notes: "Finished after",
      },
    },
  );
  const updated = await repository.findById(finished.id);
  assert.ok(updated);
  assert.deepEqual({ ...updated, customNotes: finished.customNotes }, finished);
  assert.equal(
    (await repository.findById(discarded.id))?.customNotes,
    "Discarded sibling",
  );
  assert.equal(
    (await repository.findProductById(product.id))?.sharedNotes,
    "Updated shared facts",
  );

  assert.deepEqual(
    await service.updateInventoryItemCustomNotes(finished.id, {
      custom_notes: "   ",
    }),
    {
      inventory_item: {
        inventory_item_id: finished.id,
        custom_notes: null,
      },
    },
  );
  await assert.rejects(
    service.updateInventoryItemCustomNotes("missing-bottle", {
      custom_notes: "No implicit create",
    }),
    hasBeautioCode("INVENTORY_ITEM_NOT_FOUND"),
  );
  repository.close();
});

test("BD-DATA-002 generated-ID collision rolls back the complete batch", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  let inventorySequence = 0;
  const service = new InventoryApplicationService(repository, {
    idGenerator: (kind) =>
      kind === "product"
        ? "duplicate-product-id"
        : `${kind}-${(inventorySequence += 1)}`,
  });

  await assert.rejects(
    service.createInventoryBatch({
      as_of: "2026-08-19",
      products: [
        { batch_ref: "product_1", name: "Serum" },
        { batch_ref: "product_2", name: "Cream" },
      ],
      inventory_items: [
        {
          batch_ref: "bottle_1",
          product_ref: { kind: "new", batch_ref: "product_1" },
          lifecycle_status: "unopened",
        },
        {
          batch_ref: "bottle_2",
          product_ref: { kind: "new", batch_ref: "product_2" },
          lifecycle_status: "unopened",
        },
      ],
    }),
    hasBeautioCode("BATCH_CONFLICT"),
  );

  assert.equal(
    await repository.findProductById("duplicate-product-id"),
    null,
  );
  assert.deepEqual(await repository.findAll(), []);
  repository.close();
});

test("BD-DATA-002 image claim conflicts roll back Product rows and preserve the temporary asset", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const asset = temporaryAsset({
    id: "asset-shared",
    expiresAt: "2026-08-20T00:00:00.000Z",
  });
  await repository.stageImageAssets([asset]);
  await repository.activateStagedImageAssets([asset.id]);
  const service = new InventoryApplicationService(repository, {
    idGenerator: sequentialIdGenerator(),
    clock: () => new Date("2026-08-19T00:00:00.000Z"),
  });

  await assert.rejects(
    service.createInventoryBatch({
      as_of: "2026-08-19",
      products: [
        {
          batch_ref: "product_1",
          name: "Serum",
          image_asset_id: asset.id,
        },
        {
          batch_ref: "product_2",
          name: "Cream",
          image_asset_id: asset.id,
        },
      ],
      inventory_items: [
        {
          batch_ref: "bottle_1",
          product_ref: { kind: "new", batch_ref: "product_1" },
          lifecycle_status: "unopened",
        },
        {
          batch_ref: "bottle_2",
          product_ref: { kind: "new", batch_ref: "product_2" },
          lifecycle_status: "unopened",
        },
      ],
    }),
    hasBeautioCode("BATCH_CONFLICT"),
  );

  assert.deepEqual(await repository.findAll(), []);
  assert.equal((await repository.findImageAssetById(asset.id))?.status, "temporary");
  assert.equal((await repository.findImageAssetById(asset.id))?.productId, null);
  repository.close();
});

test("BD-DATA-002 replacing a Product image atomically restarts the old asset cleanup window", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const oldAsset = temporaryAsset({
    id: "asset-old",
    expiresAt: "2026-08-20T00:00:00.000Z",
  });
  const newAsset = temporaryAsset({
    id: "asset-new",
    expiresAt: "2026-08-20T00:00:00.000Z",
  });
  const expiredAsset = temporaryAsset({
    id: "asset-expired",
    expiresAt: "2026-08-19T03:00:00.000Z",
  });
  await repository.stageImageAssets([oldAsset, newAsset, expiredAsset]);
  await repository.activateStagedImageAssets([
    oldAsset.id,
    newAsset.id,
    expiredAsset.id,
  ]);
  const service = new InventoryApplicationService(repository, {
    idGenerator: sequentialIdGenerator(),
    clock: () => new Date("2026-08-19T03:00:00.000Z"),
  });
  const created = await service.createInventoryBatch({
    as_of: "2026-08-19",
    products: [
      {
        batch_ref: "product_1",
        name: "Serum",
        image_asset_id: oldAsset.id,
      },
    ],
    inventory_items: [
      {
        batch_ref: "bottle_1",
        product_ref: { kind: "new", batch_ref: "product_1" },
        lifecycle_status: "unopened",
      },
    ],
  });
  const productId = created.products[0]?.product_id;
  assert.ok(productId);

  await assert.rejects(
    service.updateProduct(productId, {
      name: "This edit must roll back",
      alias: null,
      brand: null,
      category: null,
      size_label: null,
      image_asset_id: expiredAsset.id,
      ingredient_list_text: "Old ingredients",
      shared_notes: "Old shared notes",
    }),
    hasBeautioCode("IMAGE_ASSET_EXPIRED"),
  );
  assert.equal(
    (await repository.findProductById(productId))?.imageAssetId,
    oldAsset.id,
  );
  assert.equal((await repository.findImageAssetById(oldAsset.id))?.status, "linked");
  const expiredWork = await repository.claimExpiredImageAssets(
    "2026-08-19T03:00:00.000Z",
  );
  assert.deepEqual(expiredWork.map((asset) => asset.id), [expiredAsset.id]);
  await repository.deleteClaimedImageAsset(expiredAsset.id);

  await service.updateProduct(productId, {
    name: "Serum renamed",
    alias: "Purple Jar",
    brand: "Beautio Lab",
    category: null,
    size_label: null,
    image_asset_id: newAsset.id,
    ingredient_list_text: "Water, Glycerin",
    shared_notes: "Confirmed package",
  });

  assert.deepEqual(await repository.findProductById(productId), {
    id: productId,
    name: "Serum renamed",
    alias: "Purple Jar",
    brand: "Beautio Lab",
    category: null,
    sizeLabel: null,
    imageAssetId: newAsset.id,
    imageRef: null,
    ingredientListText: "Water, Glycerin",
    sharedNotes: "Confirmed package",
  });
  assert.equal((await repository.findImageAssetById(newAsset.id))?.status, "linked");
  assert.deepEqual(
    await repository.findImageAssetById(oldAsset.id),
    {
      ...oldAsset,
      status: "temporary",
      expiresAt: "2026-08-20T03:00:00.000Z",
    },
  );
  assert.equal(
    (await repository.claimExpiredImageAssets("2026-08-20T02:59:59.999Z"))
      .length,
    0,
  );
  assert.equal(
    (await repository.claimExpiredImageAssets("2026-08-20T03:00:00.000Z"))
      .length,
    1,
  );
  assert.equal((await repository.findImageAssetById(newAsset.id))?.status, "linked");
  repository.close();
});

test("setting a shared Product display image preserves facts and transfers managed image ownership", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const product = createProduct({
    id: "product-shared-display",
    name: "Original serum name",
    category: "serum",
    sizeLabel: "30 ml",
    imageRef: "legacy-audit-value",
    ingredientListText: "Water, Glycerin",
    sharedNotes: "Keep these shared facts",
  });
  await repository.importInventoryData({
    products: [product],
    inventoryItems: [],
  });
  const oldAsset = temporaryAsset({
    id: "asset-shared-old",
    expiresAt: "2026-08-21T00:00:00.000Z",
  });
  const newAsset = temporaryAsset({
    id: "asset-shared-new",
    expiresAt: "2026-08-21T00:00:00.000Z",
  });
  await repository.stageImageAssets([oldAsset, newAsset]);
  await repository.activateStagedImageAssets([oldAsset.id, newAsset.id]);
  await repository.setProductDisplayImage({
    productId: product.id,
    imageAssetId: oldAsset.id,
    now: "2026-08-20T02:03:04.000Z",
    unlinkedExpiresAt: "2026-08-21T02:03:04.000Z",
  });

  const updated = await repository.setProductDisplayImage({
    productId: product.id,
    imageAssetId: newAsset.id,
    now: "2026-08-20T03:04:05.000Z",
    unlinkedExpiresAt: "2026-08-21T03:04:05.000Z",
  });

  assert.deepEqual(updated, {
    ...product,
    imageAssetId: newAsset.id,
  });
  assert.deepEqual(await repository.findProductById(product.id), updated);
  assert.deepEqual(await repository.findImageAssetById(oldAsset.id), {
    ...oldAsset,
    status: "temporary",
    expiresAt: "2026-08-21T03:04:05.000Z",
  });
  assert.deepEqual(await repository.findImageAssetById(newAsset.id), {
    ...newAsset,
    status: "linked",
    productId: product.id,
  });

  const sameImageRetry = await repository.setProductDisplayImage({
    productId: product.id,
    imageAssetId: newAsset.id,
    now: "2026-08-20T04:05:06.000Z",
    unlinkedExpiresAt: "2026-08-21T04:05:06.000Z",
  });
  assert.deepEqual(sameImageRetry, updated);
  assert.deepEqual(await repository.findImageAssetById(newAsset.id), {
    ...newAsset,
    status: "linked",
    productId: product.id,
  });
  repository.close();
});

test("setting a Product display image rejects missing Products and unavailable assets without partial writes", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const owner = createProduct({
    id: "product-image-owner",
    name: "Image owner",
  });
  const target = createProduct({
    id: "product-image-target",
    name: "Image target",
    category: "cream",
    sizeLabel: "50 ml",
  });
  await repository.importInventoryData({
    products: [owner, target],
    inventoryItems: [],
  });
  const availableAsset = temporaryAsset({
    id: "asset-for-missing-product",
    expiresAt: "2026-08-21T00:00:00.000Z",
  });
  const expiredAsset = temporaryAsset({
    id: "asset-expired-for-display",
    expiresAt: "2026-08-20T00:00:00.000Z",
  });
  const ownedAsset = temporaryAsset({
    id: "asset-owned-display",
    expiresAt: "2026-08-21T00:00:00.000Z",
  });
  const targetOldAsset = temporaryAsset({
    id: "asset-target-old-display",
    expiresAt: "2026-08-21T00:00:00.000Z",
  });
  await repository.stageImageAssets([
    availableAsset,
    expiredAsset,
    ownedAsset,
    targetOldAsset,
  ]);
  await repository.activateStagedImageAssets([
    availableAsset.id,
    expiredAsset.id,
    ownedAsset.id,
    targetOldAsset.id,
  ]);
  const timestamps = {
    now: "2026-08-20T00:00:00.000Z",
    unlinkedExpiresAt: "2026-08-21T00:00:00.000Z",
  } as const;
  await repository.setProductDisplayImage({
    productId: target.id,
    imageAssetId: targetOldAsset.id,
    ...timestamps,
  });

  await assert.rejects(
    repository.setProductDisplayImage({
      productId: "product-missing",
      imageAssetId: availableAsset.id,
      ...timestamps,
    }),
    hasBeautioCode("PRODUCT_NOT_FOUND"),
  );
  assert.deepEqual(
    await repository.findImageAssetById(availableAsset.id),
    { ...availableAsset, status: "temporary" },
  );

  await assert.rejects(
    repository.setProductDisplayImage({
      productId: target.id,
      imageAssetId: "asset-does-not-exist",
      ...timestamps,
    }),
    hasBeautioCode("IMAGE_ASSET_NOT_FOUND"),
  );
  await assert.rejects(
    repository.setProductDisplayImage({
      productId: target.id,
      imageAssetId: expiredAsset.id,
      ...timestamps,
    }),
    hasBeautioCode("IMAGE_ASSET_EXPIRED"),
  );

  await repository.setProductDisplayImage({
    productId: owner.id,
    imageAssetId: ownedAsset.id,
    ...timestamps,
  });
  await assert.rejects(
    repository.setProductDisplayImage({
      productId: target.id,
      imageAssetId: ownedAsset.id,
      ...timestamps,
    }),
    hasBeautioCode("BATCH_CONFLICT"),
  );

  assert.deepEqual(await repository.findProductById(target.id), {
    ...target,
    imageAssetId: targetOldAsset.id,
  });
  assert.deepEqual(await repository.findImageAssetById(targetOldAsset.id), {
    ...targetOldAsset,
    status: "linked",
    productId: target.id,
  });
  assert.deepEqual(await repository.findProductById(owner.id), {
    ...owner,
    imageAssetId: ownedAsset.id,
  });
  assert.deepEqual(await repository.findImageAssetById(ownedAsset.id), {
    ...ownedAsset,
    status: "linked",
    productId: owner.id,
  });
  repository.close();
});

test("same-image retry rejects an inconsistent Product-to-asset association", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-image-consistency-"));
  const databasePath = join(directory, "inventory.sqlite");
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const repository = new SqliteInventoryRepository(databasePath);
  const product = createProduct({
    id: "product-inconsistent-image",
    name: "Consistency check",
  });
  await repository.importInventoryData({
    products: [product],
    inventoryItems: [],
  });
  const asset = temporaryAsset({
    id: "asset-inconsistent-image",
    expiresAt: "2026-08-21T00:00:00.000Z",
  });
  await repository.stageImageAssets([asset]);
  await repository.activateStagedImageAssets([asset.id]);

  const rawDatabase = new DatabaseSync(databasePath);
  rawDatabase
    .prepare("UPDATE products SET image_asset_id = ? WHERE id = ?")
    .run(asset.id, product.id);
  rawDatabase.close();

  await assert.rejects(
    repository.setProductDisplayImage({
      productId: product.id,
      imageAssetId: asset.id,
      now: "2026-08-20T00:00:00.000Z",
      unlinkedExpiresAt: "2026-08-21T00:00:00.000Z",
    }),
    hasBeautioCode("BATCH_CONFLICT"),
  );
  assert.deepEqual(await repository.findImageAssetById(asset.id), {
    ...asset,
    status: "temporary",
  });
  repository.close();
});

test("BD-DATA-002 failed multi-image upload leaves retryable metadata and cleanup removes it", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const storage = new FailingMemoryStorage();
  const service = new InventoryApplicationService(repository, {
    idGenerator: sequentialIdGenerator(),
    clock: () => new Date("2026-08-19T00:00:00.000Z"),
    imageStorage: storage,
    imageInspector: fixedImageInspector,
  });

  await assert.rejects(
    service.uploadProductImages([
      { source_ref: "front", bytes: new Uint8Array([1, 2, 3]) },
      { source_ref: "side", bytes: new Uint8Array([4, 5, 6]) },
    ]),
    hasBeautioCode("UPLOAD_FAILED"),
  );
  assert.equal(
    (await repository.findImageAssetById("image_asset-1"))?.status,
    "pending_cleanup",
  );
  assert.equal(
    (await repository.findImageAssetById("image_asset-2"))?.status,
    "pending_cleanup",
  );
  await assert.rejects(
    service.readImageAsset("image_asset-1"),
    hasBeautioCode("IMAGE_ASSET_EXPIRED"),
  );
  await assert.rejects(
    service.createInventoryBatch({
      as_of: "2026-08-19",
      products: [
        {
          batch_ref: "product_1",
          name: "Must roll back",
          image_asset_id: "image_asset-1",
        },
      ],
      inventory_items: [
        {
          batch_ref: "bottle_1",
          product_ref: { kind: "new", batch_ref: "product_1" },
          lifecycle_status: "unopened",
        },
      ],
    }),
    hasBeautioCode("BATCH_CONFLICT"),
  );
  assert.equal(await repository.findProductById("product-1"), null);

  const failedCleanup = await service.cleanupExpiredImageAssets();
  assert.deepEqual(failedCleanup, { claimed: 2, deleted: 0, failed: 2 });
  assert.equal(
    (await repository.findImageAssetById("image_asset-1"))?.status,
    "pending_cleanup",
  );

  storage.allowDeletes = true;
  const cleanup = await service.cleanupExpiredImageAssets();
  assert.deepEqual(cleanup, { claimed: 2, deleted: 2, failed: 0 });
  assert.equal(await repository.findImageAssetById("image_asset-1"), null);
  assert.equal(await repository.findImageAssetById("image_asset-2"), null);
  repository.close();
});

test("BD-DATA-002 aborted upload compensates staged metadata and written bytes", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const controller = new AbortController();
  const storage = new AbortingMemoryStorage(controller);
  const service = new InventoryApplicationService(repository, {
    idGenerator: sequentialIdGenerator(),
    clock: () => new Date("2026-08-19T00:00:00.000Z"),
    imageStorage: storage,
    imageInspector: fixedImageInspector,
  });

  await assert.rejects(
    service.uploadProductImages(
      [{ source_ref: "front", bytes: new Uint8Array([1, 2, 3]) }],
      { signal: controller.signal },
    ),
    hasBeautioCode("UPLOAD_FAILED"),
  );
  assert.equal(await repository.findImageAssetById("image_asset-1"), null);
  assert.equal(storage.files.size, 0);
  repository.close();
});

test("BD-DATA-002 cleanup deletes unlinked assets exactly at 24h and never deletes linked assets", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const storage = new MemoryStorage();
  let now = "2026-08-19T00:00:00.000Z";
  const service = new InventoryApplicationService(repository, {
    idGenerator: sequentialIdGenerator(),
    clock: () => new Date(now),
    imageStorage: storage,
    imageInspector: fixedImageInspector,
  });

  const unlinked = await service.uploadProductImages([
    { source_ref: "unlinked", bytes: new Uint8Array([1, 2, 3]) },
  ]);
  const unlinkedId = unlinked.assets[0]?.image_asset_id;
  assert.ok(unlinkedId);
  now = "2026-08-19T23:59:59.999Z";
  assert.deepEqual(await service.cleanupExpiredImageAssets(), {
    claimed: 0,
    deleted: 0,
    failed: 0,
  });
  assert.ok(await repository.findImageAssetById(unlinkedId));

  now = "2026-08-20T00:00:00.000Z";
  assert.deepEqual(await service.cleanupExpiredImageAssets(), {
    claimed: 1,
    deleted: 1,
    failed: 0,
  });
  assert.equal(await repository.findImageAssetById(unlinkedId), null);

  const linkedUpload = await service.uploadProductImages([
    { source_ref: "linked", bytes: new Uint8Array([4, 5, 6]) },
  ]);
  const linkedId = linkedUpload.assets[0]?.image_asset_id;
  assert.ok(linkedId);
  const batch = await service.createInventoryBatch({
    as_of: "2026-08-20",
    products: [
      {
        batch_ref: "product_1",
        name: "Linked image Product",
        image_asset_id: linkedId,
      },
    ],
    inventory_items: [
      {
        batch_ref: "bottle_1",
        product_ref: { kind: "new", batch_ref: "product_1" },
        lifecycle_status: "unopened",
      },
    ],
  });
  assert.equal(batch.products[0]?.image_asset_id, linkedId);

  now = "2026-08-22T00:00:00.000Z";
  assert.deepEqual(await service.cleanupExpiredImageAssets(), {
    claimed: 0,
    deleted: 0,
    failed: 0,
  });
  assert.equal((await repository.findImageAssetById(linkedId))?.status, "linked");
  assert.ok(storage.files.size > 0);
  repository.close();
});

test("restore retires staging, temporary, and pending-cleanup image files without orphaning them", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const storage = new MemoryStorage();
  const service = new InventoryApplicationService(repository, {
    idGenerator: sequentialIdGenerator(),
    clock: () => new Date("2026-08-30T00:00:00.000Z"),
    imageStorage: storage,
    imageInspector: fixedImageInspector,
  });
  const assets = [
    temporaryAsset({
      id: "old-staging",
      expiresAt: "2026-08-31T00:00:00.000Z",
    }),
    temporaryAsset({
      id: "old-temporary",
      expiresAt: "2026-08-31T00:00:00.000Z",
    }),
    temporaryAsset({
      id: "old-pending",
      expiresAt: "2026-08-31T00:00:00.000Z",
    }),
    temporaryAsset({
      id: "old-linked",
      expiresAt: "2026-08-31T00:00:00.000Z",
    }),
  ];
  await repository.stageImageAssets(assets);
  await repository.activateStagedImageAssets([
    "old-temporary",
    "old-pending",
    "old-linked",
  ]);
  await repository.markImageAssetsForCleanup(["old-pending"]);
  await service.createInventoryBatch({
    as_of: "2026-08-30",
    products: [
      {
        batch_ref: "old-linked-product",
        name: "Old linked Product",
        image_asset_id: "old-linked",
      },
    ],
    inventory_items: [
      {
        batch_ref: "old-linked-bottle",
        product_ref: { kind: "new", batch_ref: "old-linked-product" },
        lifecycle_status: "unopened",
      },
    ],
  });
  for (const asset of assets) {
    await storage.put(asset.storageKey, new Uint8Array([1, 2, 3]));
  }

  assert.deepEqual(
    await service.restoreBackup({
      format: "beautio-backup",
      version: 1,
      created_at: "2026-08-30T00:00:00.000Z",
      products: [],
      inventory_items: [],
      images: [],
    }),
    { restored: true, products: 0, inventory_items: 0, images: 0 },
  );

  assert.equal(storage.files.size, 0);
  for (const asset of assets) {
    assert.equal(await repository.findImageAssetById(asset.id), null);
  }
  assert.deepEqual(
    await repository.claimExpiredImageAssets("2026-08-30T00:00:00.000Z"),
    [],
  );
  repository.close();
});

test("restore keeps failed displaced-image deletion as retryable pending cleanup", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const storage = new DeleteFailingMemoryStorage();
  const service = new InventoryApplicationService(repository, {
    idGenerator: sequentialIdGenerator(),
    clock: () => new Date("2026-08-30T00:00:00.000Z"),
    imageStorage: storage,
    imageInspector: fixedImageInspector,
  });
  const asset = temporaryAsset({
    id: "old-retryable",
    expiresAt: "2026-08-31T00:00:00.000Z",
  });
  await repository.stageImageAssets([asset]);
  await repository.activateStagedImageAssets([asset.id]);
  await service.createInventoryBatch({
    as_of: "2026-08-30",
    products: [
      {
        batch_ref: "old-retryable-product",
        name: "Old retryable linked Product",
        image_asset_id: asset.id,
      },
    ],
    inventory_items: [
      {
        batch_ref: "old-retryable-bottle",
        product_ref: { kind: "new", batch_ref: "old-retryable-product" },
        lifecycle_status: "unopened",
      },
    ],
  });
  await storage.put(asset.storageKey, new Uint8Array([1, 2, 3]));

  await service.restoreBackup({
    format: "beautio-backup",
    version: 1,
    created_at: "2026-08-30T00:00:00.000Z",
    products: [],
    inventory_items: [],
    images: [],
  });

  const pending = await repository.claimExpiredImageAssets(
    "2026-08-30T00:00:00.000Z",
  );
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.storageKey, asset.storageKey);
  assert.equal(pending[0]?.status, "pending_cleanup");
  assert.equal(storage.files.has(asset.storageKey), true);

  storage.allowDeletes = true;
  assert.deepEqual(await service.cleanupExpiredImageAssets(), {
    claimed: 1,
    deleted: 1,
    failed: 0,
  });
  assert.equal(storage.files.size, 0);
  repository.close();
});

test("restore compensates new image files and metadata when a staged write fails", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const storage = new FailingMemoryStorage();
  storage.allowDeletes = true;
  const service = new InventoryApplicationService(repository, {
    idGenerator: sequentialIdGenerator(),
    clock: () => new Date("2026-08-30T00:00:00.000Z"),
    imageStorage: storage,
    imageInspector: fixedImageInspector,
  });
  const oldProduct = createProduct({
    id: "old-product",
    name: "Old Product remains",
  });
  await repository.importInventoryData({
    products: [oldProduct],
    inventoryItems: [],
  });
  const imageBytes = new Uint8Array([1, 2, 3]);
  const encoded = Buffer.from(imageBytes).toString("base64");
  const digest = createHash("sha256").update(imageBytes).digest("hex");
  const products = ["one", "two"].map((suffix) => ({
    product_id: `new-product-${suffix}`,
    name: `New Product ${suffix}`,
    alias: null,
    brand: null,
    category: null,
    size_label: null,
    image_asset_id: `new-image-${suffix}`,
    image_ref: null,
    ingredient_list_text: null,
    shared_notes: null,
  }));

  await assert.rejects(
    service.restoreBackup({
      format: "beautio-backup",
      version: 1,
      created_at: "2026-08-30T00:00:00.000Z",
      products,
      inventory_items: [],
      images: ["one", "two"].map((suffix) => ({
        image_asset_id: `new-image-${suffix}`,
        product_id: `new-product-${suffix}`,
        media_type: "image/png",
        byte_size: imageBytes.byteLength,
        sha256: digest,
        bytes_base64: encoded,
        created_at: "2026-08-30T00:00:00.000Z",
      })),
    }),
    /simulated second-file failure/u,
  );

  assert.deepEqual(await repository.findProductById(oldProduct.id), oldProduct);
  assert.equal(await repository.findProductById("new-product-one"), null);
  assert.equal(await repository.findImageAssetById("new-image-one"), null);
  assert.equal(storage.files.size, 0);
  assert.deepEqual(
    await repository.claimExpiredImageAssets("2026-08-30T00:00:00.000Z"),
    [],
  );
  repository.close();
});

test("backup export writes each metadata record and image with backpressure and stops on abort", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const storage = new MemoryStorage();
  const service = new InventoryApplicationService(repository, {
    idGenerator: sequentialIdGenerator(),
    clock: () => new Date("2026-08-30T00:00:00.000Z"),
    imageStorage: storage,
    imageInspector: fixedImageInspector,
  });
  const uploaded = await service.uploadProductImages([
    { source_ref: "first", bytes: new Uint8Array([1, 2, 3]) },
    { source_ref: "second", bytes: new Uint8Array([4, 5, 6]) },
  ]);
  await service.createInventoryBatch({
    as_of: "2026-08-30",
    products: uploaded.assets.map((asset, index) => ({
      batch_ref: `product_${index}`,
      name: `Product ${index}`,
      image_asset_id: asset.image_asset_id,
    })),
    inventory_items: uploaded.assets.map((_asset, index) => ({
      batch_ref: `bottle_${index}`,
      product_ref: { kind: "new" as const, batch_ref: `product_${index}` },
      lifecycle_status: "unopened" as const,
    })),
  });

  const plan = await service.prepareBackupExport();
  const chunks: string[] = [];
  await plan.writeTo(async (chunk) => {
    chunks.push(chunk);
  });
  assert.equal(chunks.length, 10);
  assert.equal(storage.getCalls.length, 2);
  const parsed = JSON.parse(chunks.join("")) as {
    readonly products: readonly unknown[];
    readonly inventory_items: readonly unknown[];
    readonly images: readonly unknown[];
  };
  assert.equal(parsed.products.length, 2);
  assert.equal(parsed.inventory_items.length, 2);
  assert.equal(parsed.images.length, 2);
  assert.equal(chunks.filter((chunk) => chunk.includes('"bytes_base64"')).length, 2);

  let releaseMetadataWrite!: () => void;
  const metadataWriteRelease = new Promise<void>((resolve) => {
    releaseMetadataWrite = resolve;
  });
  const blockedChunks: string[] = [];
  const blockedWrite = plan.writeTo(async (chunk) => {
    blockedChunks.push(chunk);
    if (blockedChunks.length === 2) {
      await metadataWriteRelease;
    }
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(blockedChunks.length, 2);
  releaseMetadataWrite();
  await blockedWrite;

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    service.prepareBackupExport({ signal: preAborted.signal }),
    hasBeautioCode("UPLOAD_FAILED"),
  );

  storage.getCalls.length = 0;
  const controller = new AbortController();
  let imageWrites = 0;
  await assert.rejects(
    plan.writeTo(
      async (chunk) => {
        if (chunk.includes('"bytes_base64"')) {
          imageWrites += 1;
          if (imageWrites === 1) controller.abort();
        }
      },
      { signal: controller.signal },
    ),
    hasBeautioCode("UPLOAD_FAILED"),
  );
  assert.equal(storage.getCalls.length, 1);
  repository.close();
});

function sequentialIdGenerator(): (kind: GeneratedIdKind) => string {
  const sequences = new Map<GeneratedIdKind, number>();
  return (kind) => {
    const next = (sequences.get(kind) ?? 0) + 1;
    sequences.set(kind, next);
    return `${kind}-${next}`;
  };
}

function temporaryAsset(input: {
  readonly id: string;
  readonly expiresAt: string;
}): ImageAsset {
  return {
    id: input.id,
    storageKey: `storage-${input.id}`,
    mediaType: "image/png",
    byteSize: 3,
    status: "staging",
    productId: null,
    expiresAt: input.expiresAt,
    createdAt: "2026-08-19T00:00:00.000Z",
  };
}

const fixedImageInspector: ImageInspector = {
  async inspect() {
    return {
      mediaType: "image/png",
      width: 1,
      height: 1,
      animated: false,
    };
  },
};

class FailingMemoryStorage implements ImageAssetStorage {
  readonly files = new Map<string, Uint8Array>();
  putCalls = 0;
  allowDeletes = false;

  async put(storageKey: string, bytes: Uint8Array): Promise<void> {
    this.putCalls += 1;
    if (this.putCalls === 2) {
      throw new Error("simulated second-file failure");
    }
    this.files.set(storageKey, bytes);
  }

  async get(storageKey: string): Promise<Uint8Array> {
    const bytes = this.files.get(storageKey);
    if (bytes === undefined) {
      throw new Error("missing file");
    }
    return bytes;
  }

  async delete(storageKey: string): Promise<void> {
    if (!this.allowDeletes) {
      throw new Error("simulated compensation delete failure");
    }
    this.files.delete(storageKey);
  }
}

class MemoryStorage implements ImageAssetStorage {
  readonly files = new Map<string, Uint8Array>();
  readonly getCalls: string[] = [];

  async put(storageKey: string, bytes: Uint8Array): Promise<void> {
    this.files.set(storageKey, bytes);
  }

  async get(storageKey: string): Promise<Uint8Array> {
    this.getCalls.push(storageKey);
    const bytes = this.files.get(storageKey);
    if (bytes === undefined) {
      throw new Error("missing file");
    }
    return bytes;
  }

  async delete(storageKey: string): Promise<void> {
    this.files.delete(storageKey);
  }
}

class DeleteFailingMemoryStorage extends MemoryStorage {
  allowDeletes = false;

  override async delete(storageKey: string): Promise<void> {
    if (!this.allowDeletes) {
      throw new Error("simulated displaced-image delete failure");
    }
    await super.delete(storageKey);
  }
}

class AbortingMemoryStorage implements ImageAssetStorage {
  readonly files = new Map<string, Uint8Array>();
  readonly #controller: AbortController;

  constructor(controller: AbortController) {
    this.#controller = controller;
  }

  async put(
    storageKey: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    this.files.set(storageKey, bytes);
    this.#controller.abort();
    if (signal?.aborted === true) {
      throw new Error("simulated deadline during file persistence");
    }
  }

  async get(storageKey: string): Promise<Uint8Array> {
    const bytes = this.files.get(storageKey);
    if (bytes === undefined) {
      throw new Error("missing file");
    }
    return bytes;
  }

  async delete(storageKey: string): Promise<void> {
    this.files.delete(storageKey);
  }
}

function hasBeautioCode(
  code: BeautioError["code"],
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof BeautioError);
    assert.equal(error.code, code);
    return true;
  };
}

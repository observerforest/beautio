import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  InventoryApplicationService,
  type InventoryBatchPersistenceInput,
  type RecordProductOpenedPersistenceInput,
  type RecordProductOpenedPersistenceResult,
} from "@beautio/application";
import { createInventoryItem, createProduct, type InventoryItem, type Product } from "@beautio/domain";
import { SqliteInventoryRepository } from "../src/index.ts";

test("creation inherits shared PAO and only infers an unambiguous legacy Product duration", async (context) => {
  const repository = new SqliteInventoryRepository(":memory:");
  context.after(() => repository.close());
  const service = new InventoryApplicationService(repository);
  const cases = [
    { shared: 6, durations: [null, 6], expectedShared: 6, expectedBottles: [6, 6] },
    { shared: undefined, durations: [null, 12, 12], expectedShared: 12, expectedBottles: [12, 12, 12] },
    { shared: undefined, durations: [6, 12], expectedShared: null, expectedBottles: [6, 12] },
    { shared: undefined, durations: [null], expectedShared: null, expectedBottles: [null] },
    { shared: null, durations: [6, 6], expectedShared: null, expectedBottles: [6, 6] },
  ];
  for (const example of cases) {
    const created = await service.createInventoryBatch({
      as_of: "2026-08-31",
      products: [{
        batch_ref: "sample",
        name: "Sample serum",
        ...(example.shared === undefined ? {} : { pao_duration_months: example.shared }),
      }],
      inventory_items: example.durations.map((duration, index) => ({
        batch_ref: `bottle_${index}`,
        product_ref: { kind: "new", batch_ref: "sample" },
        lifecycle_status: "opened",
        opened_on: "2026-01-31",
        opened_on_accuracy: "estimated",
        pao_duration_months: duration,
      })),
    });
    assert.equal(created.products[0]?.pao_duration_months, example.expectedShared);
    assert.deepEqual(created.inventory_items.map((item) => item.pao_duration_months), example.expectedBottles);
    assert.ok(created.inventory_items.every((item) =>
      item.pao_duration_months === null
        ? item.pao_deadline === null
        : item.pao_deadline === (item.pao_duration_months === 6 ? "2026-07-31" : "2027-01-31"),
    ));
  }
});

test("existing Product PAO rejects conflicting bottle input without leaving partial rows", async (context) => {
  const repository = new SqliteInventoryRepository(":memory:");
  context.after(() => repository.close());
  const product = createProduct({ id: "shared", name: "Sample serum", paoDurationMonths: 6 });
  await repository.importInventoryData({ products: [product], inventoryItems: [] });
  const service = new InventoryApplicationService(repository);
  const before = await repository.readBackupSnapshot();
  await assert.rejects(service.createInventoryBatch({
    as_of: "2026-08-31",
    products: [{ batch_ref: "peer", name: "Must roll back" }],
    inventory_items: [
      { batch_ref: "peer_bottle", product_ref: { kind: "new", batch_ref: "peer" }, lifecycle_status: "unopened" },
      { batch_ref: "conflict", product_ref: { kind: "existing", product_id: product.id }, lifecycle_status: "unopened", pao_duration_months: 12 },
    ],
  }), /conflicts with the shared Product PAO/u);
  assert.deepEqual(await repository.readBackupSnapshot(), before);

  const created = await service.createInventoryBatch({
    as_of: "2026-08-31", products: [], inventory_items: [{
      batch_ref: "inherited", product_ref: { kind: "existing", product_id: product.id }, lifecycle_status: "unopened",
    }],
  });
  assert.equal(created.inventory_items[0]?.pao_duration_months, 6);
  assert.deepEqual(await repository.findProductById(product.id), product);
  const bottleId = created.inventory_items[0]?.inventory_item_id;
  assert.ok(bottleId);
  await assert.rejects(service.updateInventoryItemFacts(bottleId, {
    as_of: "2026-08-31", lifecycle_status: "unopened", opened_on: null,
    opened_on_accuracy: null, expires_on: "2028-01-01", pao_duration_months: 12,
  }), /conflicts with the shared Product PAO/u);
  assert.equal((await repository.findById(bottleId))?.expiresOn, null);
});

test("explicit Product PAO changes recalculate every bottle while other Product edits preserve them", async (context) => {
  const repository = new SqliteInventoryRepository(":memory:");
  context.after(() => repository.close());
  const product = createProduct({ id: "shared", name: "Sample cream", paoDurationMonths: 12 });
  const bottles = [
    createInventoryItem({ id: "one", productId: product.id, lifecycleStatus: "opened", openedOn: "2026-01-31", openedOnAccuracy: "estimated", expiresOn: "2026-06-01", paoDurationMonths: 12, customNotes: "First note" }),
    createInventoryItem({ id: "two", productId: product.id, lifecycleStatus: "opened", openedOn: "2026-03-15", openedOnAccuracy: "exact", expiresOn: "2028-01-01", paoDurationMonths: 3 }),
    createInventoryItem({ id: "three", productId: product.id, lifecycleStatus: "finished", openedOn: "2026-08-01", paoDurationMonths: null }),
    createInventoryItem({ id: "four", productId: product.id, lifecycleStatus: "unopened", expiresOn: "2028-01-01" }),
  ];
  await repository.importInventoryData({ products: [product], inventoryItems: bottles });
  const service = new InventoryApplicationService(repository);
  await service.updateProduct(product.id, { ...productEdit(product), name: "Renamed sample" });
  assert.deepEqual(await repository.findAll(), [...bottles].sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal((await repository.findProductById(product.id))?.paoDurationMonths, 12);

  await service.updateProduct(product.id, { ...productEdit(product), pao_duration_months: 6 });
  for (const original of bottles) {
    const updated = await repository.findById(original.id);
    assert.ok(updated);
    assert.equal(updated.paoDurationMonths, 6);
    assert.equal(updated.expiresOn, original.expiresOn);
    assert.equal(updated.openedOn, original.openedOn);
    assert.equal(updated.openedOnAccuracy, original.openedOnAccuracy);
    assert.equal(updated.lifecycleStatus, original.lifecycleStatus);
    assert.equal(updated.customNotes, original.customNotes);
  }
  assert.equal((await repository.findById("one"))?.paoDeadline, "2026-07-31");
  assert.equal((await repository.findById("one"))?.usableUntil, "2026-06-01");
  assert.equal((await repository.findById("two"))?.paoDeadline, "2026-09-15");
  assert.equal((await repository.findById("three"))?.paoDeadline, "2027-02-01");
  assert.equal((await repository.findById("four"))?.paoDeadline, null);

  await service.updateProduct(product.id, { ...productEdit(product), pao_duration_months: null });
  assert.equal((await repository.findProductById(product.id))?.paoDurationMonths, null);
  for (const bottle of await repository.findAll()) {
    assert.equal(bottle.paoDurationMonths, null);
    assert.equal(bottle.paoDeadline, null);
    assert.equal(bottle.usableUntil, bottle.expiresOn);
  }
});

test("a failed bottle recalculation rolls back the Product and all previously recalculated bottles", async (context) => {
  const repository = new SqliteInventoryRepository(":memory:");
  context.after(() => repository.close());
  const product = createProduct({ id: "shared", name: "Sample serum" });
  await repository.importInventoryData({ products: [product], inventoryItems: [
    createInventoryItem({ id: "first", productId: product.id, lifecycleStatus: "opened", openedOn: "2026-01-01" }),
    createInventoryItem({ id: "overflow", productId: product.id, lifecycleStatus: "opened", openedOn: "9999-12-01" }),
  ] });
  const before = await repository.readBackupSnapshot();
  const service = new InventoryApplicationService(repository);
  await assert.rejects(service.updateProduct(product.id, {
    ...productEdit(product), name: "Must roll back", pao_duration_months: 12,
  }));
  assert.deepEqual(await repository.readBackupSnapshot(), before);
});

test("migration infers only consistent legacy PAO once and leaves original bottle snapshots untouched", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-pao-migration-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "inventory.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, size_label TEXT) STRICT;
    CREATE TABLE inventory_items (
      id TEXT PRIMARY KEY, product_id TEXT, created_at TEXT, lifecycle_status TEXT NOT NULL,
      opened_on TEXT, opened_on_accuracy TEXT, expires_on TEXT, pao_duration_months INTEGER,
      pao_deadline TEXT, usable_until TEXT, custom_notes TEXT
    ) STRICT;
    INSERT INTO products VALUES ('consistent', 'Sample A', 'cream', NULL), ('conflict', 'Sample B', 'cream', NULL), ('unknown', 'Sample C', 'cream', NULL), ('empty', 'Sample D', 'cream', NULL);
    INSERT INTO inventory_items VALUES
      ('a', 'consistent', NULL, 'opened', '2026-01-01', 'estimated', '2027-01-01', 6, '2026-07-01', '2026-07-01', NULL),
      ('b', 'consistent', NULL, 'unopened', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
      ('c', 'conflict', NULL, 'unopened', NULL, NULL, NULL, 6, NULL, NULL, NULL),
      ('d', 'conflict', NULL, 'unopened', NULL, NULL, NULL, 12, NULL, NULL, NULL),
      ('e', 'unknown', NULL, 'unopened', NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  `);
  const before = legacy.prepare("SELECT * FROM inventory_items ORDER BY id").all();
  legacy.close();
  const migrated = new SqliteInventoryRepository(path);
  assert.equal((await migrated.findProductById("consistent"))?.paoDurationMonths, 6);
  for (const id of ["conflict", "unknown", "empty"]) {
    assert.equal((await migrated.findProductById(id))?.paoDurationMonths, null);
  }
  const migratedProduct = await migrated.findProductById("consistent");
  assert.ok(migratedProduct);
  const { paoDurationMonths: _pao, ...legacyProduct } = migratedProduct;
  const priorImport = {
    products: [legacyProduct],
    inventoryItems: (await migrated.findAll()).filter((item) => item.productId === migratedProduct.id),
  };
  assert.deepEqual(await migrated.importInventoryData(priorImport), {
    productsInserted: 0, productsExisting: 1, inventoryItemsInserted: 0, inventoryItemsExisting: 2,
  });
  for (const explicit of [null, 12]) {
    await assert.rejects(migrated.importInventoryData({
      ...priorImport, products: [{ ...legacyProduct, paoDurationMonths: explicit }],
    }), /already exists with different data/u);
  }
  assert.equal((await migrated.findProductById("consistent"))?.paoDurationMonths, 6);
  migrated.close();
  const inspect = new DatabaseSync(path);
  assert.deepEqual(
    inspect
      .prepare(
        `SELECT id, product_id, created_at, lifecycle_status, opened_on,
        opened_on_accuracy, expires_on, pao_duration_months, pao_deadline,
        usable_until, custom_notes FROM inventory_items ORDER BY id`,
      )
      .all(),
    before,
  );
  assert.deepEqual(
    inspect
      .prepare(
        "SELECT remaining_percent_estimate FROM inventory_items ORDER BY id",
      )
      .all()
      .map((row) => ({ ...row })),
    Array.from({ length: 5 }, () => ({ remaining_percent_estimate: null })),
  );
  inspect.exec("UPDATE products SET pao_duration_months = NULL WHERE id = 'consistent'");
  inspect.close();
  const reopened = new SqliteInventoryRepository(path);
  assert.equal((await reopened.findProductById("consistent"))?.paoDurationMonths, null);
  reopened.close();
});

test("creation checks the latest Product PAO inside its transaction across connections", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-pao-race-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "inventory.sqlite");
  class InterleavingRepository extends SqliteInventoryRepository {
    beforeCreate: (() => Promise<void>) | undefined;
    override async createBatch(input: InventoryBatchPersistenceInput): Promise<void> {
      await this.beforeCreate?.();
      return super.createBatch(input);
    }
  }
  const first = new InterleavingRepository(path);
  const second = new SqliteInventoryRepository(path);
  context.after(() => { first.close(); second.close(); });
  const product = createProduct({ id: "shared", name: "Sample serum", paoDurationMonths: 6 });
  await first.importInventoryData({ products: [product], inventoryItems: [] });
  const service = new InventoryApplicationService(first);
  const other = new InventoryApplicationService(second);
  first.beforeCreate = async () => { await other.updateProduct(product.id, { ...productEdit(product), pao_duration_months: 12 }); };
  const created = await service.createInventoryBatch({
    as_of: "2026-08-31", products: [], inventory_items: [{
      batch_ref: "bottle", product_ref: { kind: "existing", product_id: product.id }, lifecycle_status: "unopened",
    }],
  });
  assert.equal(created.inventory_items[0]?.pao_duration_months, 12);
  first.beforeCreate = async () => { await other.updateProduct(product.id, { ...productEdit(product), pao_duration_months: 18 }); };
  await assert.rejects(service.createInventoryBatch({
    as_of: "2026-08-31", products: [], inventory_items: [{
      batch_ref: "stale", product_ref: { kind: "existing", product_id: product.id }, lifecycle_status: "unopened", pao_duration_months: 12,
    }],
  }), /conflicts with the shared Product PAO/u);
  assert.equal((await first.findAll()).length, 1);
  assert.equal((await first.findAll())[0]?.paoDurationMonths, 18);
});

test("backup round-trip preserves shared PAO and legacy backups default it to null without rewriting bottles", async (context) => {
  const repository = new SqliteInventoryRepository(":memory:");
  context.after(() => repository.close());
  const service = new InventoryApplicationService(repository, {
    imageStorage: { async put() {}, async get() { return new Uint8Array(); }, async delete() {} },
    imageInspector: { async inspect() { return { mediaType: "image/png", width: 1, height: 1, animated: false }; } },
  });
  const product = createProduct({ id: "shared", name: "Sample serum", paoDurationMonths: 6 });
  await repository.importInventoryData({ products: [product], inventoryItems: [
    createInventoryItem({ id: "legacy", productId: product.id, lifecycleStatus: "opened", openedOn: "2026-01-01", paoDurationMonths: 12, paoDeadline: "2027-01-01" }),
  ] });
  const plan = await service.prepareBackupExport();
  const chunks: string[] = [];
  await plan.writeTo(async (chunk) => { chunks.push(chunk); });
  const backup = service.prepareBackupRestore(JSON.parse(chunks.join(""))).backup;
  assert.equal(backup.products[0]?.pao_duration_months, 6);
  const before = await repository.readBackupSnapshot();
  await service.restoreBackup(backup);
  assert.deepEqual(await repository.readBackupSnapshot(), before);
  const legacy = { ...backup, products: backup.products.map(({ pao_duration_months: _pao, ...entry }) => entry) };
  await service.restoreBackup(legacy);
  assert.equal((await repository.findProductById(product.id))?.paoDurationMonths, null);
  assert.deepEqual((await repository.readBackupSnapshot()).inventoryItems, before.inventoryItems);
});

test("bottle corrections preserve historical PAO differences and inherit only when newly opening without PAO", async (context) => {
  const repository = new SqliteInventoryRepository(":memory:");
  context.after(() => repository.close());
  const product = createProduct({ id: "shared", name: "Sample cream", paoDurationMonths: 12 });
  await repository.importInventoryData({ products: [product], inventoryItems: [
    createInventoryItem({ id: "different", productId: product.id, lifecycleStatus: "unopened", paoDurationMonths: 6 }),
    createInventoryItem({ id: "unknown", productId: product.id, lifecycleStatus: "unopened" }),
    createInventoryItem({ id: "legacy-opened", productId: product.id, lifecycleStatus: "opened", openedOn: "2026-01-01", openedOnAccuracy: "exact" }),
  ] });
  const service = new InventoryApplicationService(repository);
  for (const [id, duration] of [["different", 6], ["unknown", null]] as const) {
    const edited = await service.updateInventoryItemFacts(id, {
      as_of: "2026-08-31", lifecycle_status: "unopened", opened_on: null,
      opened_on_accuracy: null, expires_on: "2028-01-01", pao_duration_months: duration,
    });
    assert.equal(edited.pao_duration_months, duration);
  }
  const different = await service.updateInventoryItemFacts("different", {
    as_of: "2026-08-31", lifecycle_status: "opened", opened_on: "2026-08-01",
    opened_on_accuracy: "exact", expires_on: "2028-01-01", pao_duration_months: 6,
  });
  assert.equal(different.pao_duration_months, 6);
  const inherited = await service.updateInventoryItemFacts("unknown", {
    as_of: "2026-08-31", lifecycle_status: "opened", opened_on: "2026-08-01",
    opened_on_accuracy: "exact", expires_on: "2028-01-01", pao_duration_months: null,
  });
  assert.equal(inherited.pao_duration_months, 12);
  assert.equal(inherited.pao_deadline, "2027-08-01");
  const historical = await service.updateInventoryItemFacts("legacy-opened", {
    as_of: "2026-08-31", lifecycle_status: "opened", opened_on: "2026-01-01",
    opened_on_accuracy: "exact", expires_on: "2028-01-01", pao_duration_months: null,
  });
  assert.equal(historical.pao_duration_months, null);
  assert.equal(historical.pao_deadline, null);
});

test("recording an opening inherits missing PAO but preserves historical values and idempotent snapshots", async (context) => {
  const repository = new SqliteInventoryRepository(":memory:");
  context.after(() => repository.close());
  const product = createProduct({ id: "shared", name: "Sample cream", paoDurationMonths: 12 });
  const historical = createInventoryItem({ id: "historical", productId: product.id, lifecycleStatus: "opened", openedOn: "2026-01-01", paoDurationMonths: 6, paoDeadline: "2026-07-01" });
  await repository.importInventoryData({ products: [product], inventoryItems: [
    createInventoryItem({ id: "different", productId: product.id, lifecycleStatus: "unopened", paoDurationMonths: 6 }),
    createInventoryItem({ id: "unknown", productId: product.id, lifecycleStatus: "unopened" }),
    historical,
  ] });
  const service = new InventoryApplicationService(repository);
  const unknown = await service.recordProductOpened({ inventory_item_id: "unknown", opened_on: "2026-08-01", opened_on_accuracy: "exact" });
  assert.equal(unknown.pao_duration_months, 12);
  assert.equal(unknown.pao_deadline, "2027-08-01");
  const different = await service.recordProductOpened({ inventory_item_id: "different", opened_on: "2026-08-01", opened_on_accuracy: "estimated" });
  assert.equal(different.pao_duration_months, 6);
  assert.equal(different.pao_deadline, "2027-02-01");
  const same = await service.recordProductOpened({ inventory_item_id: historical.id, opened_on: "2026-01-01", opened_on_accuracy: "legacy_unknown" });
  assert.equal(same.outcome, "already_opened");
  assert.deepEqual(await repository.findById(historical.id), historical);
});

test("stale bottle corrections cannot restore a concurrently cleared Product PAO", async (context) => {
  class InterleavingRepository extends SqliteInventoryRepository {
    beforeUpdate: (() => Promise<void>) | undefined;
    override async updateInventoryItemFacts(item: InventoryItem, expectedPao?: number | null): Promise<InventoryItem> {
      await this.beforeUpdate?.();
      return super.updateInventoryItemFacts(item, expectedPao);
    }
  }
  const repository = new InterleavingRepository(":memory:");
  context.after(() => repository.close());
  const product = createProduct({ id: "shared", name: "Sample serum", paoDurationMonths: 6 });
  await repository.importInventoryData({ products: [product], inventoryItems: [
    createInventoryItem({ id: "bottle", productId: product.id, lifecycleStatus: "unopened", paoDurationMonths: 6 }),
  ] });
  const service = new InventoryApplicationService(repository);
  repository.beforeUpdate = async () => {
    await service.updateProduct(product.id, { ...productEdit(product), pao_duration_months: null });
  };
  await assert.rejects(service.updateInventoryItemFacts("bottle", {
    as_of: "2026-08-31", lifecycle_status: "unopened", opened_on: null,
    opened_on_accuracy: null, expires_on: "2028-01-01", pao_duration_months: 6,
  }), /PAO changed while its facts were being edited/u);
  assert.equal((await repository.findById("bottle"))?.paoDurationMonths, null);
  assert.equal((await repository.findById("bottle"))?.expiresOn, null);
});

test("opening writes use the latest bottle PAO after a concurrent Product update", async (context) => {
  class InterleavingRepository extends SqliteInventoryRepository {
    beforeRecordOpened: (() => Promise<void>) | undefined;
    override async recordProductOpened(
      input: RecordProductOpenedPersistenceInput,
    ): Promise<RecordProductOpenedPersistenceResult> {
      await this.beforeRecordOpened?.();
      return super.recordProductOpened(input);
    }
  }
  const repository = new InterleavingRepository(":memory:");
  context.after(() => repository.close());
  const product = createProduct({ id: "shared", name: "Sample serum", paoDurationMonths: 6 });
  await repository.importInventoryData({ products: [product], inventoryItems: [
    createInventoryItem({ id: "bottle", productId: product.id, lifecycleStatus: "unopened", paoDurationMonths: 6, expiresOn: "2028-01-01" }),
  ] });
  const service = new InventoryApplicationService(repository);
  repository.beforeRecordOpened = async () => {
    await service.updateProduct(product.id, { ...productEdit(product), pao_duration_months: null });
  };
  const opened = await service.recordProductOpened({ inventory_item_id: "bottle", opened_on: "2026-08-31", opened_on_accuracy: "exact" });
  assert.equal(opened.pao_duration_months, null);
  assert.equal(opened.pao_deadline, null);
  assert.equal(opened.usable_until, "2028-01-01");
  assert.equal((await repository.findById("bottle"))?.paoDurationMonths, null);
});

function productEdit(product: Product) {
  return {
    name: product.name, alias: product.alias, brand: product.brand,
    category: product.category, size_label: product.sizeLabel,
    image_asset_id: product.imageAssetId, ingredient_list_text: product.ingredientListText,
    shared_notes: product.sharedNotes,
  };
}

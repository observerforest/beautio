import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createInventoryItem, maximumEntityRevision } from "@beautio/domain";
import { SqliteInventoryRepository } from "../src/index.ts";
import {
  databasePathForTest, metadata, revisionError, revisionFixture, snapshot,
} from "./revision-test-fixtures.ts";

test("revision migration backfills legacy entities once after business migrations and retains foreign keys", async (context) => {
  const databasePath = await databasePathForTest(context);
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL,
      category TEXT NOT NULL, size_label TEXT) STRICT;
    CREATE TABLE inventory_items (id TEXT PRIMARY KEY, product_id TEXT REFERENCES products(id),
      lifecycle_status TEXT NOT NULL, opened_on TEXT, expires_on TEXT,
      pao_duration_months INTEGER, pao_deadline TEXT, usable_until TEXT) STRICT;
    INSERT INTO products VALUES ('product', 'Legacy serum', 'Serum', '30 ml');
    INSERT INTO inventory_items VALUES ('bottle', 'product', 'opened', '2026-01-01',
      '2028-01-01', 6, '2026-07-01', '2026-07-01');
  `);
  const before = legacy.prepare(`SELECT id, product_id, lifecycle_status, opened_on,
    expires_on, pao_duration_months, pao_deadline, usable_until FROM inventory_items`).all();
  legacy.close();
  const first = new SqliteInventoryRepository(databasePath);
  const current = await snapshot(first);
  assert.equal(current.product?.product.paoDurationMonths, 6);
  assert.equal(current.item.openedOnAccuracy, "legacy_unknown");
  assert.ok(current.product);
  assert.notEqual(current.revision, current.product.revision);
  first.close();
  const observer = new DatabaseSync(databasePath);
  context.after(() => observer.close());
  const firstMetadata = metadata(observer);
  new SqliteInventoryRepository(databasePath).close();
  new SqliteInventoryRepository(databasePath).close();
  assert.deepEqual(metadata(observer), firstMetadata);
  assert.deepEqual(observer.prepare(`SELECT id, product_id, lifecycle_status, opened_on,
    expires_on, pao_duration_months, pao_deadline, usable_until FROM inventory_items`).all(), before);
  assert.deepEqual(observer.prepare("PRAGMA foreign_key_check").all(), []);
});

test("old SQL updates bump only changed entities and preserve revision history over rename, delete and reinsert", async (context) => {
  const { repository, database, databasePath } = await revisionFixture(context);
  const before = await snapshot(repository);
  assert.ok(before.product);
  database.exec("UPDATE products SET name = name, alias = alias; UPDATE inventory_items SET expires_on = expires_on");
  assert.deepEqual(await snapshot(repository), before);
  database.exec("UPDATE products SET alias = NULL WHERE id = 'product'");
  const editedProduct = await snapshot(repository);
  assert.ok(editedProduct.product);
  assert.ok(editedProduct.product.revision > before.product.revision);
  assert.equal(editedProduct.revision, before.revision);
  database.exec("UPDATE inventory_items SET custom_notes = 'SQL notes' WHERE id = 'bottle'");
  const editedItem = await snapshot(repository);
  assert.ok(editedItem.revision > editedProduct.product.revision);
  database.exec("UPDATE inventory_items SET id = 'renamed' WHERE id = 'bottle'");
  assert.equal(await repository.findVersionedInventoryItem("bottle"), null);
  const renamed = await snapshot(repository, "renamed");
  assert.ok(renamed.revision > editedItem.revision);
  assert.equal(database.prepare("SELECT * FROM entity_revisions WHERE entity_kind = 'inventory_item' AND entity_id = 'bottle'").get(), undefined);
  database.exec("DELETE FROM inventory_items WHERE id = 'renamed'");
  await repository.seedInventoryItem(createInventoryItem({ ...renamed.item, id: "renamed" }));
  const replaced = await snapshot(repository, "renamed");
  assert.ok(replaced.revision > renamed.revision);
  const reopened = new SqliteInventoryRepository(databasePath);
  context.after(() => reopened.close());
  assert.deepEqual(await snapshot(reopened, "renamed"), replaced);
});

test("same Product identifier receives a later revision after deletion and SQL replacement", async (context) => {
  const { repository, database, product } = await revisionFixture(context);
  const before = await snapshot(repository);
  assert.ok(before.product);
  database.exec("DELETE FROM inventory_items; DELETE FROM products");
  await repository.importInventoryData({ products: [product], inventoryItems: [
    createInventoryItem({ id: "bottle", productId: product.id, lifecycleStatus: "unopened" }),
  ] });
  const recreated = await snapshot(repository);
  assert.ok(recreated.product);
  assert.ok(recreated.product.revision > before.revision);
  database.exec("INSERT OR REPLACE INTO products (id, name) VALUES ('product', 'Replaced serum')");
  const replaced = await snapshot(repository);
  assert.ok(replaced.product);
  assert.ok(replaced.product.revision > recreated.product.revision);
});

test("missing clock rows fail closed for existing and old SQL writes and for repository reopen", async (context) => {
  const { repository, database, databasePath } = await revisionFixture(context);
  const before = await repository.readBackupSnapshot();
  database.exec("DELETE FROM revision_clock");
  await assert.rejects(repository.findVersionedInventoryItem("bottle"), revisionError("REVISION_STORE_FAILURE"));
  assert.throws(() => database.exec("UPDATE products SET name = 'Never persisted'"), /REVISION_STORE_FAILURE/u);
  assert.throws(() => database.exec("INSERT INTO inventory_items (id, lifecycle_status) VALUES ('new', 'unopened')"), /REVISION_STORE_FAILURE/u);
  assert.throws(() => database.exec("DELETE FROM inventory_items"), /REVISION_STORE_FAILURE/u);
  assert.throws(() => new SqliteInventoryRepository(databasePath), revisionError("REVISION_STORE_FAILURE"));
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM revision_clock").get()?.count, 0);
  assert.deepEqual(await repository.readBackupSnapshot(), before);
});

test("the final safe revision commits once and exhaustion never wraps across reopen", async (context) => {
  const { repository, database, databasePath } = await revisionFixture(context);
  database.prepare("UPDATE revision_clock SET high_water = ?").run(maximumEntityRevision - 1);
  database.exec("UPDATE inventory_items SET custom_notes = 'Last safe revision'");
  const last = await snapshot(repository);
  assert.equal(last.revision, maximumEntityRevision);
  assert.throws(() => database.exec("UPDATE inventory_items SET custom_notes = 'Overflow'"), /REVISION_STORE_FAILURE/u);
  await assert.rejects(repository.correctInventoryItemFacts({
    inventoryItemId: last.item.id, expectedRevision: last.revision, patch: { pao_duration_months: 12 },
  }), revisionError("REVISION_STORE_FAILURE"));
  assert.throws(() => new SqliteInventoryRepository(databasePath), revisionError("REVISION_STORE_FAILURE"));
  assert.deepEqual(await snapshot(repository), last);
});

test("clock rollback and incomplete installed metadata cannot silently restart revision allocation", async (context) => {
  for (const fault of ["clock-table", "revision-table", "trigger", "mapping", "invalid-clock"] as const) {
    await context.test(fault, async (nested) => {
      const { database, databasePath } = await revisionFixture(nested);
      assert.throws(() => database.exec("UPDATE revision_clock SET high_water = 0"), /REVISION_STORE_FAILURE/u);
      if (fault === "clock-table") database.exec("DROP TABLE revision_clock");
      if (fault === "revision-table") database.exec("DROP TABLE entity_revisions");
      if (fault === "trigger") database.exec("DROP TRIGGER entity_revision_product_update");
      if (fault === "mapping") database.exec("DELETE FROM entity_revisions WHERE entity_kind = 'inventory_item'");
      if (fault === "invalid-clock") database.exec(`
        PRAGMA ignore_check_constraints = ON;
        UPDATE revision_clock SET high_water = 9007199254740992;
        PRAGMA ignore_check_constraints = OFF;
      `);
      assert.throws(() => new SqliteInventoryRepository(databasePath), revisionError("REVISION_STORE_FAILURE"));
    });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { RevisionError, type VersionedInventoryItem } from "@beautio/application";
import { createInventoryItem, createProduct } from "@beautio/domain";
import { SqliteInventoryRepository } from "../src/index.ts";

export async function databasePathForTest(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "beautio-revisions-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "inventory.sqlite");
}

export async function revisionFixture(context: TestContext) {
  const databasePath = await databasePathForTest(context);
  const repository = new SqliteInventoryRepository(databasePath);
  const database = new DatabaseSync(databasePath);
  context.after(() => { database.close(); repository.close(); });
  const product = createProduct({
    id: "product", name: "Sample serum", alias: "Serum", brand: "Sample brand",
    paoDurationMonths: 6, imageRef: "legacy-sample.webp", sharedNotes: "Shared sample notes",
  });
  const item = createInventoryItem({
    id: "bottle", productId: product.id, lifecycleStatus: "unopened",
    paoDurationMonths: 6, expiresOn: "2028-01-01", customNotes: "Bottle sample notes",
  });
  await repository.importInventoryData({ products: [product], inventoryItems: [item] });
  return { databasePath, repository, database, product, item };
}

export async function snapshot(
  repository: SqliteInventoryRepository,
  id = "bottle",
): Promise<VersionedInventoryItem> {
  const current = await repository.findVersionedInventoryItem(id);
  assert.ok(current);
  return current;
}

export function metadata(database: DatabaseSync) {
  return {
    clock: database.prepare("SELECT * FROM revision_clock").all(),
    revisions: database.prepare("SELECT * FROM entity_revisions ORDER BY entity_kind, entity_id").all(),
  };
}

export function revisionError(code: RevisionError["code"]) {
  return (error: unknown): boolean => error instanceof RevisionError && error.code === code;
}

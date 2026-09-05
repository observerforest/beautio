import assert from "node:assert/strict";
import test from "node:test";
import {
  CommandExecutionService, InventoryApplicationService,
  createCanonicalCommandPayload, createSafeCommandResult,
} from "@beautio/application";
import { inventoryFactsPatchSchema } from "@beautio/contracts";
import {
  BeautioError, createInventoryItem, endInventoryItem,
  parseIsoDate, type EntityRevision, type ImageAsset,
} from "@beautio/domain";
import { SqliteInventoryRepository } from "../src/index.ts";
import { metadata, revisionError, revisionFixture, snapshot } from "./revision-test-fixtures.ts";

test("two connections sharing an expected revision produce one winner and reject the stale patch without side effects", async (context) => {
  const { repository, databasePath, database } = await revisionFixture(context);
  const competing = new SqliteInventoryRepository(databasePath);
  context.after(() => competing.close());
  const before = await snapshot(repository);
  const competingSnapshot = await snapshot(competing);
  assert.deepEqual(competingSnapshot, before);
  const input = { inventoryItemId: before.item.id, expectedRevision: before.revision };
  const attempts = await Promise.allSettled([
    repository.correctInventoryItemFacts({ ...input, patch: inventoryFactsPatchSchema.parse({ expires_on: "2029-01-01" }) }),
    competing.correctInventoryItemFacts({ ...input, patch: inventoryFactsPatchSchema.parse({ expires_on: "2030-01-01" }) }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  const failure = attempts.find((attempt) => attempt.status === "rejected");
  assert.ok(failure && failure.status === "rejected");
  assert.ok(revisionError("REVISION_CONFLICT")(failure.reason));
  const after = await snapshot(repository);
  assert.equal(after.item.expiresOn, "2029-01-01");
  assert.ok(after.revision > before.revision);
  assert.deepEqual(after.product, before.product);
  const committedMetadata = metadata(database);
  await assert.rejects(competing.correctInventoryItemFacts({ ...input, patch: { pao_duration_months: 12 } }), revisionError("REVISION_CONFLICT"));
  assert.deepEqual(await snapshot(competing), after);
  assert.deepEqual(metadata(database), committedMetadata);
});

test("profile CAS preserves images and unrelated facts while explicit PAO cascades versions atomically", async (context) => {
  const { repository, database } = await revisionFixture(context);
  const before = await snapshot(repository);
  assert.ok(before.product);
  await repository.recordProductOpened({
    inventoryItemId: before.item.id, openedOn: parseIsoDate("2026-01-31", "opened_on"), openedOnAccuracy: "exact",
  });
  const opened = await snapshot(repository);
  const profile = await repository.reviseProductProfile({
    productId: before.product.product.id, expectedRevision: before.product.revision,
    patch: { alias: null, shared_notes: "New shared notes" },
  });
  assert.equal(profile.product.imageRef, before.product.product.imageRef);
  assert.equal(profile.product.imageAssetId, before.product.product.imageAssetId);
  assert.equal(profile.product.name, before.product.product.name);
  assert.equal(profile.product.alias, null);
  assert.equal((await snapshot(repository)).revision, opened.revision);
  const beforePaoMetadata = metadata(database);
  await assert.rejects(repository.reviseProductProfile({
    productId: profile.product.id, expectedRevision: before.product.revision, patch: { name: "Stale name" },
  }), revisionError("REVISION_CONFLICT"));
  assert.deepEqual(metadata(database), beforePaoMetadata);
  const updated = await repository.reviseProductProfile({
    productId: profile.product.id, expectedRevision: profile.revision, patch: { pao_duration_months: 12 },
  });
  const cascaded = await snapshot(repository);
  assert.ok(updated.revision > profile.revision);
  assert.ok(cascaded.revision > opened.revision);
  assert.equal(cascaded.item.paoDeadline, "2027-01-31");
  assert.equal(cascaded.item.usableUntil, "2027-01-31");
  assert.equal(cascaded.item.customNotes, before.item.customNotes);
  const noop = await repository.reviseProductProfile({
    productId: updated.product.id, expectedRevision: updated.revision, patch: { pao_duration_months: 12 },
  });
  assert.deepEqual(noop, updated);
  assert.deepEqual(await snapshot(repository), cascaded);
});

test("failed PAO cascade rolls back Product, earlier bottles, clock and revisions", async (context) => {
  const { repository, database, item } = await revisionFixture(context);
  await repository.seedInventoryItem(createInventoryItem({ ...item, id: "z-bottle" }));
  const before = await repository.readBackupSnapshot();
  const beforeMetadata = metadata(database);
  const versioned = await snapshot(repository);
  assert.ok(versioned.product);
  database.exec(`CREATE TRIGGER reject_last_pao BEFORE UPDATE ON inventory_items
    WHEN NEW.id = 'z-bottle' AND NEW.pao_duration_months = 12
    BEGIN SELECT RAISE(ABORT, 'injected cascade failure'); END`);
  await assert.rejects(repository.reviseProductProfile({
    productId: "product", expectedRevision: versioned.product.revision,
    patch: { name: "Rolled back name", pao_duration_months: 12 },
  }), revisionError("REVISION_STORE_FAILURE"));
  assert.deepEqual(await repository.readBackupSnapshot(), before);
  assert.deepEqual(metadata(database), beforeMetadata);
  database.exec("DROP TRIGGER reject_last_pao");
  const committed = await repository.reviseProductProfile({
    productId: "product", expectedRevision: versioned.product.revision, patch: { pao_duration_months: 12 },
  });
  assert.ok(committed.revision > versioned.product.revision);
});

test("bottle corrections retain legacy PAO and accuracy, inherit explicit changes and reject invalid lifecycle facts", async (context) => {
  const { repository, database, item } = await revisionFixture(context);
  await repository.seedInventoryItem(createInventoryItem({
    ...item, id: "legacy", lifecycleStatus: "opened", openedOn: "2026-01-31",
    openedOnAccuracy: "legacy_unknown", paoDurationMonths: 12,
    paoDeadline: "2027-01-31", usableUntil: "2027-01-31",
  }));
  const legacy = await snapshot(repository, "legacy");
  const corrected = await repository.correctInventoryItemFacts({
    inventoryItemId: "legacy", expectedRevision: legacy.revision,
    patch: inventoryFactsPatchSchema.parse({ expires_on: "2029-01-01" }),
  });
  assert.equal(corrected.item.paoDurationMonths, 12);
  assert.equal(corrected.item.openedOnAccuracy, "legacy_unknown");
  const unchangedLegacy = await repository.correctInventoryItemFacts({
    inventoryItemId: "legacy", expectedRevision: corrected.revision, patch: { pao_duration_months: 12 },
  });
  assert.deepEqual(unchangedLegacy, corrected);
  const inherited = await repository.correctInventoryItemFacts({
    inventoryItemId: "legacy", expectedRevision: corrected.revision, patch: { pao_duration_months: null },
  });
  assert.equal(inherited.item.paoDurationMonths, 6);
  assert.equal(inherited.item.paoDeadline, "2026-07-31");
  const fixedDate = await repository.correctInventoryItemFacts({
    inventoryItemId: "legacy", expectedRevision: inherited.revision,
    patch: inventoryFactsPatchSchema.parse({ opened_on: "2026-02-28", opened_on_accuracy: "estimated" }),
  });
  assert.equal(fixedDate.item.paoDeadline, "2026-08-28");
  const beforeInvalid = metadata(database);
  for (const patch of [
    { pao_duration_months: 12 }, { opened_on: "2026-03-01" }, { opened_on: null },
    { lifecycle_status: "finished" }, {}, { custom_notes: "Not permitted" },
  ]) {
    await assert.rejects(repository.correctInventoryItemFacts({
      inventoryItemId: "legacy", expectedRevision: fixedDate.revision,
      patch: patch as never,
    }), (error: unknown) => error instanceof BeautioError && error.code === "INVALID_INPUT");
  }
  assert.deepEqual(metadata(database), beforeInvalid);
  const unopened = await snapshot(repository);
  await assert.rejects(repository.correctInventoryItemFacts({
    inventoryItemId: unopened.item.id, expectedRevision: unopened.revision,
    patch: inventoryFactsPatchSchema.parse({ opened_on: "2026-02-28", opened_on_accuracy: "exact" }),
  }), (error: unknown) => error instanceof BeautioError && error.code === "INVALID_INPUT");
  await repository.endInventoryItem(endInventoryItem(fixedDate.item, { lifecycleStatus: "finished" }));
  const terminal = await snapshot(repository, "legacy");
  await assert.rejects(repository.correctInventoryItemFacts({
    inventoryItemId: "legacy", expectedRevision: terminal.revision, patch: { expires_on: null },
  }), (error: unknown) => error instanceof BeautioError && error.code === "INVENTORY_ITEM_TERMINAL");
});

test("invalid profile patches and invalid expected revisions leave all persisted values unchanged", async (context) => {
  const { repository, database } = await revisionFixture(context);
  const before = await snapshot(repository);
  assert.ok(before.product);
  const beforeMetadata = metadata(database);
  for (const patch of [{}, { image_asset_id: "unavailable" }, { name: null }, { name: " " }]) {
    await assert.rejects(repository.reviseProductProfile({
      productId: "product", expectedRevision: before.product.revision, patch: patch as never,
    }), (error: unknown) => error instanceof BeautioError && error.code === "INVALID_INPUT");
  }
  await assert.rejects(repository.reviseProductProfile({
    productId: "product", expectedRevision: 0 as EntityRevision, patch: { name: "Never saved" },
  }), (error: unknown) => error instanceof BeautioError && error.code === "INVALID_INPUT");
  assert.deepEqual(await snapshot(repository), before);
  assert.deepEqual(metadata(database), beforeMetadata);
});

test("old application writes maintain revisions for images, PAO, opening, terminal notes, create and import", async (context) => {
  const { repository, item } = await revisionFixture(context);
  const service = new InventoryApplicationService(repository);
  let current = await snapshot(repository);
  assert.ok(current.product);
  const asset: ImageAsset = {
    id: "sample-image", storageKey: "sample-image.webp", mediaType: "image/webp", byteSize: 10,
    status: "staging", productId: null, expiresAt: "2027-01-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  };
  await repository.stageImageAssets([asset]);
  await repository.activateStagedImageAssets([asset.id]);
  await repository.setProductDisplayImage({
    productId: "product", imageAssetId: asset.id, now: "2026-09-01T00:00:00.000Z",
    unlinkedExpiresAt: "2026-09-02T00:00:00.000Z",
  });
  let next = await snapshot(repository);
  assert.ok(next.product && next.product.revision > current.product.revision);
  assert.equal(next.revision, current.revision);
  current = next;
  await service.updateProduct("product", {
    name: "Old API name", category: null, size_label: null, image_asset_id: asset.id,
    ingredient_list_text: null, shared_notes: null, pao_duration_months: 12,
  });
  next = await snapshot(repository);
  assert.ok(next.product && current.product && next.product.revision > current.product.revision);
  assert.ok(next.revision > current.revision);
  await service.recordProductOpened({ inventory_item_id: item.id, opened_on: "2026-09-01", opened_on_accuracy: "exact" });
  current = await snapshot(repository);
  assert.ok(current.revision > next.revision);
  await service.recordProductOpened({ inventory_item_id: item.id, opened_on: "2026-09-01", opened_on_accuracy: "exact" });
  assert.deepEqual(await snapshot(repository), current);
  await repository.endInventoryItem(endInventoryItem(current.item, { lifecycleStatus: "discarded", remainingPercentEstimate: 50 }));
  next = await snapshot(repository);
  assert.ok(next.revision > current.revision);
  await repository.updateInventoryItemCustomNotes({ inventoryItemId: item.id, customNotes: "Terminal notes" });
  current = await snapshot(repository);
  assert.ok(current.revision > next.revision);
  const added = await service.createInventoryBatch({
    as_of: "2026-09-01", products: [{ batch_ref: "new-product", name: "New sample" }],
    inventory_items: [{ batch_ref: "new-bottle", product_ref: { kind: "new", batch_ref: "new-product" }, lifecycle_status: "unopened" }],
  });
  const createdId = added.inventory_items[0]?.inventory_item_id;
  assert.ok(createdId);
  const created = await snapshot(repository, createdId);
  assert.ok(created.product && created.revision > current.revision);
  assert.ok(created.product.revision > current.revision);
  await repository.importInventoryData({ products: [], inventoryItems: [createInventoryItem({ id: "imported", lifecycleStatus: "unopened" })] });
  const imported = await snapshot(repository, "imported");
  assert.ok(imported.revision > created.revision);
  assert.equal(imported.product, null);
});

test("backup v1 restore allocates fresh revisions, invalidates old preconditions and retains command execution", async (context) => {
  const { repository, database } = await revisionFixture(context);
  const commands = new CommandExecutionService(repository, () => new Date("2026-09-01T00:00:00.000Z"));
  const command = {
    operationId: "revise_product_profile", commandId: "123e4567-e89b-42d3-a456-426614174000",
    payload: createCanonicalCommandPayload({ product_id: "product", patch: { name: "Sample serum" } }),
  } as const;
  await commands.execute(command, async () => ({
    outcome: "succeeded", result: createSafeCommandResult({ outcome: "updated", product_id: "product" }),
  }));
  const beforeCommands = database.prepare("SELECT * FROM command_executions").all();
  const before = await snapshot(repository);
  assert.ok(before.product);
  const backup = await repository.readBackupSnapshot();
  assert.deepEqual(Object.keys(backup).sort(), ["imageAssets", "inventoryItems", "products"]);
  assert.equal(JSON.stringify(backup).includes("revision"), false);
  await repository.replaceFromBackup({ ...backup, imageAssets: [] });
  assert.deepEqual(await repository.readBackupSnapshot(), backup);
  assert.deepEqual(database.prepare("SELECT * FROM command_executions").all(), beforeCommands);
  const restored = await snapshot(repository);
  assert.ok(restored.product && restored.revision > before.revision && restored.product.revision > before.product.revision);
  await assert.rejects(repository.reviseProductProfile({
    productId: "product", expectedRevision: before.product.revision, patch: { name: "Old draft" },
  }), revisionError("REVISION_CONFLICT"));
  await assert.rejects(repository.correctInventoryItemFacts({
    inventoryItemId: "bottle", expectedRevision: before.revision, patch: { expires_on: null },
  }), revisionError("REVISION_CONFLICT"));
});

test("write lock contention fails closed and the same repository can retry after release", async (context) => {
  const { repository, database } = await revisionFixture(context);
  const before = await snapshot(repository);
  assert.ok(before.product);
  const input = { productId: "product", expectedRevision: before.product.revision, patch: { name: "Retried profile" } };
  database.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(repository.reviseProductProfile(input), revisionError("REVISION_STORE_FAILURE"));
  } finally {
    database.exec("ROLLBACK");
  }
  assert.deepEqual(await snapshot(repository), before);
  const retried = await repository.reviseProductProfile(input);
  assert.equal(retried.product.name, "Retried profile");
});

import assert from "node:assert/strict";
import test from "node:test";
import { createInventoryItem, createProduct, parseEntityRevision, parseIsoDate } from "@beautio/domain";
import { versionedInventoryOutputSchema, versionedProductOutputSchema } from "@beautio/contracts";
import {
  RevisionedInventoryService, mergeInventoryFactsPatch, mergeProductProfilePatch,
  type RevisionedInventoryRepository, type VersionedInventoryItem,
} from "../src/index.ts";

const product = createProduct({
  id: "test-product", name: "Cream", brand: "Example", sizeLabel: "50ml",
  paoDurationMonths: 6, imageAssetId: "private-asset", imageRef: "private-reference",
  sharedNotes: "Shared note",
});
const bottle = createInventoryItem({
  id: "test-bottle", productId: product.id, lifecycleStatus: "opened",
  createdAt: "2026-09-01T00:00:00.000Z", openedOn: "2026-09-01",
  openedOnAccuracy: "legacy_unknown", expiresOn: "2027-09-01",
  paoDurationMonths: 6, paoDeadline: "2027-03-01", customNotes: "Bottle note",
});

test("Product partial merge clears only explicit nullable fields and preserves image identity", () => {
  const result = mergeProductProfilePatch(product, { alias: "Night", shared_notes: null });
  assert.deepEqual(result, { ...product, alias: "Night", sharedNotes: null });
  assert.throws(() => mergeProductProfilePatch(product, { name: undefined }));
});

test("bottle corrections preserve legacy accuracy unless the opening date changes", () => {
  const changed = mergeInventoryFactsPatch(bottle, { expires_on: parseIsoDate("2026-12-01", "expires_on") });
  assert.equal(changed.openedOnAccuracy, "legacy_unknown");
  assert.equal(changed.paoDeadline, "2027-03-01");
  assert.equal(changed.usableUntil, "2026-12-01");
  assert.equal(changed.customNotes, bottle.customNotes);
  assert.equal(changed.createdAt, bottle.createdAt);
  assert.equal(changed.productId, bottle.productId);
  assert.throws(() => mergeInventoryFactsPatch(bottle, { opened_on: parseIsoDate("2026-09-05", "opened_on") }));
  assert.throws(() => mergeInventoryFactsPatch(bottle, { opened_on_accuracy: null }));
  const corrected = mergeInventoryFactsPatch(bottle, { opened_on: parseIsoDate("2026-09-05", "opened_on"), opened_on_accuracy: "estimated" });
  assert.equal(corrected.paoDeadline, "2027-03-05");
  assert.equal(corrected.openedOnAccuracy, "estimated");
});

test("correction never creates an opening or edits terminal bottle facts", () => {
  const unopened = createInventoryItem({ id: "unopened", lifecycleStatus: "unopened" });
  assert.throws(() => mergeInventoryFactsPatch(unopened, { opened_on: parseIsoDate("2026-09-05", "opened_on"), opened_on_accuracy: "exact" }));
  for (const lifecycleStatus of ["finished", "discarded"] as const) {
    const terminal = createInventoryItem({ ...bottle, lifecycleStatus });
    assert.throws(() => mergeInventoryFactsPatch(terminal, { expires_on: null }), { code: "INVENTORY_ITEM_TERMINAL" });
  }
  const cleared = mergeInventoryFactsPatch(bottle, { expires_on: null, pao_duration_months: null });
  assert.equal(cleared.usableUntil, null);
  assert.equal(cleared.paoDeadline, null);
});

test("versioned service delegates parsed frozen patches and never performs a pre-write read", async () => {
  const snapshot: VersionedInventoryItem = {
    item: bottle, revision: parseEntityRevision(12),
    product: { product, revision: parseEntityRevision(11) },
  };
  let reads = 0;
  let writes = 0;
  const repository: RevisionedInventoryRepository = {
    async findVersionedInventoryItem(id) { reads++; assert.equal(id, bottle.id); return snapshot; },
    async reviseProductProfile(input) {
      writes++;
      assert.equal(input.productId, product.id);
      assert.equal(input.expectedRevision, 11);
      assert.deepEqual(input.patch, { alias: "Night" });
      assert.equal(Object.isFrozen(input.patch), true);
      return { product: mergeProductProfilePatch(product, input.patch), revision: parseEntityRevision(13) };
    },
    async correctInventoryItemFacts(input) {
      writes++;
      assert.equal(input.expectedRevision, 12);
      assert.deepEqual(input.patch, { expires_on: null });
      assert.equal(Object.isFrozen(input.patch), true);
      return { ...snapshot, item: mergeInventoryFactsPatch(bottle, input.patch), revision: parseEntityRevision(14) };
    },
  };
  const service = new RevisionedInventoryService(repository);
  const updatedProduct = await service.reviseProductProfile(product.id, { expected_revision: 11, alias: " Night " });
  assert.equal(versionedProductOutputSchema.safeParse(updatedProduct).success, true);
  const updatedBottle = await service.correctInventoryItemFacts(bottle.id, { expected_revision: 12, expires_on: null });
  assert.equal(versionedInventoryOutputSchema.safeParse(updatedBottle).success, true);
  assert.equal(reads, 0);
  assert.equal(writes, 2);
  for (const invalid of [{ expected_revision: 11 }, { expected_revision: "11", name: "Other" }, { expected_revision: 11, image_asset_id: "other" }]) {
    await assert.rejects(service.reviseProductProfile(product.id, invalid), { code: "INVALID_INPUT" });
  }
  assert.equal(writes, 2);
  const output = await service.fetchInventoryItem(bottle.id);
  assert.equal(output.derived_status, null);
  assert.equal(output.revision, 12);
  assert.equal(output.product?.revision, 11);
  assert.equal(output.product?.has_image, true);
  assert.equal(JSON.stringify(output).includes("private-"), false);
  const dated = await service.fetchInventoryItem(bottle.id, { as_of: "2026-09-05" });
  assert.equal(dated.derived_status?.as_of, "2026-09-05");
});

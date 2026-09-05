import assert from "node:assert/strict";
import test from "node:test";
import {
  correctInventoryItemFactsInputSchema,
  entityRevisionSchema,
  reviseProductProfileInputSchema,
} from "../src/index.ts";

test("revisions reject coercion, zero, fractions and unsafe integer preconditions", () => {
  for (const value of [undefined, null, "2", 0, -1, 1.5, NaN, Infinity, 9007199254740992]) {
    assert.equal(entityRevisionSchema.safeParse(value).success, false);
  }
  assert.equal(entityRevisionSchema.parse(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test("profile patches preserve omission and normalize explicit clears without accepting images", () => {
  const parsed = reviseProductProfileInputSchema.parse({ expected_revision: 2, shared_notes: "  ", alias: null, name: " Cream " });
  assert.deepEqual(parsed, { expected_revision: 2, shared_notes: null, alias: null, name: "Cream" });
  assert.equal(Object.hasOwn(parsed, "brand"), false);
  for (const body of [
    { expected_revision: 2 }, { expected_revision: 2, name: undefined },
    { expected_revision: 2, name: null }, { name: "Cream" },
    { expected_revision: 2, image_asset_id: "asset" },
    { expected_revision: 2, revision: 3, name: "Cream" },
    { expected_revision: 2, alias: "x".repeat(11) },
    { expected_revision: 2, pao_duration_months: 0 },
    { expected_revision: 2, shared_notes: "x".repeat(1001) },
  ]) assert.equal(reviseProductProfileInputSchema.safeParse(body).success, false);
});

test("bottle corrections cannot change lifecycle, notes, identity or derived state", () => {
  for (const patch of [
    {}, { expires_on: undefined }, { opened_on: "2026-02-30" },
    { opened_on_accuracy: "legacy_unknown" }, { lifecycle_status: "opened" },
    { remaining_percent_estimate: 0 }, { product_id: "other" },
    { custom_notes: "different" }, { usable_until: "2026-09-05" },
  ]) assert.equal(correctInventoryItemFactsInputSchema.safeParse({ expected_revision: 2, ...patch }).success, false);
  assert.deepEqual(correctInventoryItemFactsInputSchema.parse({ expected_revision: 2, expires_on: null }), { expected_revision: 2, expires_on: null });
});

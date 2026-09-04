import assert from "node:assert/strict";
import test from "node:test";
import { inventoryListItemOutputSchema, type InventoryListItemOutput } from "@beautio/contracts";
import { changedProductPao, inventoryPaoScope, paoDurationLabel, paoForBottleUpdate, parsePaoDuration } from "../src/features/inventory/models/pao-model.ts";

test("linked bottles show shared Product PAO without exposing a bottle editor", () => {
  const item = linkedItem(12, 12);
  assert.deepEqual(inventoryPaoScope(item), {
    productMonths: 12, bottleMonths: 12, bottleEditable: false, missingProduct: false, hasHistoricalDifference: false,
  });
  assert.equal(paoForBottleUpdate(item, "6"), 12);
  assert.equal(paoForBottleUpdate(item, "invalid"), 12);
});

test("legacy bottle duration does not fill a missing shared Product value", () => {
  const item = linkedItem(null, 6);
  const scope = inventoryPaoScope(item);
  assert.equal(scope.productMonths, null);
  assert.equal(scope.bottleMonths, 6);
  assert.equal(scope.hasHistoricalDifference, true);
  assert.equal(scope.bottleEditable, false);
  assert.equal(paoForBottleUpdate(item, "12"), 6);
});

test("different legacy bottle durations remain explicit and are preserved by the full-facts PUT", () => {
  for (const bottleMonths of [null, 6]) {
    const item = linkedItem(12, bottleMonths);
    const scope = inventoryPaoScope(item);
    assert.equal(scope.productMonths, 12);
    assert.equal(scope.bottleMonths, bottleMonths);
    assert.equal(scope.hasHistoricalDifference, true);
    assert.equal(paoForBottleUpdate(item, "24"), bottleMonths);
  }
});

test("a missing Product join does not authorize editing the linked bottle's PAO", () => {
  const item = inventoryListItemOutputSchema.parse({ ...linkedItem(null, 6), product: null });
  const scope = inventoryPaoScope(item);
  assert.equal(scope.productMonths, null);
  assert.equal(scope.missingProduct, true);
  assert.equal(scope.bottleEditable, false);
  assert.equal(scope.hasHistoricalDifference, false);
  assert.equal(paoForBottleUpdate(item, "12"), 6);
});

test("genuinely unlinked inventory can still enter or clear a single-bottle PAO", () => {
  const item = inventoryListItemOutputSchema.parse({ ...linkedItem(null, 6), product_id: null, product: null });
  assert.equal(inventoryPaoScope(item).bottleEditable, true);
  assert.equal(paoForBottleUpdate(item, "12"), 12);
  assert.equal(paoForBottleUpdate(item, " "), null);
  assert.equal(paoForBottleUpdate(item, "121"), undefined);
});

test("unrelated Product edits omit unchanged PAO rather than resetting historical differences", () => {
  assert.deepEqual(changedProductPao(12, 12), {});
  assert.deepEqual(changedProductPao(null, null), {});
  const normalized = parsePaoDuration(" 12 ");
  assert.equal(normalized, 12);
  assert.deepEqual(changedProductPao(12, normalized), {});
  assert.deepEqual(changedProductPao(6, 12), { pao_duration_months: 12 });
  assert.deepEqual(changedProductPao(null, 12), { pao_duration_months: 12 });
  assert.deepEqual(changedProductPao(12, null), { pao_duration_months: null });
});

test("PAO parsing retains explicit blank and integer boundaries", () => {
  assert.equal(parsePaoDuration(""), null);
  assert.equal(parsePaoDuration(" \n "), null);
  assert.equal(parsePaoDuration("1"), 1);
  assert.equal(parsePaoDuration("120"), 120);
  for (const input of ["0", "121", "-1", "+1", "1.5", "1e2", "0x10", "unknown"]) {
    assert.equal(parsePaoDuration(input), undefined);
  }
});

test("PAO labels localize units and explicitly show unknown Product duration", () => {
  assert.equal(paoDurationLabel(12, "en", (copy) => copy), "12 months");
  assert.equal(paoDurationLabel(12, "zh-CN", (copy) => copy), "12 个月");
  assert.equal(paoDurationLabel(null, "en", () => "Not recorded"), "Not recorded");
});

function linkedItem(productMonths: number | null, bottleMonths: number | null): InventoryListItemOutput {
  return inventoryListItemOutputSchema.parse({
    inventory_item_id: "example-bottle", created_at: null, lifecycle_status: "unopened",
    opened_on: null, opened_on_accuracy: null, expires_on: null, pao_duration_months: bottleMonths,
    pao_deadline: null, pao_deadline_accuracy: null, usable_until: null,
    remaining_percent_estimate: null, usability_status: "unknown",
    warnings: [], custom_notes: null, product_id: "example-product",
    product: {
      product_id: "example-product", name: "Example serum", alias: null, brand: null, category: null,
      size_label: "30 ml", pao_duration_months: productMonths, image_asset_id: null, image_ref: null,
      ingredient_list_text: null, shared_notes: null,
    },
    product_inventory_position: null, product_inventory_count: null,
  });
}

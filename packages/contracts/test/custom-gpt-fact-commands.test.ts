import assert from "node:assert/strict";
import test from "node:test";
import {
  customGptCorrectInventoryItemFactsInputSchema, customGptEndInventoryItemUseInputSchema,
  customGptFactCommandOutputSchema, customGptRecordProductOpenedInputSchema,
  customGptReviseProductProfileInputSchema, customGptSetInventoryItemCustomNotesInputSchema,
  parseFactCommandSuccessResult,
} from "../src/index.ts";

const command_id = "123e4567-e89b-42d3-a456-426614174000";

test("five fact command contracts require separate canonical identity and preserve narrow business inputs", () => {
  for (const [schema, body] of [
    [customGptReviseProductProfileInputSchema, { expected_revision: 1, name: "Sample name" }],
    [customGptCorrectInventoryItemFactsInputSchema, { expected_revision: 1, expires_on: null }],
    [customGptSetInventoryItemCustomNotesInputSchema, { custom_notes: " Sample notes " }],
    [customGptRecordProductOpenedInputSchema, { opened_on: "2026-09-05", opened_on_accuracy: "exact" }],
    [customGptEndInventoryItemUseInputSchema, { as_of: "2026-09-05", lifecycle_status: "finished" }],
  ] as const) {
    assert.equal(schema.safeParse({ command_id, ...body }).success, true);
    assert.equal(schema.safeParse(body).success, false);
    assert.equal(schema.safeParse({ command_id: command_id.toUpperCase(), ...body }).success, false);
    for (const extra of [{ inventory_item_id: "other" }, { operation_id: "open" }, { principal: "admin" }]) {
      assert.equal(schema.safeParse({ command_id, ...body, ...extra }).success, false);
    }
  }
  assert.equal(customGptReviseProductProfileInputSchema.safeParse({ command_id, expected_revision: 1 }).success, false);
  assert.equal(customGptCorrectInventoryItemFactsInputSchema.safeParse({ command_id, expected_revision: 1 }).success, false);
  assert.equal(customGptReviseProductProfileInputSchema.safeParse({ command_id, expected_revision: 1, name: undefined }).success, false);
  assert.equal(customGptRecordProductOpenedInputSchema.safeParse({ command_id, opened_on: "2026-09-05", opened_on_accuracy: "legacy_unknown" }).success, false);
  assert.equal(customGptSetInventoryItemCustomNotesInputSchema.parse({ command_id, custom_notes: "  " }).custom_notes, null);
  assert.equal(customGptEndInventoryItemUseInputSchema.safeParse({ command_id, as_of: "2026-09-05", lifecycle_status: "discarded" }).success, false);
  assert.equal(customGptEndInventoryItemUseInputSchema.safeParse({ command_id, as_of: "2026-09-05", lifecycle_status: "finished", remaining_percent_estimate: 0 }).success, false);
});

test("fact command receipts reject wrong operation, arbitrary stored fields and impossible status combinations", () => {
  const output = {
    operation_id: "revise_product_profile", command_id, status: "succeeded",
    created_at: "2026-09-05T00:00:00.000Z", completed_at: "2026-09-05T00:01:00.000Z",
    failure_code: null, result: { product_id: "product", revision: 7, outcome: "updated" },
  };
  assert.equal(customGptFactCommandOutputSchema.safeParse(output).success, true);
  for (const invalid of [
    { ...output, operation_id: "record_product_opened" },
    { ...output, result: { ...output.result, shared_notes: "Never store a body" } },
    { ...output, status: "in_progress" }, { ...output, status: "failed", failure_code: "INTERNAL_ERROR", result: null },
  ]) assert.equal(customGptFactCommandOutputSchema.safeParse(invalid).success, false);
  assert.equal(parseFactCommandSuccessResult("upload_product_images", output.result), null);
  assert.equal(parseFactCommandSuccessResult("revise_product_profile", { ...output.result, image_asset_id: "hidden" }), null);
});

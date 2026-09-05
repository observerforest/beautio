import assert from "node:assert/strict";
import test from "node:test";
import { createCommandSuccessResultSchema, customGptCreateCommandInputSchema, customGptCreateCommandOutputSchema, parseCustomGptCommandSuccessResult } from "../src/index.ts";

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

test("create command preserves legacy batch limits while requiring a separate canonical command UUID", () => {
  const input = { command_id: uuid(0), as_of: "2026-09-05", products: [], inventory_items: [{ batch_ref: "bottle", product_ref: { kind: "existing", product_id: "opaque-product" }, lifecycle_status: "unopened" }] };
  assert.equal(customGptCreateCommandInputSchema.parse(input).inventory_items.length, 1);
  const { command_id: _command, ...legacy } = input;
  for (const value of [legacy, { ...input, command_id: "invalid" }, { ...input, operation_id: "create_inventory_batch" }, { ...input, inventory_items: Array(101).fill(input.inventory_items[0]) }]) {
    assert.equal(customGptCreateCommandInputSchema.safeParse(value).success, false);
  }
  assert.equal(customGptCreateCommandInputSchema.safeParse({ ...input, products: Array.from({ length: 25 }, (_, index) => ({ batch_ref: String(index).padStart(64, "x"), name: "Confirmed", ingredient_list_text: "成".repeat(5000), shared_notes: "共".repeat(1000) })), inventory_items: Array(100).fill(input.inventory_items[0]) }).success, true);
});

test("the full maximum create receipt is 3944 UTF-8 bytes and status never exposes extra historical fields", () => {
  const result = { outcome: "created", inventory_item_ids: Array.from({ length: 100 }, (_, index) => uuid(index)) };
  assert.equal(Buffer.byteLength(JSON.stringify(createCommandSuccessResultSchema.parse(result)), "utf8"), 3944);
  for (const bad of [{ ...result, products: [] }, { outcome: "created", inventory_item_ids: [uuid(1), uuid(1)] }, { outcome: "created", inventory_item_ids: ["x".repeat(1000)] }, { outcome: "created", inventory_item_ids: [] }]) {
    assert.equal(parseCustomGptCommandSuccessResult("create_inventory_batch", bad), null);
  }
  assert.equal(parseCustomGptCommandSuccessResult("upload_product_images", result), null);
  const output = customGptCreateCommandOutputSchema.parse({ operation_id: "create_inventory_batch", command_id: uuid(0), status: "succeeded", created_at: "2026-09-05T00:00:00.000Z", completed_at: "2026-09-05T00:00:00.001Z", failure_code: null, result });
  assert.ok(Buffer.byteLength(JSON.stringify(output), "utf8") < 8192);
});

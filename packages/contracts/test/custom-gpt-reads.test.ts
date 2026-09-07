import assert from "node:assert/strict";
import test from "node:test";
import {
  consequentialCommandOperationIds,
  customGptCommandStatusOutputSchema,
  customGptFetchInputSchema,
  customGptSearchInputSchema,
  getCommandStatusInputSchema,
  inventorySearchOptionsSchema,
  searchInventoryInputSchema,
} from "../src/index.ts";

const commandIdentity = {
  operation_id: "revise_product_profile",
  command_id: "123e4567-e89b-42d3-a456-426614174000",
};

test("Custom GPT search defaults to active while legacy search and options retain their contracts", () => {
  assert.deepEqual(customGptSearchInputSchema.parse({}), { offset: 0, limit: 20, scope: "active" });
  assert.deepEqual(searchInventoryInputSchema.parse({}), { offset: 0, limit: 20 });
  assert.deepEqual(inventorySearchOptionsSchema.parse({}), { scope: "all" });
  for (const scope of ["active", "archived", "all"]) {
    assert.equal(customGptSearchInputSchema.parse({ scope }).scope, scope);
  }
  for (const input of [{ scope: "opened" }, { scope: null }, { limit: 51 }, { offset: -1 }, { as_of: "2026-02-30" }, { query: " " }, { principal: "admin" }]) {
    assert.equal(customGptSearchInputSchema.safeParse(input).success, false);
  }
  assert.equal(searchInventoryInputSchema.safeParse({ scope: "active" }).success, false);
  assert.equal(inventorySearchOptionsSchema.safeParse({ scope: "all", limit: 1 }).success, false);
});

test("Custom GPT fetch accepts only an ID, optional date and a nonempty candidate image ID", () => {
  assert.deepEqual(customGptFetchInputSchema.parse({ inventory_item_id: " bottle " }), { inventory_item_id: "bottle" });
  assert.equal(customGptFetchInputSchema.safeParse({ inventory_item_id: "bottle", expected_image_asset_id: "candidate" }).success, true);
  for (const input of [
    {}, { inventory_item_id: " " }, { inventory_item_id: "bottle", expected_image_asset_id: null },
    { inventory_item_id: "bottle", expected_image_asset_id: " " }, { inventory_item_id: "bottle", as_of: "yesterday" },
    { inventory_item_id: "bottle", image_asset_id: "candidate" }, { inventory_item_id: "bottle", principal: "admin" },
  ]) {
    assert.equal(customGptFetchInputSchema.safeParse(input).success, false);
  }
});

test("command status validates canonical identity and enforces safe status-specific projections", () => {
  assert.equal(getCommandStatusInputSchema.safeParse(commandIdentity).success, true);
  assert.equal(getCommandStatusInputSchema.safeParse({ ...commandIdentity, principal: "admin" }).success, false);
  assert.equal(getCommandStatusInputSchema.safeParse({ ...commandIdentity, command_id: commandIdentity.command_id.toUpperCase() }).success, false);
  assert.equal(getCommandStatusInputSchema.safeParse({ ...commandIdentity, operation_id: "restore_backup" }).success, false);
  const missing = { ...commandIdentity, status: "not_found", created_at: null, completed_at: null, failure_code: null, result: null };
  assert.equal(customGptCommandStatusOutputSchema.safeParse(missing).success, true);
  const created = "2026-09-05T00:00:00.000Z";
  const completed = "2026-09-05T00:01:00.000Z";
  for (const output of [
    { ...missing, status: "in_progress", created_at: created },
    { ...missing, status: "succeeded", created_at: created, completed_at: completed },
    { ...missing, status: "failed", created_at: created, completed_at: completed, failure_code: "REVISION_CONFLICT" },
  ]) {
    assert.equal(customGptCommandStatusOutputSchema.safeParse(output).success, true);
  }
  for (const output of [
    { ...missing, result: {} }, { ...missing, message: "Internal" }, { ...missing, ref: "Internal" },
    { ...missing, status: "succeeded" }, { ...missing, status: "in_progress", created_at: created, completed_at: completed },
    { ...missing, status: "failed", created_at: created, completed_at: completed },
  ]) {
    assert.equal(customGptCommandStatusOutputSchema.safeParse(output).success, false);
  }
});

test("command status accepts each operation's strict success receipt and rejects cross-operation or expanded results", () => {
  const created = "2026-09-05T00:00:00.000Z";
  const completed = "2026-09-05T00:01:00.000Z";
  const createResult = {
    outcome: "created",
    inventory_item_ids: ["00000000-0000-4000-8000-000000000001"],
  } as const;
  const uploadResult = {
    outcome: "uploaded",
    image_asset_ids: ["00000000-0000-4000-8000-000000000002"],
    expires_at: "2026-09-05T00:02:00.000Z",
  } as const;
  const productResult = {
    outcome: "updated",
    product_id: "synthetic-product",
    revision: 2,
  } as const;
  const inventoryResult = {
    outcome: "updated",
    inventory_item_id: "synthetic-bottle",
    revision: 3,
  } as const;
  const openedResult = {
    outcome: "opened",
    inventory_item_id: "synthetic-bottle",
    revision: 4,
  } as const;
  const endedResult = {
    outcome: "finished",
    inventory_item_id: "synthetic-bottle",
    revision: 5,
  } as const;
  const cases = [
    { operation_id: "upload_product_images", result: uploadResult, cross_operation_result: createResult },
    { operation_id: "create_inventory_batch", result: createResult, cross_operation_result: uploadResult },
    { operation_id: "revise_product_profile", result: productResult, cross_operation_result: inventoryResult },
    { operation_id: "set_product_display_image", result: productResult, cross_operation_result: inventoryResult },
    { operation_id: "correct_inventory_item_facts", result: inventoryResult, cross_operation_result: productResult },
    { operation_id: "set_inventory_item_custom_notes", result: inventoryResult, cross_operation_result: openedResult },
    { operation_id: "record_product_opened", result: openedResult, cross_operation_result: endedResult },
    { operation_id: "end_inventory_item_use", result: endedResult, cross_operation_result: openedResult },
  ] as const;

  assert.deepEqual(cases.map(({ operation_id }) => operation_id), consequentialCommandOperationIds);
  for (const [index, entry] of cases.entries()) {
    const output = {
      operation_id: entry.operation_id,
      command_id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      status: "succeeded",
      created_at: created,
      completed_at: completed,
      failure_code: null,
      result: entry.result,
    };
    assert.equal(customGptCommandStatusOutputSchema.safeParse(output).success, true, entry.operation_id);
    assert.equal(customGptCommandStatusOutputSchema.safeParse({ ...output, result: null }).success, true, `${entry.operation_id} legacy null result`);
    assert.equal(customGptCommandStatusOutputSchema.safeParse({ ...output, result: entry.cross_operation_result }).success, false, `${entry.operation_id} cross-operation result`);
    assert.equal(customGptCommandStatusOutputSchema.safeParse({ ...output, result: { ...entry.result, internal_detail: "not public" } }).success, false, `${entry.operation_id} expanded result`);
  }

  const canonical = {
    operation_id: "create_inventory_batch",
    command_id: "abcdefab-cdef-4abc-8abc-abcdefabcdef",
    status: "succeeded",
    created_at: created,
    completed_at: completed,
    failure_code: null,
    result: null,
  } as const;
  assert.equal(customGptCommandStatusOutputSchema.safeParse({ ...canonical, operation_id: "restore_backup" }).success, false);
  assert.equal(customGptCommandStatusOutputSchema.safeParse({ ...canonical, command_id: canonical.command_id.toUpperCase() }).success, false);
});

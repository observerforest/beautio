import assert from "node:assert/strict";
import { CustomGptFactWriteService } from "@beautio/application";
import {
  customGptCommandStatusOutputSchema,
  customGptFactActionErrorSchema,
  customGptFactCommandOutputSchema,
  customGptFetchOutputSchema,
} from "@beautio/contracts";
import test from "node:test";
import { factActionFixture, factCommandId } from "./custom-gpt-fact-action-fixture.ts";

const cases = [
  {
    operation: "revise_product_profile",
    method: "PATCH",
    path: "/api/actions/products/product/profile",
    otherTarget: "/api/actions/products/other-product/profile",
    fields: { alias: "Sample A" },
    changedFields: { alias: "Sample B" },
    revisionKind: "product",
    outcome: "updated",
    productChanges: { alias: "Sample A" },
    itemChanges: {},
  },
  {
    operation: "correct_inventory_item_facts",
    method: "PATCH",
    path: "/api/actions/inventory-items/bottle/facts",
    otherTarget: "/api/actions/inventory-items/other-bottle/facts",
    fields: { expires_on: "2030-12-31" },
    changedFields: { expires_on: "2031-12-31" },
    revisionKind: "inventory_item",
    outcome: "updated",
    productChanges: {},
    itemChanges: { expires_on: "2030-12-31" },
  },
  {
    operation: "record_product_opened",
    method: "POST",
    path: "/api/actions/inventory-items/bottle/open",
    otherTarget: "/api/actions/inventory-items/other-bottle/open",
    fields: { opened_on: "2026-09-05", opened_on_accuracy: "exact" },
    changedFields: { opened_on_accuracy: "estimated" },
    revisionKind: null,
    outcome: "opened",
    productChanges: {},
    itemChanges: { lifecycle_status: "opened", opened_on: "2026-09-05", opened_on_accuracy: "exact" },
  },
  {
    operation: "end_inventory_item_use",
    method: "POST",
    path: "/api/actions/inventory-items/bottle/end-use",
    otherTarget: "/api/actions/inventory-items/other-bottle/end-use",
    fields: { as_of: "2026-09-05", lifecycle_status: "discarded", remaining_percent_estimate: 25 },
    changedFields: { remaining_percent_estimate: 30 },
    revisionKind: null,
    outcome: "discarded",
    productChanges: {},
    itemChanges: { lifecycle_status: "discarded", remaining_percent_estimate: 25 },
  },
] as const;

for (const sample of cases) {
  test(`${sample.operation} replays one effect and rejects changed fields and target${sample.revisionKind === null ? "" : " and revision"}`, { timeout: 10_000 }, async (context) => {
    let effects = 0;
    const fixture = await factActionFixture(context, {
      createFactWrites: ({ repository, commands }) => new CustomGptFactWriteService({
        async executeFactCommand(input) {
          effects++;
          return repository.executeFactCommand(input);
        },
      }, commands),
    });
    // Ending use requires an opened bottle; this setup command is outside the measured command.
    if (sample.operation === "end_inventory_item_use") {
      await command(fixture.request("POST", "/api/actions/inventory-items/bottle/open", {
        command_id: factCommandId(99), opened_on: "2026-09-05", opened_on_accuracy: "exact",
      }));
    }
    const before = await fetchBottle(fixture);
    assert.ok(before.inventory_item.product);
    const productBefore = fixture.database.prepare("SELECT * FROM products WHERE id = 'product'").get();
    const itemBefore = fixture.database.prepare("SELECT * FROM inventory_items WHERE id = 'bottle'").get();
    assert.ok(productBefore && itemBefore);
    const commandCount = fixture.database.prepare("SELECT count(*) AS total FROM command_executions").get()?.total;
    assert.equal(typeof commandCount, "number");
    const effectsBefore = effects;
    const expectedRevision = sample.revisionKind === "product" ? before.inventory_item.product.revision : before.inventory_item.revision;
    const body = {
      command_id: factCommandId(1),
      ...(sample.revisionKind === null ? {} : { expected_revision: expectedRevision }),
      ...sample.fields,
    };

    const first = await command(fixture.request(sample.method, sample.path, body));
    assert.equal(first.operation_id, sample.operation);
    assert.equal(first.command_id, body.command_id);
    assert.equal(first.status, "succeeded");
    assert.ok(first.result);
    assert.equal(first.result.outcome, sample.outcome);
    assert.equal("product_id" in first.result ? first.result.product_id : first.result.inventory_item_id,
      sample.revisionKind === "product" ? "product" : "bottle");
    assert.equal(effects, effectsBefore + 1);
    const after = await fetchBottle(fixture);
    assert.ok(after.inventory_item.product);
    const updatedRevision = sample.revisionKind === "product" ? after.inventory_item.product.revision : after.inventory_item.revision;
    assert.ok(updatedRevision > expectedRevision);
    assert.equal(first.result.revision, updatedRevision);
    const entityKind = sample.revisionKind === "product" ? "product" : "inventory_item";
    const entityId = entityKind === "product" ? "product" : "bottle";
    assert.equal(fixture.database.prepare("SELECT revision FROM entity_revisions WHERE entity_kind = ? AND entity_id = ?")
      .get(entityKind, entityId)?.revision, updatedRevision);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM command_executions").get()?.total, Number(commandCount) + 1);
    const persistedCommand = fixture.database.prepare("SELECT operation_id, status, result_json FROM command_executions WHERE command_id = ?").get(body.command_id);
    assert.equal(persistedCommand?.operation_id, sample.operation);
    assert.equal(persistedCommand?.status, "succeeded");
    assert.deepEqual(JSON.parse(String(persistedCommand?.result_json)), first.result);
    const productAfter = fixture.database.prepare("SELECT * FROM products WHERE id = 'product'").get();
    const itemAfter = fixture.database.prepare("SELECT * FROM inventory_items WHERE id = 'bottle'").get();
    if (sample.revisionKind === "product") {
      assert.deepEqual(itemAfter, itemBefore);
      assert.equal(after.inventory_item.revision, before.inventory_item.revision);
    } else {
      assert.deepEqual(productAfter, productBefore);
      assert.equal(after.inventory_item.product.revision, before.inventory_item.product.revision);
    }
    for (const [field, value] of Object.entries(sample.productChanges)) {
      assert.equal(productAfter?.[field], value);
      assert.equal(after.inventory_item.product[field as keyof typeof after.inventory_item.product], value);
    }
    for (const [field, value] of Object.entries(sample.itemChanges)) {
      assert.equal(itemAfter?.[field], value);
      assert.equal(after.inventory_item[field as keyof typeof after.inventory_item], value);
    }
    if (sample.operation === "end_inventory_item_use") {
      assert.equal(itemAfter?.opened_on, itemBefore.opened_on);
      assert.equal(Object.hasOwn(after.inventory_item, "ended_on"), false);
      assert.equal(Object.hasOwn(first.result, "ended_on"), false);
    }

    const afterFirst = fixture.snapshot();
    assert.deepEqual(await command(fixture.request(sample.method, sample.path, body)), first);
    assert.equal(effects, effectsBefore + 1);
    assert.deepEqual(fixture.snapshot(), afterFirst);
    assert.deepEqual(await fetchBottle(fixture), after);

    const conflicts = [
      { path: sample.path, body: { ...body, ...sample.changedFields } },
      { path: sample.otherTarget, body },
      ...(sample.revisionKind === null ? [] : [{ path: sample.path, body: { ...body, expected_revision: expectedRevision + 1 } }]),
    ];
    for (const conflict of conflicts) {
      const response = await fixture.request(sample.method, conflict.path, conflict.body);
      assert.equal(response.status, 409);
      assert.equal(customGptFactActionErrorSchema.parse(await response.json()).error.code, "COMMAND_PAYLOAD_CONFLICT");
      assert.equal(effects, effectsBefore + 1);
      assert.deepEqual(fixture.snapshot(), afterFirst);
    }
    const statusResponse = await fixture.request("POST", "/api/actions/commands/status", {
      operation_id: sample.operation, command_id: body.command_id,
    });
    assert.equal(statusResponse.status, 200);
    assert.deepEqual(customGptCommandStatusOutputSchema.parse(await statusResponse.json()), first);
  });
}

async function command(responsePromise: Promise<Response>) {
  const response = await responsePromise;
  assert.equal(response.status, 200);
  return customGptFactCommandOutputSchema.parse(await response.json());
}

async function fetchBottle(fixture: Awaited<ReturnType<typeof factActionFixture>>) {
  const response = await fixture.request("POST", "/api/actions/inventory/fetch", { inventory_item_id: "bottle" });
  assert.equal(response.status, 200);
  return customGptFetchOutputSchema.parse(await response.json());
}

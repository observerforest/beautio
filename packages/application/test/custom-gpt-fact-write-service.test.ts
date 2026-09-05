import assert from "node:assert/strict";
import test from "node:test";
import { commandIdSchema } from "@beautio/contracts";
import { parseNullableIsoInstant } from "@beautio/domain";
import { CustomGptFactWriteService, type PreparedFactCommand } from "../src/index.ts";
import { prepareFactCommandValue } from "../src/fact-command-preparation.ts";

const command_id = "123e4567-e89b-42d3-a456-426614174000";

test("fact preparation hashes every normalized business value and target while owning caller data", () => {
  const body = { command_id, expected_revision: 1, name: "  Sample cream  " };
  const first = prepareFactCommandValue("revise_product_profile", " product ", body);
  body.name = "Mutated later";
  assert.equal(first.mutation.operationId, "revise_product_profile");
  if (first.mutation.operationId !== "revise_product_profile") throw new Error("Expected profile preparation");
  assert.equal(first.mutation.input.name, "Sample cream");
  assert.equal(Object.isFrozen(first.mutation), true);
  assert.equal(Object.isFrozen(first.mutation.input), true);
  const reordered = prepareFactCommandValue("revise_product_profile", "product", { name: "Sample cream", expected_revision: 1, command_id });
  assert.equal(first.payload.sha256, reordered.payload.sha256);
  for (const [target, patch] of [
    ["other-product", { name: "Sample cream", expected_revision: 1 }],
    ["product", { name: "Sample cream", expected_revision: 2 }],
    ["product", { name: "Sample cream", expected_revision: 1, shared_notes: null }],
  ] as const) {
    assert.notEqual(first.payload.sha256, prepareFactCommandValue("revise_product_profile", target, { command_id, ...patch }).payload.sha256);
  }
  const opened = prepareFactCommandValue("record_product_opened", "bottle", { command_id, opened_on: "2026-09-05", opened_on_accuracy: "exact" });
  assert.notEqual(opened.payload.sha256, prepareFactCommandValue("record_product_opened", "bottle", { command_id, opened_on: "2026-09-05", opened_on_accuracy: "estimated" }).payload.sha256);
  const end = prepareFactCommandValue("end_inventory_item_use", "bottle", { command_id, as_of: "2026-09-05", lifecycle_status: "discarded", remaining_percent_estimate: null });
  assert.notEqual(end.payload.sha256, prepareFactCommandValue("end_inventory_item_use", "bottle", { command_id, as_of: "2026-09-06", lifecycle_status: "discarded", remaining_percent_estimate: null }).payload.sha256);
});

test("invalid bodies and oversized UTF-8 receipt bounds fail during preparation before claims", () => {
  let claims = 0;
  const service = new CustomGptFactWriteService({ async executeFactCommand() { throw new Error("Unexpected effect"); } }, {
    async execute() { claims++; throw new Error("Unexpected claim"); },
  });
  assert.throws(() => service.prepare("revise_product_profile", "product", { command_id, expected_revision: 1 }), { code: "INVALID_INPUT" });
  assert.throws(() => service.prepare("record_product_opened", "bottle", { command_id, opened_on: "2026-09-05", opened_on_accuracy: "legacy_unknown" }), { code: "INVALID_INPUT" });
  assert.throws(() => service.prepare("set_inventory_item_custom_notes", "漢".repeat(1400), { command_id, custom_notes: null }), { code: "COMMAND_RESULT_TOO_LARGE" });
  service.prepare("set_inventory_item_custom_notes", "x".repeat(1400), { command_id, custom_notes: null });
  assert.equal(claims, 0);
});

test("prepared fact handles are opaque, instance-bound and consumed once even when only replaying", async () => {
  let executions = 0;
  const createdAt = parseNullableIsoInstant("2026-09-05T00:00:00.000Z", "created_at");
  assert.ok(createdAt);
  const commands = {
    async execute() {
      executions++;
      return { outcome: "in_progress" as const, execution: {
        operationId: "set_inventory_item_custom_notes" as const, commandId: commandIdSchema.parse(command_id),
        status: "in_progress" as const, createdAt, completedAt: null, result: null, failure: null,
      } };
    },
  };
  const repository = { async executeFactCommand(): Promise<never> { throw new Error("Replay must not call effects"); } };
  const first = new CustomGptFactWriteService(repository, commands);
  const second = new CustomGptFactWriteService(repository, commands);
  const handle = first.prepare("set_inventory_item_custom_notes", "bottle", { command_id, custom_notes: null });
  assert.deepEqual(Object.keys(handle), []);
  await assert.rejects(second.executePrepared(handle), { code: "INVALID_INPUT" });
  await assert.rejects(first.executePrepared({} as PreparedFactCommand), { code: "INVALID_INPUT" });
  assert.equal((await first.executePrepared(handle)).status, "in_progress");
  await assert.rejects(first.executePrepared(handle), { code: "INVALID_INPUT" });
  assert.equal(executions, 1);
});

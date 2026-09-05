import assert from "node:assert/strict";
import test from "node:test";
import { commandIdSchema } from "@beautio/contracts";
import { parseNullableIsoInstant } from "@beautio/domain";
import { CustomGptCreateCommandService, type ClaimCommandExecutionResult, type PreparedCreateCommand } from "../src/index.ts";
import { prepareCreateCommandValue } from "../src/create-command-preparation.ts";

const command_id = "00000000-0000-4000-8000-000000000001";
function body() {
  return { command_id, as_of: "2026-09-05", products: [{ batch_ref: "new", name: "  Confirmed  ", shared_notes: " note\r\nline " }], inventory_items: [{ batch_ref: "first", product_ref: { kind: "new", batch_ref: "new" }, lifecycle_status: "unopened" }, { batch_ref: "second", product_ref: { kind: "existing", product_id: "product" }, lifecycle_status: "unopened" }] };
}

test("create preparation owns nested input and binds every normalized field, target and array order", () => {
  const input = body();
  const prepared = prepareCreateCommandValue(input);
  input.products[0]!.name = "Changed";
  input.inventory_items[1]!.product_ref.product_id = "other";
  assert.equal(prepared.input.products[0]?.name, "Confirmed");
  assert.ok(Object.isFrozen(prepared.input.inventory_items[0]?.product_ref));
  const normalized = body();
  normalized.products[0]!.name = "Confirmed";
  assert.equal(prepareCreateCommandValue(normalized).payload.sha256, prepared.payload.sha256);
  const variants = [body(), body(), body(), body(), body()];
  variants[0]!.as_of = "2026-09-06";
  variants[1]!.inventory_items.reverse();
  variants[2]!.inventory_items[1]!.product_ref.product_id = "other";
  variants[3]!.products[0]!.shared_notes = "other";
  variants[4]!.inventory_items[0]!.batch_ref = "other";
  for (const variant of variants) assert.notEqual(prepareCreateCommandValue(variant).payload.sha256, prepared.payload.sha256);
  assert.notEqual(prepareCreateCommandValue({ ...body(), products: [{ batch_ref: "new", name: "Confirmed", pao_duration_months: null }] }).payload.sha256, prepareCreateCommandValue({ ...body(), products: [{ batch_ref: "new", name: "Confirmed" }] }).payload.sha256);
});

test("create preparation and all replay states perform no generation or effect and handles are single-use", async () => {
  const createdAt = parseNullableIsoInstant("2026-09-05T00:00:00.000Z", "created_at");
  assert.ok(createdAt);
  for (const status of ["in_progress", "succeeded", "failed"] as const) {
    let claims = 0;
    let generations = 0;
    const result: ClaimCommandExecutionResult = { outcome: status, execution: {
      operationId: "create_inventory_batch", commandId: commandIdSchema.parse(command_id), status, createdAt,
      completedAt: status === "in_progress" ? null : createdAt,
      result: status === "succeeded" ? { outcome: "created", inventory_item_ids: ["00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000102"] } : null,
      failure: status === "failed" ? { code: "PRODUCT_NOT_FOUND", message: "Unavailable." } : null,
    } };
    const repository = { async executeCreateCommand(): Promise<never> { throw new Error("unexpected effect"); } };
    const commands = { async claim() { claims++; return result; }, async completeKnownFailure(): Promise<never> { throw new Error("unexpected settlement"); } };
    const service = new CustomGptCreateCommandService(repository, commands, { clock() { throw new Error("replay clock"); }, idGenerator() { generations++; throw new Error("replay generator"); } });
    const second = new CustomGptCreateCommandService(repository, commands);
    assert.throws(() => service.prepare({ ...body(), command_id: "invalid" }));
    assert.throws(() => service.prepare({ ...body(), products: [] }));
    const handle = service.prepare(body());
    assert.equal(claims, 0);
    assert.deepEqual(Object.keys(handle), []);
    await assert.rejects(second.executePrepared(handle), { code: "INVALID_INPUT" });
    await assert.rejects(service.executePrepared({} as PreparedCreateCommand), { code: "INVALID_INPUT" });
    assert.equal((await service.executePrepared(handle)).status, status);
    await assert.rejects(service.executePrepared(handle), { code: "INVALID_INPUT" });
    assert.equal(claims, 1);
    assert.equal(generations, 0);
  }
});

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  CommandExecutionService, CustomGptCreateCommandService, CustomGptReadService, InventoryApplicationService,
  createCanonicalCommandPayload, createSafeCommandResult,
  type CreateCommandRepository, type CustomGptCreateCommandServiceOptions,
} from "@beautio/application";
import { BeautioError } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { SqliteInventoryRepository } from "../src/index.ts";
import { executeCreateCommandRecord } from "../src/create-command-records.ts";
import { metadata, revisionFixture } from "./revision-test-fixtures.ts";

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const clock = () => new Date("2026-09-05T00:00:00.000Z");
function body(index = 1) {
  return { command_id: uuid(index), as_of: "2026-09-05", products: [{ batch_ref: "new", name: "Sample", alias: "Alias", brand: "Brand", category: "care", size_label: "10 ml", pao_duration_months: 6, image_asset_id: "image", ingredient_list_text: "Confirmed text", shared_notes: "Shared note" }], inventory_items: [
    { batch_ref: "new-bottle", product_ref: { kind: "new" as const, batch_ref: "new" }, lifecycle_status: "opened" as const, opened_on: "2026-09-05", opened_on_accuracy: "estimated" as const, custom_notes: "Bottle note" },
    { batch_ref: "old-product", product_ref: { kind: "existing" as const, product_id: "product" }, lifecycle_status: "unopened" as const },
  ] };
}
async function fixture(context: TestContext) {
  const result = await revisionFixture(context);
  result.database.exec("PRAGMA foreign_keys = ON");
  result.database.prepare("INSERT INTO image_assets (id, storage_key, media_type, byte_size, status, product_id, expires_at, created_at) VALUES (?, ?, ?, ?, 'temporary', NULL, ?, ?)")
    .run("image", "synthetic-key", "image/png", 1, "2026-09-06T00:00:00.000Z", "2026-09-05T00:00:00.000Z");
  return result;
}
function state(database: DatabaseSync) {
  return { ...metadata(database), products: database.prepare("SELECT * FROM products ORDER BY id").all(), items: database.prepare("SELECT * FROM inventory_items ORDER BY id").all(), images: database.prepare("SELECT * FROM image_assets ORDER BY id").all() };
}
function services(repository: SqliteInventoryRepository, port: CreateCommandRepository = repository, options: CustomGptCreateCommandServiceOptions = {}, commands = new CommandExecutionService(repository, clock)) {
  let effects = 0;
  let generations = 0;
  const service = new CustomGptCreateCommandService({ async executeCreateCommand(input) { effects++; return port.executeCreateCommand(input); } }, commands, {
    clock, idGenerator: () => uuid(100 + generations++), ...options,
  });
  const reads = new CustomGptReadService(new InventoryApplicationService(repository), repository, commands);
  return { service, reads, commands, effects: () => effects, generations: () => generations };
}
const run = (service: CustomGptCreateCommandService, input: unknown) => service.executePrepared(service.prepare(input));

test("create atomically persists receipt, ordered bottle mapping, image association and versioned independent reads", async (context) => {
  const { repository, database, databasePath } = await fixture(context);
  const { service, reads, effects, generations } = services(repository);
  const output = await run(service, body());
  assert.equal(output.status, "succeeded");
  assert.deepEqual(output.result, { outcome: "created", inventory_item_ids: [uuid(101), uuid(102)] });
  const first = await reads.fetchInventoryItem({ inventory_item_id: uuid(101), expected_image_asset_id: "image" });
  assert.equal(first.display_image_matches_expected, true);
  const snapshot = await repository.findVersionedInventoryItem(uuid(101));
  assert.ok(snapshot?.product);
  assert.equal(snapshot.product.product.id, uuid(100));
  assert.equal(snapshot.product.product.brand, "Brand");
  assert.equal(snapshot.product.product.alias, "Alias");
  assert.equal(snapshot.item.paoDurationMonths, 6);
  assert.equal(snapshot.item.paoDeadline, "2027-03-05");
  assert.equal(snapshot.item.createdAt, clock().toISOString());
  assert.equal(snapshot.item.openedOnAccuracy, "estimated");
  assert.equal((await repository.findVersionedInventoryItem(uuid(102)))?.item.productId, "product");
  const before = state(database);
  assert.deepEqual(await run(service, body()), output);
  assert.deepEqual(state(database), before);
  assert.equal(effects(), 1);
  assert.equal(generations(), 3);
  assert.deepEqual((await reads.getCommandStatus({ operation_id: "create_inventory_batch", command_id: uuid(1) })).result, output.result);
  const reopened = new SqliteInventoryRepository(databasePath);
  context.after(() => reopened.close());
  assert.deepEqual((await services(reopened).reads.getCommandStatus({ operation_id: "create_inventory_batch", command_id: uuid(1) })).result, output.result);
  const stored = String(database.prepare("SELECT result_json FROM command_executions").get()?.result_json);
  assert.equal(stored.includes("Confirmed"), false);
  assert.equal(stored.includes("image"), false);
  assert.equal(stored.includes("product"), false);
});

test("the maximum 25-Product 100-bottle text batch commits a complete 3944-byte receipt", async (context) => {
  const { repository, database } = await fixture(context);
  const products = Array.from({ length: 25 }, (_, index) => ({ batch_ref: String(index).padStart(64, "p"), name: `Sample ${index}`, ingredient_list_text: "成".repeat(5000), shared_notes: "共".repeat(1000) }));
  const input = { command_id: uuid(2), as_of: "2026-09-05", products, inventory_items: Array.from({ length: 100 }, (_, index) => ({ batch_ref: String(index).padStart(64, "b"), product_ref: { kind: "new", batch_ref: products[Math.floor(index / 4)]!.batch_ref }, lifecycle_status: "unopened", custom_notes: "瓶".repeat(1000) })) };
  assert.ok(Buffer.byteLength(JSON.stringify(input), "utf8") < 1024 * 1024);
  const { service, reads } = services(repository);
  const output = await run(service, input);
  assert.equal(output.status, "succeeded");
  assert.equal(output.result?.inventory_item_ids.length, 100);
  assert.equal(Buffer.byteLength(String(database.prepare("SELECT result_json FROM command_executions").get()?.result_json), "utf8"), 3944);
  for (const [index, id] of output.result!.inventory_item_ids.entries()) {
    const item = await repository.findVersionedInventoryItem(id);
    assert.equal(item?.product?.product.id, uuid(100 + Math.floor(index / 4)));
    assert.equal(item?.item.customNotes?.length, 1000);
    assert.equal(item?.product?.product.ingredientListText?.length, 5000);
    await reads.fetchInventoryItem({ inventory_item_id: id });
  }
});

test("same key conflicts bind target and payload while two connections admit one create effect", async (context) => {
  const { repository, databasePath, database } = await fixture(context);
  const second = new SqliteInventoryRepository(databasePath);
  context.after(() => second.close());
  const firstService = services(repository);
  const secondService = services(second);
  const results = await Promise.all([run(firstService.service, body(3)), run(secondService.service, body(3))]);
  assert.ok(results.some((result) => result.status === "succeeded"));
  assert.equal(firstService.effects() + secondService.effects(), 1);
  assert.equal(firstService.generations() + secondService.generations(), 3);
  const before = state(database);
  const changedTarget = body(3);
  changedTarget.inventory_items[1]!.product_ref = { kind: "existing", product_id: "other" };
  await assert.rejects(run(firstService.service, changedTarget), { code: "COMMAND_PAYLOAD_CONFLICT" });
  await assert.rejects(run(firstService.service, { ...body(3), as_of: "2026-09-06" }), { code: "COMMAND_PAYLOAD_CONFLICT" });
  assert.deepEqual(state(database), before);
});

test("only rollback-proven preflight rejections settle failed and replay without generating IDs", async (context) => {
  for (const reason of ["missing-product", "pao", "missing-image", "expired-image", "occupied-image", "duplicate-image", "opening"] as const) {
    await context.test(reason, async (subtest) => {
      const { repository, database } = await fixture(subtest);
      const input = body(4);
      if (reason === "missing-product") input.inventory_items[1]!.product_ref = { kind: "existing", product_id: "missing" };
      if (reason === "pao") input.products[0]!.pao_duration_months = 12;
      if (reason === "missing-image") input.products[0]!.image_asset_id = "missing";
      if (reason === "expired-image") database.exec("UPDATE image_assets SET expires_at = '2026-09-05T00:00:00.000Z'");
      if (reason === "occupied-image") database.exec("UPDATE image_assets SET status = 'pending_cleanup'");
      if (reason === "duplicate-image") { input.products.push({ ...input.products[0]!, batch_ref: "second" }); input.inventory_items[1]!.product_ref = { kind: "new", batch_ref: "second" }; }
      const actualInput = reason === "pao" ? { ...input, inventory_items: [{ ...input.inventory_items[0], pao_duration_months: 6 }, input.inventory_items[1]] }
        : reason === "opening" ? { ...input, inventory_items: [{ ...input.inventory_items[0], opened_on: null }, input.inventory_items[1]] } : input;
      const before = state(database);
      const { service, effects, generations } = services(repository);
      const output = await run(service, actualInput);
      assert.equal(output.status, "failed");
      assert.deepEqual(state(database), before);
      const count = generations();
      assert.deepEqual(await run(service, actualInput), output);
      assert.equal(generations(), count);
      assert.equal(effects(), 1);
    });
  }
});

test("new Product legacy PAO inference and explicit null retain the existing creation semantics", async (context) => {
  const { repository } = await fixture(context);
  const { service } = services(repository);
  for (const [index, pao] of [[0, undefined], [1, null]] as const) {
    const output = await run(service, { command_id: uuid(20 + index), as_of: "2026-09-05", products: [{ batch_ref: "new", name: "Sample", ...(pao === undefined ? {} : { pao_duration_months: pao }) }], inventory_items: [{ batch_ref: "bottle", product_ref: { kind: "new", batch_ref: "new" }, lifecycle_status: "unopened", pao_duration_months: 6 }] });
    const snapshot = await repository.findVersionedInventoryItem(output.result!.inventory_item_ids[0]!);
    assert.equal(snapshot?.product?.product.paoDurationMonths, pao === undefined ? 6 : null);
    assert.equal(snapshot?.item.paoDurationMonths, 6);
  }
});

test("an explicit existing reference cannot resolve through a coincidentally generated new Product ID", async (context) => {
  const { repository, database } = await fixture(context);
  const input = body(13);
  input.inventory_items[1]!.product_ref = { kind: "existing", product_id: uuid(100) };
  const before = state(database);
  const { service, effects } = services(repository);
  const result = await run(service, input);
  assert.equal(result.status, "failed");
  assert.equal(result.failure_code, "PRODUCT_NOT_FOUND");
  assert.deepEqual(state(database), before);
  assert.deepEqual(await run(service, input), result);
  assert.equal(effects(), 1);
});

test("existing Product raw text remains unchanged without requiring a normalization migration", async (context) => {
  const { repository, database } = await fixture(context);
  database.exec("UPDATE products SET brand = '  Legacy brand  ' WHERE id = 'product'");
  const { service } = services(repository);
  assert.equal((await run(service, body(14))).status, "succeeded");
  assert.equal(database.prepare("SELECT brand FROM products WHERE id = 'product'").get()?.brand, "  Legacy brand  ");
});

test("SQL faults after partial inserts roll back images, every fact, revisions and clock without failed settlement", async (context) => {
  for (const mode of ["ABORT", "ROLLBACK"]) await context.test(mode, async (subtest) => {
    const { repository, database } = await fixture(subtest);
    database.exec(`CREATE TRIGGER fail_second_bottle BEFORE INSERT ON inventory_items WHEN NEW.product_id = 'product' BEGIN SELECT RAISE(${mode}, 'synthetic fault'); END`);
    const before = state(database);
    const { service, commands, effects } = services(repository);
    await assert.rejects(run(service, body(5)), { code: "COMMAND_STORE_FAILURE" });
    assert.deepEqual(state(database), before);
    assert.equal((await commands.find({ operationId: "create_inventory_batch", commandId: uuid(5) }))?.status, "in_progress");
    assert.equal((await run(service, body(5))).status, "in_progress");
    assert.equal(effects(), 1);
  });
});

test("all confirmed fields and command CAS readback are verified before the shared COMMIT", async (context) => {
  const faults = {
    alias: "CREATE TRIGGER fault AFTER INSERT ON products BEGIN UPDATE products SET alias = 'Wrong' WHERE id = NEW.id; END",
    brand: "CREATE TRIGGER fault AFTER INSERT ON products BEGIN UPDATE products SET brand = 'Wrong' WHERE id = NEW.id; END",
    product: "CREATE TRIGGER fault AFTER INSERT ON inventory_items BEGIN UPDATE inventory_items SET product_id = 'product' WHERE id = NEW.id; END",
    pao: "CREATE TRIGGER fault AFTER INSERT ON inventory_items BEGIN UPDATE inventory_items SET pao_duration_months = 12 WHERE id = NEW.id; END",
    created: "CREATE TRIGGER fault AFTER INSERT ON inventory_items BEGIN UPDATE inventory_items SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = NEW.id; END",
    image: "CREATE TRIGGER fault AFTER UPDATE ON image_assets WHEN NEW.status = 'linked' BEGIN UPDATE image_assets SET product_id = 'product' WHERE id = NEW.id; END",
    "cas-abort": "CREATE TRIGGER fault BEFORE UPDATE ON command_executions WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'synthetic fault'); END",
    "cas-zero": "CREATE TRIGGER fault BEFORE UPDATE ON command_executions WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(IGNORE); END",
    "cas-result": `CREATE TRIGGER fault AFTER UPDATE ON command_executions WHEN NEW.status = 'succeeded' BEGIN UPDATE command_executions SET result_json = '{"outcome":"created","inventory_item_ids":["${uuid(999)}"]}' WHERE command_id = NEW.command_id; END`,
    "cas-business": "CREATE TRIGGER fault AFTER UPDATE ON command_executions WHEN NEW.status = 'succeeded' BEGIN UPDATE products SET brand = 'Wrong' WHERE id != 'product'; END",
    "cas-null-derived-storage": "CREATE TRIGGER fault AFTER UPDATE ON command_executions WHEN NEW.status = 'succeeded' BEGIN UPDATE inventory_items SET usable_until = NULL WHERE id != 'bottle' AND lifecycle_status = 'opened'; END",
    "cas-normalized-text-storage": "CREATE TRIGGER fault AFTER UPDATE ON command_executions WHEN NEW.status = 'succeeded' BEGIN UPDATE products SET brand = ' Brand ' WHERE id != 'product'; END",
  };
  for (const [name, sql] of Object.entries(faults)) await context.test(name, async (subtest) => {
    const { repository, database } = await fixture(subtest);
    database.exec(sql);
    const before = state(database);
    const { service, commands } = services(repository);
    await assert.rejects(run(service, body(6)), { code: "COMMAND_STORE_FAILURE" });
    assert.deepEqual(state(database), before);
    const command = await commands.find({ operationId: "create_inventory_batch", commandId: uuid(6) });
    assert.equal(command?.status, "in_progress");
    assert.equal(command?.result, null);
  });
});

test("COMMIT faults preserve business and success receipt together, including lost return after COMMIT", async (context) => {
  for (const mode of ["before", "after"]) await context.test(mode, async (subtest) => {
    const { repository, database } = await fixture(subtest);
    const originalExec = database.exec.bind(database);
    database.exec = (sql: string) => {
      if (sql === "COMMIT" && mode === "before") throw new Error("synthetic commit refusal");
      originalExec(sql);
      if (sql === "COMMIT" && mode === "after") throw new Error("synthetic lost commit return");
    };
    const before = state(database);
    const { service, reads, effects } = services(repository, { async executeCreateCommand(input) { return executeCreateCommandRecord(database, input); } });
    await assert.rejects(run(service, body(7)), { code: "COMMAND_STORE_FAILURE" });
    database.exec = originalExec;
    const status = await reads.getCommandStatus({ operation_id: "create_inventory_batch", command_id: uuid(7) });
    assert.equal(status.status, mode === "before" ? "in_progress" : "succeeded");
    if (mode === "before") assert.deepEqual(state(database), before);
    else {
      assert.ok(status.result && "inventory_item_ids" in status.result);
      assert.deepEqual(status.result.inventory_item_ids, [uuid(101), uuid(102)]);
      for (const id of status.result.inventory_item_ids) await reads.fetchInventoryItem({ inventory_item_id: id });
    }
    assert.equal((await run(service, body(7))).status, status.status);
    assert.equal(effects(), 1);
  });
});

test("claim uncertainty and failure settlement uncertainty never repeat creation", async (context) => {
  for (const mode of ["claim", "failure-before", "failure-after", "completion-clock"]) await context.test(mode, async (subtest) => {
    const { repository, database } = await fixture(subtest);
    const commands = new CommandExecutionService(repository, clock);
    if (mode === "claim") {
      const original = commands.claim.bind(commands);
      commands.claim = async (input) => { await original(input); throw new Error("lost claim return"); };
    } else if (mode.startsWith("failure")) {
      const original = commands.completeKnownFailure.bind(commands);
      commands.completeKnownFailure = async (...args) => { if (mode === "failure-after") await original(...args); throw new Error("failure settlement fault"); };
    }
    let clockCalls = 0;
    const { service, effects, reads } = services(repository, repository, { clock() { if (mode === "completion-clock" && ++clockCalls === 2) throw new Error("clock failed"); return clock(); } }, commands);
    const input = mode.startsWith("failure") ? { ...body(8), products: [{ ...body(8).products[0], image_asset_id: "missing" }] } : body(8);
    const before = state(database);
    await assert.rejects(run(service, input), { code: "COMMAND_STORE_FAILURE" });
    assert.deepEqual(state(database), before);
    const status = await reads.getCommandStatus({ operation_id: "create_inventory_batch", command_id: uuid(8) });
    assert.equal(status.status, mode === "failure-after" ? "failed" : "in_progress");
    assert.equal(effects(), mode === "claim" ? 0 : 1);
  });
});

test("generated ID failures, duplicates and stored collisions stop without regeneration or business writes", async (context) => {
  for (const mode of ["throw", "long", "duplicate", "existing"]) await context.test(mode, async (subtest) => {
    const { repository, database } = await fixture(subtest);
    if (mode === "existing") database.prepare("INSERT INTO products (id, name) VALUES (?, 'Existing')").run(uuid(900));
    let calls = 0;
    const { service, commands } = services(repository, repository, { idGenerator() { calls++; if (mode === "throw") throw new Error("generator failed"); return mode === "long" ? "x".repeat(1000) : mode === "existing" ? uuid(899 + calls) : uuid(900); } });
    const before = state(database);
    await assert.rejects(run(service, body(9)), { code: "COMMAND_STORE_FAILURE" });
    assert.deepEqual(state(database), before);
    const count = calls;
    assert.equal((await run(service, body(9))).status, "in_progress");
    assert.equal(calls, count);
    assert.equal((await commands.find({ operationId: "create_inventory_batch", commandId: uuid(9) }))?.status, "in_progress");
  });
});

test("the last safe revision can commit with its receipt while insufficient capacity rolls back the entire batch", async (context) => {
  for (const capacity of [3, 2]) await context.test(String(capacity), async (subtest) => {
    const { repository, database } = await fixture(subtest);
    database.prepare("UPDATE revision_clock SET high_water = ?").run(Number.MAX_SAFE_INTEGER - capacity);
    const before = state(database);
    const { service, reads } = services(repository);
    if (capacity === 3) {
      const output = await run(service, body(12));
      assert.equal(output.status, "succeeded");
      assert.equal(database.prepare("SELECT high_water FROM revision_clock").get()?.high_water, Number.MAX_SAFE_INTEGER);
    } else {
      await assert.rejects(run(service, body(12)), { code: "COMMAND_STORE_FAILURE" });
      assert.deepEqual(state(database), before);
      assert.equal((await reads.getCommandStatus({ operation_id: "create_inventory_batch", command_id: uuid(12) })).status, "in_progress");
    }
  });
});

test("BEGIN and explicit rollback failure leave claims unknown without hiding partial commits", async (context) => {
  for (const mode of ["begin", "rollback"]) await context.test(mode, async (subtest) => {
    const { repository, database } = await fixture(subtest);
    const before = state(database);
    const originalExec = database.exec.bind(database);
    database.exec = (sql: string) => { if (sql === (mode === "begin" ? "BEGIN IMMEDIATE" : "ROLLBACK")) throw new Error("synthetic transaction failure"); originalExec(sql); };
    const { service, reads } = services(repository, { async executeCreateCommand(input) { return executeCreateCommandRecord(database, input); } });
    const input = { ...body(10), products: [{ ...body(10).products[0], image_asset_id: "missing" }] };
    await assert.rejects(run(service, input), { code: "COMMAND_STORE_FAILURE" });
    database.exec = originalExec;
    if (mode === "rollback") database.exec("ROLLBACK");
    assert.deepEqual(state(database), before);
    assert.equal((await reads.getCommandStatus({ operation_id: "create_inventory_batch", command_id: uuid(10) })).status, "in_progress");
  });
});

test("post-commit adapter errors preserve succeeded IDs and status suppresses incompatible historical create bodies", async (context) => {
  const { repository } = await fixture(context);
  const { service, reads, commands, effects } = services(repository, { async executeCreateCommand(input) { await repository.executeCreateCommand(input); throw new BeautioError("INVALID_INPUT", "synthetic post-commit failure"); } });
  await assert.rejects(run(service, body(11)), { code: "COMMAND_STORE_FAILURE" });
  assert.equal((await reads.getCommandStatus({ operation_id: "create_inventory_batch", command_id: uuid(11) })).status, "succeeded");
  assert.equal((await run(service, body(11))).status, "succeeded");
  assert.equal(effects(), 1);
  for (const [index, result] of [
    { outcome: "created", products: [{ name: "private text" }], inventory_items: [] },
    { outcome: "created", inventory_item_ids: [uuid(101)], shared_notes: "private text" },
  ].entries()) {
    const claim = await commands.claim({ operationId: "create_inventory_batch", commandId: uuid(30 + index), payload: createCanonicalCommandPayload({ test: index }) });
    assert.equal(claim.outcome, "claimed");
    if (claim.outcome !== "claimed") throw new Error("missing claim");
    await commands.completeSuccess(claim.claim, createSafeCommandResult(result));
    const status = await reads.getCommandStatus({ operation_id: "create_inventory_batch", command_id: uuid(30 + index) });
    assert.equal(status.result, null);
    assert.equal(JSON.stringify(status).includes("private text"), false);
  }
});

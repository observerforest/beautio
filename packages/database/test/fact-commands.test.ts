import assert from "node:assert/strict";
import test from "node:test";
import {
  CommandExecutionService, CustomGptFactWriteService, CustomGptReadService,
  type CommandExecutionRepository, type FactCommandRepository,
} from "@beautio/application";
import { createInventoryItem, BeautioError } from "@beautio/domain";
import type { FactCommandOperationId } from "@beautio/contracts";
import { SqliteInventoryRepository } from "../src/index.ts";
import { metadata, revisionFixture, snapshot } from "./revision-test-fixtures.ts";

const commandId = (index: number) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;

test("five fact actions persist minimal receipts, replay once and expose safe status readback", async (context) => {
  const { repository, database } = await revisionFixture(context);
  const { service, reads, effects } = factServices(repository);
  let current = await snapshot(repository);
  assert.ok(current.product);
  const profile = await run(service, "revise_product_profile", "product", 1, { expected_revision: current.product.revision, name: "Updated sample", shared_notes: "Private shared note" });
  assert.equal(profile.status, "succeeded");
  assert.equal(profile.result?.outcome, "updated");
  current = await snapshot(repository);
  const corrected = await run(service, "correct_inventory_item_facts", "bottle", 2, { expected_revision: current.revision, expires_on: "2029-01-01" });
  assert.equal(corrected.status, "succeeded");
  const notes = await run(service, "set_inventory_item_custom_notes", "bottle", 3, { custom_notes: "Private bottle note" });
  const opened = await run(service, "record_product_opened", "bottle", 4, { opened_on: "2026-09-05", opened_on_accuracy: "estimated" });
  assert.equal(opened.result?.outcome, "opened");
  const afterOpen = metadata(database);
  assert.deepEqual(await run(service, "record_product_opened", "bottle", 4, { opened_on_accuracy: "estimated", opened_on: "2026-09-05" }), opened);
  assert.deepEqual(metadata(database), afterOpen);
  const sameOpening = await run(service, "record_product_opened", "bottle", 5, { opened_on: "2026-09-05", opened_on_accuracy: "estimated" });
  assert.equal(sameOpening.result?.outcome, "already_opened");
  assert.equal(sameOpening.result?.revision, opened.result?.revision);
  const ended = await run(service, "end_inventory_item_use", "bottle", 6, { as_of: "2026-09-05", lifecycle_status: "finished" });
  assert.equal(ended.result?.outcome, "finished");
  assert.equal((await snapshot(repository)).item.remainingPercentEstimate, 0);
  const terminalNotes = await run(service, "set_inventory_item_custom_notes", "bottle", 7, { custom_notes: null });
  assert.equal(terminalNotes.status, "succeeded");
  assert.equal((await snapshot(repository)).item.customNotes, null);
  assert.equal(effects(), 7);
  const status = await reads.getCommandStatus({ operation_id: "record_product_opened", command_id: commandId(4) });
  assert.deepEqual(status.result, opened.result);
  const stored = JSON.stringify(database.prepare("SELECT result_json, failure_message FROM command_executions").all());
  assert.equal(stored.includes("Private"), false);
  assert.equal(stored.includes("image"), false);
  assert.equal(stored.includes("expires_on"), false);
  for (const receipt of [profile, corrected, notes, opened, ended, terminalNotes]) {
    assert.ok(Buffer.byteLength(JSON.stringify(receipt.result), "utf8") <= 4096);
  }
});

test("same command key cannot change target or payload and concurrent connections run one effect", async (context) => {
  const { repository, databasePath, item, database } = await revisionFixture(context);
  await repository.seedInventoryItem(createInventoryItem({ ...item, id: "other" }));
  const second = new SqliteInventoryRepository(databasePath);
  context.after(() => second.close());
  const firstServices = factServices(repository);
  const secondServices = factServices(second);
  const request = { custom_notes: "Same notes" };
  const results = await Promise.all([
    run(firstServices.service, "set_inventory_item_custom_notes", "bottle", 10, request),
    run(secondServices.service, "set_inventory_item_custom_notes", "bottle", 10, request),
  ]);
  assert.ok(results.some((result) => result.status === "succeeded"));
  assert.equal(firstServices.effects() + secondServices.effects(), 1);
  const before = metadata(database);
  await assert.rejects(run(firstServices.service, "set_inventory_item_custom_notes", "other", 10, request), { code: "COMMAND_PAYLOAD_CONFLICT" });
  await assert.rejects(run(firstServices.service, "set_inventory_item_custom_notes", "bottle", 10, { custom_notes: "Changed" }), { code: "COMMAND_PAYLOAD_CONFLICT" });
  assert.deepEqual(metadata(database), before);
  assert.equal((await snapshot(repository, "other")).item.customNotes, item.customNotes);
  assert.equal(firstServices.effects() + secondServices.effects(), 1);
});

test("rollback-proven business conflicts settle failed once without changing facts or versions", async (context) => {
  const { repository, database, item } = await revisionFixture(context);
  const { service, effects } = factServices(repository);
  const current = await snapshot(repository);
  assert.ok(current.product);
  await run(service, "revise_product_profile", "product", 20, { expected_revision: current.product.revision, name: "New profile" });
  const before = metadata(database);
  const conflict = await run(service, "revise_product_profile", "product", 21, { expected_revision: current.product.revision, name: "Stale profile" });
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.failure_code, "REVISION_CONFLICT");
  assert.deepEqual(metadata(database), before);
  assert.deepEqual(await run(service, "revise_product_profile", "product", 21, { expected_revision: current.product.revision, name: "Stale profile" }), conflict);
  assert.equal(effects(), 2);
  const missing = await run(service, "set_inventory_item_custom_notes", "missing", 22, { custom_notes: "Nothing" });
  assert.equal(missing.failure_code, "INVENTORY_ITEM_NOT_FOUND");
  const unopened = await run(service, "end_inventory_item_use", "bottle", 23, { as_of: "2026-09-05", lifecycle_status: "discarded", remaining_percent_estimate: null });
  assert.equal(unopened.failure_code, "INVALID_INPUT");
  await repository.seedInventoryItem(createInventoryItem({ ...item, id: "terminal", lifecycleStatus: "finished" }));
  const terminal = await snapshot(repository, "terminal");
  const correction = await run(service, "correct_inventory_item_facts", "terminal", 24, { expected_revision: terminal.revision, expires_on: null });
  assert.equal(correction.failure_code, "INVENTORY_ITEM_TERMINAL");
  const opened = await run(service, "record_product_opened", "terminal", 25, { opened_on: "2026-09-05", opened_on_accuracy: "exact" });
  assert.equal(opened.failure_code, "INVENTORY_ITEM_TERMINAL");
});

test("SQL faults and automatic transaction rollback stay in progress and never retry effects", async (context) => {
  for (const abortMode of ["ABORT", "ROLLBACK"]) {
    await context.test(abortMode, async (nested) => {
      const { repository, database } = await revisionFixture(nested);
      const { service, reads, effects } = factServices(repository);
      const before = await repository.readBackupSnapshot();
      const beforeMetadata = metadata(database);
      database.exec(`CREATE TRIGGER reject_notes BEFORE UPDATE ON inventory_items
        BEGIN SELECT RAISE(${abortMode}, 'Injected private SQLite fault'); END`);
      await assert.rejects(run(service, "set_inventory_item_custom_notes", "bottle", 30, { custom_notes: "Attempt" }), { code: "COMMAND_STORE_FAILURE" });
      assert.deepEqual(await repository.readBackupSnapshot(), before);
      assert.deepEqual(metadata(database), beforeMetadata);
      database.exec("DROP TRIGGER reject_notes");
      assert.equal((await run(service, "set_inventory_item_custom_notes", "bottle", 30, { custom_notes: "Attempt" })).status, "in_progress");
      assert.equal((await reads.getCommandStatus({ operation_id: "set_inventory_item_custom_notes", command_id: commandId(30) })).status, "in_progress");
      assert.equal(effects(), 1);
    });
  }
});

test("PAO cascade SQL failure rolls back all facts and revision metadata and leaves the claim unknown", async (context) => {
  const { repository, database, item } = await revisionFixture(context);
  await repository.seedInventoryItem(createInventoryItem({ ...item, id: "z-last" }));
  const { service } = factServices(repository);
  const current = await snapshot(repository);
  assert.ok(current.product);
  const before = await repository.readBackupSnapshot();
  const beforeMetadata = metadata(database);
  database.exec(`CREATE TRIGGER reject_last BEFORE UPDATE ON inventory_items WHEN NEW.id = 'z-last'
    BEGIN SELECT RAISE(ABORT, 'Injected cascade fault'); END`);
  await assert.rejects(run(service, "revise_product_profile", "product", 31, { expected_revision: current.product.revision, pao_duration_months: 12 }), { code: "COMMAND_STORE_FAILURE" });
  assert.deepEqual(await repository.readBackupSnapshot(), before);
  assert.deepEqual(metadata(database), beforeMetadata);
});

test("a post-commit BeautioError is unknown even if its code resembles a zero-effect domain rejection", async (context) => {
  const { repository } = await revisionFixture(context);
  const effectRepository: FactCommandRepository = {
    async executeFactCommand(command) {
      await repository.executeFactCommand(command);
      throw new BeautioError("INVALID_INPUT", "Injected after committed write");
    },
  };
  const { service, effects } = factServices(repository, effectRepository);
  await assert.rejects(run(service, "set_inventory_item_custom_notes", "bottle", 40, { custom_notes: "Committed" }), { code: "COMMAND_STORE_FAILURE" });
  assert.equal((await snapshot(repository)).item.customNotes, "Committed");
  assert.equal((await run(service, "set_inventory_item_custom_notes", "bottle", 40, { custom_notes: "Committed" })).status, "in_progress");
  assert.equal(effects(), 1);
});

test("end-use verifies persisted terminal facts before committing a success receipt", async (context) => {
  for (const fault of ["lifecycle", "remaining"] as const) {
    await context.test(fault, async (nested) => {
      const { repository, database } = await revisionFixture(nested);
      const { service, reads } = factServices(repository);
      await run(service, "record_product_opened", "bottle", 50, { opened_on: "2026-09-05", opened_on_accuracy: "exact" });
      const before = await repository.readBackupSnapshot();
      const beforeMetadata = metadata(database);
      database.exec(fault === "lifecycle"
        ? `CREATE TRIGGER undo_terminal AFTER UPDATE ON inventory_items WHEN NEW.lifecycle_status = 'finished'
            BEGIN UPDATE inventory_items SET lifecycle_status = 'opened', remaining_percent_estimate = NULL WHERE id = NEW.id; END`
        : `CREATE TRIGGER undo_terminal AFTER UPDATE ON inventory_items WHEN NEW.lifecycle_status = 'discarded' AND NEW.remaining_percent_estimate = 50
            BEGIN UPDATE inventory_items SET remaining_percent_estimate = 25 WHERE id = NEW.id; END`);
      await assert.rejects(run(service, "end_inventory_item_use", "bottle", 51,
        fault === "lifecycle" ? { as_of: "2026-09-05", lifecycle_status: "finished" }
          : { as_of: "2026-09-05", lifecycle_status: "discarded", remaining_percent_estimate: 50 }),
      { code: "COMMAND_STORE_FAILURE" });
      assert.deepEqual(await repository.readBackupSnapshot(), before);
      assert.deepEqual(metadata(database), beforeMetadata);
      const status = await reads.getCommandStatus({ operation_id: "end_inventory_item_use", command_id: commandId(51) });
      assert.equal(status.status, "in_progress");
      assert.equal(status.result, null);
    });
  }
});

test("claim uncertainty never reaches the effect and retains a readable in-progress record", async (context) => {
  const { repository } = await revisionFixture(context);
  const persistence = commandPersistence(repository);
  persistence.claimCommandExecution = async (input) => {
    await repository.claimCommandExecution(input);
    throw new Error("Injected claim response loss");
  };
  const { service, reads, effects } = factServices(repository, repository, persistence);
  await assert.rejects(run(service, "set_inventory_item_custom_notes", "bottle", 41, { custom_notes: "Never executed" }), { code: "COMMAND_STORE_FAILURE" });
  assert.equal(effects(), 0);
  assert.equal((await reads.getCommandStatus({ operation_id: "set_inventory_item_custom_notes", command_id: commandId(41) })).status, "in_progress");
});

test("success and failure settlement faults never repeat effects or rewrite an uncertain terminal state", async (context) => {
  for (const phase of ["before-success", "after-success", "before-failure"] as const) {
    await context.test(phase, async (nested) => {
      const { repository } = await revisionFixture(nested);
      const persistence = commandPersistence(repository);
      if (phase === "before-failure") persistence.completeCommandExecutionKnownFailure = async () => { throw new Error("Injected failure settlement"); };
      else persistence.completeCommandExecutionSuccess = async (input) => {
        if (phase === "after-success") await repository.completeCommandExecutionSuccess(input);
        throw new Error("Injected success settlement");
      };
      const { service, reads, effects } = factServices(repository, repository, persistence);
      const target = phase === "before-failure" ? "missing" : "bottle";
      await assert.rejects(run(service, "set_inventory_item_custom_notes", target, 42, { custom_notes: "Committed if present" }), { code: "COMMAND_STORE_FAILURE" });
      const status = await reads.getCommandStatus({ operation_id: "set_inventory_item_custom_notes", command_id: commandId(42) });
      assert.equal(status.status, phase === "after-success" ? "succeeded" : "in_progress");
      const replay = await run(service, "set_inventory_item_custom_notes", target, 42, { custom_notes: "Committed if present" });
      assert.equal(replay.status, status.status);
      assert.equal(effects(), 1);
      if (target === "bottle") assert.equal((await snapshot(repository)).item.customNotes, "Committed if present");
    });
  }
});

function commandPersistence(repository: SqliteInventoryRepository): CommandExecutionRepository {
  return {
    findCommandExecution: (input) => repository.findCommandExecution(input),
    claimCommandExecution: (input) => repository.claimCommandExecution(input),
    completeCommandExecutionSuccess: (input) => repository.completeCommandExecutionSuccess(input),
    completeCommandExecutionKnownFailure: (input) => repository.completeCommandExecutionKnownFailure(input),
  };
}

function factServices(repository: SqliteInventoryRepository, effectRepository: FactCommandRepository = repository, persistence = commandPersistence(repository)) {
  let effects = 0;
  const commands = new CommandExecutionService(persistence, () => new Date("2026-09-05T00:00:00.000Z"));
  const service = new CustomGptFactWriteService({
    async executeFactCommand(command) { effects++; return effectRepository.executeFactCommand(command); },
  }, commands);
  const reads = new CustomGptReadService({ async searchInventory(): Promise<never> { throw new Error("Not used"); } }, repository, commands);
  return { service, reads, effects: () => effects };
}

function run(service: CustomGptFactWriteService, operation: FactCommandOperationId, target: string, id: number, input: Record<string, unknown>) {
  return service.executePrepared(service.prepare(operation, target, { command_id: commandId(id), ...input }));
}

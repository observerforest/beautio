import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CommandExecutionError,
  CommandExecutionService,
  InventoryApplicationService,
  createCanonicalCommandPayload,
  createKnownCommandFailure,
  createSafeCommandResult,
  maximumStoredCommandResultBytes,
  type ImageAssetStorage,
  type ImageInspector,
} from "@beautio/application";
import type { ConsequentialCommandOperationId } from "@beautio/contracts";
import { createInventoryItem } from "@beautio/domain";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { SqliteInventoryRepository } from "../src/index.ts";

const firstCommandId = "123e4567-e89b-42d3-a456-426614174000";
const secondCommandId = "223e4567-e89b-42d3-a456-426614174000";
const thirdCommandId = "323e4567-e89b-42d3-a456-426614174000";
const fourthCommandId = "423e4567-e89b-42d3-a456-426614174000";

test("SQLite claims once across connections, replays, conflicts, and preserves terminal CAS", async (context) => {
  const { databasePath } = await temporaryDatabase(context, "command-claim");
  const firstRepository = new SqliteInventoryRepository(databasePath);
  const secondRepository = new SqliteInventoryRepository(databasePath);
  context.after(() => firstRepository.close());
  context.after(() => secondRepository.close());
  const firstService = commandService(firstRepository);
  const secondService = commandService(secondRepository);
  const payload = createCanonicalCommandPayload({
    product_id: "product-1",
    fields: { name: "Visible only in the hash" },
  });
  const input = {
    operationId: "revise_product_profile",
    commandId: firstCommandId,
    payload,
  } as const;

  const firstClaim = await firstService.claim(input);
  assert.equal(firstClaim.outcome, "claimed");
  assert.equal((await secondService.claim(input)).outcome, "in_progress");
  await assert.rejects(
    secondService.claim({
      ...input,
      payload: createCanonicalCommandPayload({
        product_id: "product-1",
        fields: { name: "Different normalized value" },
      }),
    }),
    hasCommandError("COMMAND_PAYLOAD_CONFLICT"),
  );
  if (firstClaim.outcome !== "claimed") {
    throw new Error("test expected the first SQLite claim to execute");
  }

  const completed = await firstService.completeSuccess(
    firstClaim.claim,
    createSafeCommandResult({ outcome: "updated", product_id: "product-1" }),
  );
  assert.equal(completed.status, "succeeded");
  assert.equal((await secondService.claim(input)).outcome, "succeeded");
  await assert.rejects(
    firstService.completeKnownFailure(
      firstClaim.claim,
      createKnownCommandFailure({
        code: "LATE_FAILURE",
        message: "A terminal command cannot be rewritten.",
      }),
    ),
    hasCommandError("COMMAND_STATE_CONFLICT"),
  );
  assert.deepEqual(await secondService.find(input), completed);

  const observer = new DatabaseSync(databasePath);
  context.after(() => observer.close());
  const rows = observer
    .prepare("SELECT * FROM command_executions")
    .all() as readonly Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes("Visible only in the hash"), false);
  assert.equal(JSON.stringify(rows).includes("Different normalized value"), false);
  assert.deepEqual(
    observer
      .prepare("PRAGMA table_info(command_executions)")
      .all()
      .map((row) => (row as { name: string }).name)
      .filter((name) => /payload_json|raw|bearer|token|secret/iu.test(name)),
    [],
  );
});

test("SQLite keeps unknown, succeeded, and known-failed states across reopen", async (context) => {
  const { databasePath } = await temporaryDatabase(context, "command-reopen");
  const repository = new SqliteInventoryRepository(databasePath);
  const service = commandService(repository);
  const unknownInput = commandInput(
    "record_product_opened",
    firstCommandId,
    "unknown-target",
  );
  const successInput = commandInput(
    "set_product_display_image",
    secondCommandId,
    "success-target",
  );
  const failureInput = commandInput(
    "end_inventory_item_use",
    thirdCommandId,
    "failure-target",
  );

  await assert.rejects(
    service.execute(unknownInput, async () => {
      throw new Error("result could not be proven");
    }),
    /result could not be proven/u,
  );
  await service.execute(successInput, async () => ({
    outcome: "succeeded",
    result: { outcome: "image_set" },
  }));
  await service.execute(failureInput, async () => ({
    outcome: "known_failure",
    failure: {
      code: "INVENTORY_ITEM_NOT_FOUND",
      message: "No write was performed.",
      ref: "failure-target",
    },
  }));
  repository.close();

  const reopened = new SqliteInventoryRepository(databasePath);
  assert.equal((await commandService(reopened).find(unknownInput))?.status, "in_progress");
  assert.equal((await commandService(reopened).find(successInput))?.status, "succeeded");
  assert.equal((await commandService(reopened).find(failureInput))?.status, "failed");
  reopened.close();

  const reopenedAgain = new SqliteInventoryRepository(databasePath);
  assert.equal(
    (await commandService(reopenedAgain).claim(unknownInput)).outcome,
    "in_progress",
  );
  reopenedAgain.close();
});

test("SQLite lock contention fails closed before claim and the same connection recovers", async (context) => {
  const { databasePath } = await temporaryDatabase(context, "command-busy");
  const repository = new SqliteInventoryRepository(databasePath);
  context.after(() => repository.close());
  const service = commandService(repository);
  const holder = new DatabaseSync(databasePath);
  context.after(() => {
    try {
      holder.exec("ROLLBACK");
    } catch {
      // The explicit transaction may already be released by the test.
    }
    holder.close();
  });
  holder.exec("BEGIN IMMEDIATE");

  const input = commandInput(
    "create_inventory_batch",
    firstCommandId,
    "busy-target",
  );
  await assert.rejects(
    service.claim(input),
    hasCommandError("COMMAND_STORE_BUSY"),
  );
  holder.exec("ROLLBACK");

  assert.equal((await service.claim(input)).outcome, "claimed");
});

test("SQLite constraints fail closed for oversized results and impossible states", async (context) => {
  const { databasePath } = await temporaryDatabase(context, "command-constraints");
  const repository = new SqliteInventoryRepository(databasePath);
  repository.close();
  const database = new DatabaseSync(databasePath);
  context.after(() => database.close());
  const insert = database.prepare(
    `INSERT INTO command_executions (
      principal,
      operation_id,
      command_id,
      payload_sha256,
      status,
      created_at
    ) VALUES ('custom_gpt', 'create_inventory_batch', ?, ?, 'in_progress', ?)`,
  );
  insert.run(
    firstCommandId,
    "1".repeat(64),
    "2026-09-04T12:00:00.000Z",
  );

  assert.throws(() =>
    insert.run(
      "123e4567-e89b-42d3-a456-42661417400-",
      "2".repeat(64),
      "2026-09-04T12:00:00.000Z",
    ),
  );
  assert.throws(() =>
    insert.run(
      thirdCommandId,
      "3".repeat(64),
      "not-a-timestamp",
    ),
  );
  assert.throws(() =>
    database
      .prepare(
        `INSERT INTO command_executions (
          principal,
          operation_id,
          command_id,
          payload_sha256,
          status,
          result_json,
          created_at,
          completed_at
        ) VALUES (
          'custom_gpt',
          'create_inventory_batch',
          ?,
          ?,
          'succeeded',
          '{}',
          ?,
          ?
        )`,
      )
      .run(
        fourthCommandId,
        "4".repeat(64),
        "2026-09-04T12:00:00.000Z",
        "not-a-timestamp",
      ),
  );

  const oversizedResult = JSON.stringify({
    summary: "x".repeat(maximumStoredCommandResultBytes),
  });
  assert.throws(() =>
    database
      .prepare(
        `UPDATE command_executions
        SET status = 'succeeded', result_json = ?, completed_at = ?
        WHERE command_id = ?`,
      )
      .run(
        oversizedResult,
        "2026-09-04T12:01:00.000Z",
        firstCommandId,
      ),
  );
  assert.throws(() =>
    database
      .prepare(
        `INSERT INTO command_executions (
          principal,
          operation_id,
          command_id,
          payload_sha256,
          status,
          created_at,
          completed_at
        ) VALUES (
          'custom_gpt',
          'create_inventory_batch',
          ?,
          ?,
          'succeeded',
          ?,
          ?
        )`,
      )
      .run(
        secondCommandId,
        "2".repeat(64),
        "2026-09-04T12:00:00.000Z",
        "2026-09-04T12:01:00.000Z",
      ),
  );

  assert.deepEqual(
    {
      ...(database
        .prepare(
          `SELECT status, result_json, completed_at
          FROM command_executions WHERE command_id = ?`,
        )
        .get(firstCommandId) as Record<string, unknown>),
    },
    { status: "in_progress", result_json: null, completed_at: null },
  );
});

test("backup export excludes commands and restore preserves them", async (context) => {
  const { databasePath } = await temporaryDatabase(context, "command-backup");
  const repository = new SqliteInventoryRepository(databasePath);
  context.after(() => repository.close());
  const commands = commandService(repository);
  const input = commandInput(
    "set_inventory_item_custom_notes",
    firstCommandId,
    "backup-target",
  );
  assert.equal((await commands.claim(input)).outcome, "claimed");
  const before = await commands.find(input);

  const inventory = new InventoryApplicationService(repository, {
    clock: () => new Date("2026-09-04T12:00:00.000Z"),
    imageStorage: emptyImageStorage,
    imageInspector: emptyImageInspector,
  });
  const exportPlan = await inventory.prepareBackupExport();
  const chunks: string[] = [];
  await exportPlan.writeTo(async (chunk) => {
    chunks.push(chunk);
  });
  const serialized = chunks.join("");
  const backup = JSON.parse(serialized) as Record<string, unknown>;
  assert.deepEqual(Object.keys(backup).sort(), [
    "created_at",
    "format",
    "images",
    "inventory_items",
    "products",
    "version",
  ]);
  assert.equal(serialized.includes("command_executions"), false);
  assert.equal(serialized.includes(firstCommandId), false);

  await inventory.restoreBackup(backup);
  assert.deepEqual(await commands.find(input), before);
});

test("current schema migration is repeat-safe and leaves inventory unchanged", async (context) => {
  const { databasePath } = await temporaryDatabase(context, "command-current-migration");
  const initial = new SqliteInventoryRepository(databasePath);
  await initial.seedInventoryItem(
    createInventoryItem({
      id: "current-bottle",
      lifecycleStatus: "opened",
      openedOn: "2026-09-01",
      openedOnAccuracy: "estimated",
      customNotes: "Preserve every inventory field",
    }),
  );
  initial.close();

  const beforeMigration = new DatabaseSync(databasePath);
  const inventoryBefore = beforeMigration
    .prepare("SELECT * FROM inventory_items ORDER BY id")
    .all();
  beforeMigration.exec("DROP TABLE command_executions");
  beforeMigration.close();

  new SqliteInventoryRepository(databasePath).close();
  new SqliteInventoryRepository(databasePath).close();

  const inspected = new DatabaseSync(databasePath);
  context.after(() => inspected.close());
  assert.deepEqual(
    inspected.prepare("SELECT * FROM inventory_items ORDER BY id").all(),
    inventoryBefore,
  );
  assert.equal(
    (
      inspected
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'command_executions'",
        )
        .get() as { count: number }
    ).count,
    1,
  );
  assert.deepEqual(inspected.prepare("PRAGMA foreign_key_check").all(), []);
});

test("legacy schema migration is repeat-safe and preserves every legacy value", async (context) => {
  const { databasePath } = await temporaryDatabase(context, "command-legacy-migration");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE inventory_items (
      id TEXT PRIMARY KEY,
      lifecycle_status TEXT NOT NULL,
      opened_on TEXT,
      expires_on TEXT,
      pao_duration_months INTEGER,
      pao_deadline TEXT,
      usable_until TEXT
    ) STRICT;
    INSERT INTO inventory_items VALUES (
      'legacy-command-bottle',
      'opened',
      '2026-09-01',
      '2027-01-01',
      6,
      '2027-03-01',
      '2027-01-01'
    );
  `);
  const legacyProjection = legacy
    .prepare(
      `SELECT id, lifecycle_status, opened_on, expires_on,
        pao_duration_months, pao_deadline, usable_until
      FROM inventory_items`,
    )
    .get();
  legacy.close();

  new SqliteInventoryRepository(databasePath).close();
  new SqliteInventoryRepository(databasePath).close();

  const inspected = new DatabaseSync(databasePath);
  context.after(() => inspected.close());
  assert.deepEqual(
    inspected
      .prepare(
        `SELECT id, lifecycle_status, opened_on, expires_on,
          pao_duration_months, pao_deadline, usable_until
        FROM inventory_items`,
      )
      .get(),
    legacyProjection,
  );
  assert.equal(
    (
      inspected
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'command_executions'",
        )
        .get() as { count: number }
    ).count,
    1,
  );
  assert.deepEqual(inspected.prepare("PRAGMA foreign_key_check").all(), []);
});

function commandInput(
  operationId: ConsequentialCommandOperationId,
  commandId: string,
  targetId: string,
) {
  return {
    operationId,
    commandId,
    payload: createCanonicalCommandPayload({ target_id: targetId }),
  };
}

function commandService(
  repository: SqliteInventoryRepository,
): CommandExecutionService {
  return new CommandExecutionService(
    repository,
    () => new Date("2026-09-04T12:00:00.000Z"),
  );
}

async function temporaryDatabase(context: TestContext, name: string) {
  const directory = await mkdtemp(join(tmpdir(), `beautio-${name}-`));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return { databasePath: join(directory, "inventory.sqlite") };
}

function hasCommandError(code: CommandExecutionError["code"]) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof CommandExecutionError);
    assert.equal(error.code, code);
    return true;
  };
}

const emptyImageStorage: ImageAssetStorage = {
  async put(): Promise<void> {},
  async get(): Promise<Uint8Array> {
    throw new Error("empty backup has no image bytes");
  },
  async delete(): Promise<void> {},
};

const emptyImageInspector: ImageInspector = {
  async inspect() {
    return {
      mediaType: "image/png",
      width: 1,
      height: 1,
      animated: false,
    };
  },
};

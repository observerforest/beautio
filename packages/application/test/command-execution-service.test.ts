import assert from "node:assert/strict";
import test from "node:test";
import {
  CommandExecutionError,
  CommandExecutionService,
  createCanonicalCommandPayload,
  createKnownCommandFailure,
  createSafeCommandResult,
  maximumStoredCommandResultBytes,
  type ClaimCommandExecutionPersistenceInput,
  type ClaimCommandExecutionPersistenceResult,
  type CommandExecutionKey,
  type CommandExecutionRecord,
  type CommandExecutionRepository,
  type CompleteCommandExecutionFailurePersistenceInput,
  type CompleteCommandExecutionPersistenceResult,
  type CompleteCommandExecutionSuccessPersistenceInput,
} from "../src/index.ts";

const commandId = "123e4567-e89b-12d3-a456-426614174000";
const otherCommandId = "223e4567-e89b-12d3-a456-426614174000";

test("canonical command payload is stable without erasing JSON semantics", () => {
  const first = createCanonicalCommandPayload({
    product_id: "product-1",
    fields: { name: "Serum", alias: null },
    bottles: [1, 2],
  });
  const reordered = createCanonicalCommandPayload({
    bottles: [1, 2],
    fields: { alias: null, name: "Serum" },
    product_id: "product-1",
  });
  assert.equal(first.sha256, reordered.sha256);
  assert.notEqual(
    first.sha256,
    createCanonicalCommandPayload({
      product_id: "product-1",
      fields: { name: "Serum" },
      bottles: [1, 2],
    }).sha256,
  );
  assert.notEqual(
    first.sha256,
    createCanonicalCommandPayload({
      product_id: "product-1",
      fields: { name: "Serum", alias: null },
      bottles: [2, 1],
    }).sha256,
  );
});

test("canonical command payload rejects identity fields and non-JSON values", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const sparse = Array.from({ length: 2 }) as unknown[];
  sparse[1] = "present";

  const invalidValues = [
    undefined,
    null,
    [],
    { command_id: commandId },
    { operation_id: "create_inventory_batch" },
    { principal: "custom_gpt" },
    { access_token: "not-a-real-token" },
    { note: "Bearer not-a-real-token" },
    { value: undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: 1n },
    { value: new Date("2026-09-04T00:00:00.000Z") },
    { value: cyclic },
    { value: sparse },
  ];

  for (const value of invalidValues) {
    assert.throws(
      () => createCanonicalCommandPayload(value),
      hasCommandError("COMMAND_INPUT_INVALID"),
    );
  }
  for (const value of [
    { apiKey: "not-a-real-key" },
    { storageKey: "internal-object-name" },
    { AccessToken: "not-a-real-token" },
    { "refresh-token": "not-a-real-token" },
    { bearerToken: "not-a-real-token" },
    { TokenHash: "not-a-real-hash" },
  ]) {
    assert.throws(
      () => createCanonicalCommandPayload({ target_id: "item-1", ...value }),
      hasCommandError("COMMAND_INPUT_INVALID"),
    );
  }
});

test("bounded command results reject secret-shaped fields and oversized output", () => {
  assert.deepEqual(createSafeCommandResult({ outcome: "created", count: 2 }).value, {
    count: 2,
    outcome: "created",
  });
  assert.throws(
    () => createSafeCommandResult({ access_token: "not-a-real-token" }),
    hasCommandError("COMMAND_INPUT_INVALID"),
  );
  for (const value of [
    { apiKey: "not-a-real-key" },
    { StorageKey: "internal-object-name" },
    { accessToken: "not-a-real-token" },
    { "refresh-token": "not-a-real-token" },
    { bearerToken: "not-a-real-token" },
    { TokenHash: "not-a-real-hash" },
  ]) {
    assert.throws(
      () => createSafeCommandResult({ outcome: "created", nested: value }),
      hasCommandError("COMMAND_INPUT_INVALID"),
    );
  }
  assert.deepEqual(
    createSafeCommandResult({
      product_id: "product-1",
      monkey_name: "ordinary business text",
      token_count: 3,
      storage_size: 12,
    }).value,
    {
      monkey_name: "ordinary business text",
      product_id: "product-1",
      storage_size: 12,
      token_count: 3,
    },
  );
  assert.throws(
    () =>
      createSafeCommandResult({
        summary: "x".repeat(maximumStoredCommandResultBytes),
      }),
    hasCommandError("COMMAND_RESULT_TOO_LARGE"),
  );
  assert.throws(
    () =>
      createKnownCommandFailure({
        code: "SAFE_FAILURE",
        message: "x".repeat(513),
      }),
    hasCommandError("COMMAND_INPUT_INVALID"),
  );
  for (const failure of [
    {
      code: "UPSTREAM_REJECTED",
      message: "Upstream echoed Bearer not-a-real-credential-value",
    },
    {
      code: "UPSTREAM_REJECTED",
      message: "No write was performed.",
      ref: "Bearer not-a-real-credential-value",
    },
  ]) {
    assert.throws(
      () => createKnownCommandFailure(failure),
      hasCommandError("COMMAND_INPUT_INVALID"),
    );
  }
});

test("execute runs a successful effect once and replays the stored result", async () => {
  const repository = new MemoryCommandExecutionRepository();
  const service = fixedClockService(repository);
  const input = {
    operationId: "create_inventory_batch",
    commandId,
    payload: createCanonicalCommandPayload({
      products: [{ name: "Serum" }],
      inventory_items: [{ lifecycle_status: "unopened" }],
    }),
  } as const;
  let calls = 0;
  const effect = async () => {
    calls += 1;
    return {
      outcome: "succeeded",
      result: { products: 1, inventory_items: 1 },
    } as const;
  };

  const first = await service.execute(input, effect);
  const replay = await service.execute(input, effect);

  assert.equal(calls, 1);
  assert.equal(first.outcome, "succeeded");
  assert.equal(replay.outcome, "succeeded");
  assert.deepEqual(first.execution.result, {
    inventory_items: 1,
    products: 1,
  });
  assert.deepEqual(replay.execution, first.execution);

  await assert.rejects(
    service.execute(
      {
        ...input,
        payload: createCanonicalCommandPayload({ products: [] }),
      },
      effect,
    ),
    hasCommandError("COMMAND_PAYLOAD_CONFLICT"),
  );
  assert.equal(calls, 1);
});

test("unknown exceptions remain in progress and never re-run automatically", async () => {
  const repository = new MemoryCommandExecutionRepository();
  const service = fixedClockService(repository);
  const input = {
    operationId: "record_product_opened",
    commandId: otherCommandId,
    payload: createCanonicalCommandPayload({
      inventory_item_id: "bottle-1",
      opened_on: "2026-09-04",
      opened_on_accuracy: "exact",
    }),
  } as const;
  let calls = 0;
  await assert.rejects(
    service.execute(input, async () => {
      calls += 1;
      throw new Error("unknown write outcome");
    }),
    /unknown write outcome/u,
  );

  const replay = await service.execute(input, async () => {
    calls += 1;
    return { outcome: "succeeded", result: { opened: true } };
  });
  assert.equal(calls, 1);
  assert.equal(replay.outcome, "in_progress");
  assert.equal((await service.find(input))?.status, "in_progress");
});

test("known failure is terminal and a claim cannot rewrite it", async () => {
  const repository = new MemoryCommandExecutionRepository();
  const service = fixedClockService(repository);
  const input = {
    operationId: "end_inventory_item_use",
    commandId,
    payload: createCanonicalCommandPayload({
      inventory_item_id: "bottle-1",
      lifecycle_status: "finished",
      remaining_percent_estimate: 0,
    }),
  } as const;
  const claimed = await service.claim(input);
  assert.equal(claimed.outcome, "claimed");
  if (claimed.outcome !== "claimed") {
    throw new Error("test expected a new claim");
  }
  const failure = createKnownCommandFailure({
    code: "INVENTORY_ITEM_NOT_FOUND",
    message: "The selected inventory item does not exist.",
    ref: "bottle-1",
  });
  const failed = await service.completeKnownFailure(claimed.claim, failure);
  assert.equal(failed.status, "failed");

  await assert.rejects(
    service.completeSuccess(
      claimed.claim,
      createSafeCommandResult({ outcome: "finished" }),
    ),
    hasCommandError("COMMAND_STATE_CONFLICT"),
  );
  assert.deepEqual((await service.find(input))?.failure, failure);
});

test("the same UUID remains isolated by server-selected operation", async () => {
  const repository = new MemoryCommandExecutionRepository();
  const service = fixedClockService(repository);
  const payload = createCanonicalCommandPayload({ target_id: "same-target" });

  assert.equal(
    (
      await service.claim({
        operationId: "revise_product_profile",
        commandId,
        payload,
      })
    ).outcome,
    "claimed",
  );
  assert.equal(
    (
      await service.claim({
        operationId: "set_product_display_image",
        commandId,
        payload,
      })
    ).outcome,
    "claimed",
  );
  assert.equal(repository.records.size, 2);
});

class MemoryCommandExecutionRepository implements CommandExecutionRepository {
  readonly records = new Map<string, CommandExecutionRecord>();

  async claimCommandExecution(
    input: ClaimCommandExecutionPersistenceInput,
  ): Promise<ClaimCommandExecutionPersistenceResult> {
    const existing = this.records.get(commandKey(input.key));
    if (existing !== undefined) {
      return { inserted: false, record: existing };
    }
    const record: CommandExecutionRecord = Object.freeze({
      key: input.key,
      payloadSha256: input.payloadSha256,
      status: "in_progress",
      createdAt: input.createdAt,
      completedAt: null,
      result: null,
      failure: null,
    });
    this.records.set(commandKey(input.key), record);
    return { inserted: true, record };
  }

  async completeCommandExecutionSuccess(
    input: CompleteCommandExecutionSuccessPersistenceInput,
  ): Promise<CompleteCommandExecutionPersistenceResult> {
    return this.complete(input.key, input.payloadSha256, {
      status: "succeeded",
      completedAt: input.completedAt,
      result: input.result.value,
      failure: null,
    });
  }

  async completeCommandExecutionKnownFailure(
    input: CompleteCommandExecutionFailurePersistenceInput,
  ): Promise<CompleteCommandExecutionPersistenceResult> {
    return this.complete(input.key, input.payloadSha256, {
      status: "failed",
      completedAt: input.completedAt,
      result: null,
      failure: input.failure,
    });
  }

  async findCommandExecution(
    key: CommandExecutionKey,
  ): Promise<CommandExecutionRecord | null> {
    return this.records.get(commandKey(key)) ?? null;
  }

  private complete(
    key: CommandExecutionKey,
    payloadSha256: CommandExecutionRecord["payloadSha256"],
    terminal: Pick<
      Extract<CommandExecutionRecord, { readonly status: "succeeded" | "failed" }>,
      "status" | "completedAt" | "result" | "failure"
    >,
  ): CompleteCommandExecutionPersistenceResult {
    const existing = this.records.get(commandKey(key));
    if (
      existing === undefined ||
      existing.status !== "in_progress" ||
      existing.payloadSha256 !== payloadSha256
    ) {
      return { updated: false, record: existing ?? null };
    }
    const record = Object.freeze({
      key,
      payloadSha256,
      createdAt: existing.createdAt,
      ...terminal,
    }) as CommandExecutionRecord;
    this.records.set(commandKey(key), record);
    return { updated: true, record };
  }
}

function fixedClockService(
  repository: CommandExecutionRepository,
): CommandExecutionService {
  return new CommandExecutionService(
    repository,
    () => new Date("2026-09-04T12:00:00.000Z"),
  );
}

function commandKey(key: CommandExecutionKey): string {
  return `${key.principal}:${key.operationId}:${key.commandId}`;
}

function hasCommandError(code: CommandExecutionError["code"]) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof CommandExecutionError);
    assert.equal(error.code, code);
    return true;
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  commandExecutionPrincipalSchema,
  commandIdSchema,
  consequentialCommandOperationIdSchema,
  consequentialCommandOperationIds,
  getCommandStatusInputSchema,
} from "../src/index.ts";

test("CommandExecution accepts only the fixed principal and consequential operations", () => {
  assert.equal(commandExecutionPrincipalSchema.parse("custom_gpt"), "custom_gpt");
  assert.equal(consequentialCommandOperationIds.length, 8);
  for (const operationId of consequentialCommandOperationIds) {
    assert.equal(
      consequentialCommandOperationIdSchema.parse(operationId),
      operationId,
    );
  }

  assert.equal(commandExecutionPrincipalSchema.safeParse("admin").success, false);
  assert.equal(
    consequentialCommandOperationIdSchema.safeParse("delete_everything").success,
    false,
  );
});

test("command_id requires a canonical lowercase RFC UUID", () => {
  const accepted = [
    "123e4567-e89b-12d3-a456-426614174000",
    "0194f1d8-7d2a-7c40-8abc-1234567890ab",
  ];
  for (const commandId of accepted) {
    assert.equal(commandIdSchema.parse(commandId), commandId);
  }

  const rejected = [
    "123E4567-E89B-12D3-A456-426614174000",
    "123e4567e89b12d3a456426614174000",
    "123e4567-e89b-02d3-a456-426614174000",
    "123e4567-e89b-12d3-c456-426614174000",
    "not-a-uuid",
    "",
  ];
  for (const commandId of rejected) {
    assert.equal(commandIdSchema.safeParse(commandId).success, false);
  }
});

test("command status lookup contains operation and command only", () => {
  const input = {
    operation_id: "create_inventory_batch",
    command_id: "123e4567-e89b-12d3-a456-426614174000",
  } as const;
  assert.deepEqual(getCommandStatusInputSchema.parse(input), input);
  assert.equal(
    getCommandStatusInputSchema.safeParse({
      ...input,
      principal: "custom_gpt",
    }).success,
    false,
  );
});

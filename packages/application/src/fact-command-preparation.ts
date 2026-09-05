import {
  customGptCorrectInventoryItemFactsInputSchema, customGptEndInventoryItemUseInputSchema,
  customGptRecordProductOpenedInputSchema, customGptReviseProductProfileInputSchema,
  customGptSetInventoryItemCustomNotesInputSchema, factCommandOperationIdSchema,
  inventoryItemIdSchema, productIdSchema,
  type CommandId, type FactCommandOperationId,
} from "@beautio/contracts";
import { maximumEntityRevision } from "@beautio/domain";
import { createCanonicalCommandPayload, createSafeCommandResult } from "./canonical-json.ts";
import type { CanonicalCommandPayload } from "./command-execution-types.ts";
import type { FactCommandMutation } from "./fact-command-port.ts";
import { parseInput } from "./input-parsing.ts";

export interface PreparedFactCommandValue {
  readonly commandId: CommandId;
  readonly mutation: FactCommandMutation;
  readonly payload: CanonicalCommandPayload;
}

/**
 * Validates and owns a fact command without reading or writing persistence.
 * @param operation - Server-selected operation restricted to five fact commands.
 * @param target - Path target; normalization preserves exact opaque identity semantics.
 * @param untrustedInput - Strict body including a separate canonical command UUID.
 * @returns Frozen normalized mutation, command identity and target-bound canonical hash.
 */
export function prepareFactCommandValue(operation: FactCommandOperationId, target: string, untrustedInput: unknown): PreparedFactCommandValue {
  const operationId = parseInput(factCommandOperationIdSchema, operation);
  const targetId = parseInput(operationId === "revise_product_profile" ? productIdSchema : inventoryItemIdSchema, target);
  const parsed = parseMutation(operationId, targetId, untrustedInput);
  const identity = operationId === "revise_product_profile" ? { product_id: targetId } : { inventory_item_id: targetId };
  // Prove the largest possible receipt fits before claim or business side effects.
  createSafeCommandResult({
    ...identity, revision: maximumEntityRevision,
    outcome: operationId === "record_product_opened" ? "already_opened" : operationId === "end_inventory_item_use" ? "discarded" : "updated",
  });
  Object.freeze(parsed.mutation.input);
  const mutation = Object.freeze(parsed.mutation);
  return Object.freeze({
    commandId: parsed.commandId,
    mutation,
    payload: createCanonicalCommandPayload({ ...identity, ...mutation.input }),
  });
}

function parseMutation(operationId: FactCommandOperationId, targetId: string, value: unknown): {
  readonly commandId: CommandId; readonly mutation: FactCommandMutation;
} {
  switch (operationId) {
    case "revise_product_profile": {
      const { command_id, ...input } = parseInput(customGptReviseProductProfileInputSchema, value);
      return { commandId: command_id, mutation: { operationId, targetId, input } };
    }
    case "correct_inventory_item_facts": {
      const { command_id, ...input } = parseInput(customGptCorrectInventoryItemFactsInputSchema, value);
      return { commandId: command_id, mutation: { operationId, targetId, input } };
    }
    case "set_inventory_item_custom_notes": {
      const { command_id, ...input } = parseInput(customGptSetInventoryItemCustomNotesInputSchema, value);
      return { commandId: command_id, mutation: { operationId, targetId, input } };
    }
    case "record_product_opened": {
      const { command_id, ...input } = parseInput(customGptRecordProductOpenedInputSchema, value);
      return { commandId: command_id, mutation: { operationId, targetId, input } };
    }
    case "end_inventory_item_use": {
      const { command_id, ...input } = parseInput(customGptEndInventoryItemUseInputSchema, value);
      return { commandId: command_id, mutation: { operationId, targetId, input } };
    }
  }
}

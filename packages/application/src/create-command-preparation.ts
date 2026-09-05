import { createCommandSuccessResultSchema, customGptCreateCommandInputSchema } from "@beautio/contracts";
import { createCanonicalCommandPayload, createSafeCommandResult } from "./canonical-json.ts";
import { parseInput } from "./input-parsing.ts";
import { validateInventoryBatchReferences } from "./inventory-batch-preparation.ts";

/**
 * Owns and normalizes one create payload without generating persistent identities.
 * @param value - Unknown command body; legacy limits and normalization remain authoritative.
 * @returns Immutable business data, command identity and canonical payload hash.
 */
export function prepareCreateCommandValue(value: unknown) {
  const { command_id: commandId, ...input } = parseInput(customGptCreateCommandInputSchema, value);
  validateInventoryBatchReferences(input);
  // This deterministic worst-case fixture is not a source of persistent identities.
  createSafeCommandResult(createCommandSuccessResultSchema.parse({
    outcome: "created",
    inventory_item_ids: Array.from({ length: 100 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
  }));
  const payload = createCanonicalCommandPayload(input);
  freezeNested(input);
  return Object.freeze({ commandId, input, payload });
}

export type PreparedCreateCommandValue = ReturnType<typeof prepareCreateCommandValue>;

function freezeNested(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeNested(child);
    Object.freeze(value);
  }
}

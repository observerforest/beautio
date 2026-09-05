import { z } from "zod";
import { createCommandSuccessResultSchema } from "./create-command-results.ts";
import { factCommandSuccessResultSchema, parseFactCommandSuccessResult } from "./fact-command-results.ts";

export const customGptCommandSuccessResultSchema = z.union([factCommandSuccessResultSchema, createCommandSuccessResultSchema]);

/**
 * Projects only a supported operation's strict, minimal persisted receipt.
 * @param operationId - Operation selected by the stored command identity.
 * @param value - Untrusted historical result; unsupported or extra fields are never forwarded.
 * @returns A validated receipt, or null without claiming that an effect did not occur.
 */
export function parseCustomGptCommandSuccessResult(operationId: string, value: unknown) {
  if (operationId === "create_inventory_batch") {
    const parsed = createCommandSuccessResultSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  return parseFactCommandSuccessResult(operationId, value);
}

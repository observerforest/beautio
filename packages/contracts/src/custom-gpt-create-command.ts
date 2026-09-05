import { z } from "zod";
import { commandIdSchema } from "./command-execution.ts";
import { createInventoryBatchInputSchema } from "./inventory.ts";
import { customGptFactActionErrorSchema } from "./custom-gpt-fact-commands.ts";
import { createCommandFailureCodeSchema, createCommandSuccessResultSchema } from "./create-command-results.ts";

export const customGptCreateCommandMaximumResponseBytes = 8192;
export const customGptCreateCommandInputSchema = createInventoryBatchInputSchema.extend({ command_id: commandIdSchema });
export const customGptCreateActionErrorSchema = customGptFactActionErrorSchema;

const identity = { operation_id: z.literal("create_inventory_batch"), command_id: commandIdSchema };
const timestamp = z.iso.datetime({ precision: 3 });
export const customGptCreateCommandOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...identity, status: z.literal("in_progress"), created_at: timestamp,
    completed_at: z.null(), failure_code: z.null(), result: z.null() }),
  z.strictObject({ ...identity, status: z.literal("succeeded"), created_at: timestamp,
    completed_at: timestamp, failure_code: z.null(), result: createCommandSuccessResultSchema }),
  z.strictObject({ ...identity, status: z.literal("failed"), created_at: timestamp,
    completed_at: timestamp, failure_code: createCommandFailureCodeSchema, result: z.null() }),
]);

export type CustomGptCreateCommandInput = z.infer<typeof customGptCreateCommandInputSchema>;
export type CustomGptCreateCommandOutput = z.infer<typeof customGptCreateCommandOutputSchema>;

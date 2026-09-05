import { z } from "zod";
import { commandIdSchema } from "./command-execution.ts";
import {
  endInventoryItemInputSchema,
  recordProductOpenedInputSchema,
  updateInventoryItemCustomNotesInputSchema,
} from "./inventory.ts";
import { correctInventoryItemFactsInputSchema, reviseProductProfileInputSchema } from "./revisioned-inventory.ts";
import {
  factCommandFailureCodeSchema, factCommandOperationIdSchema,
  factCommandSuccessResultSchema, parseFactCommandSuccessResult,
} from "./fact-command-results.ts";

const commandIdentity = { command_id: commandIdSchema };
const hasBusinessPatch = (input: Record<string, unknown>): boolean => {
  const entries = Object.entries(input).filter(([key]) => key !== "command_id" && key !== "expected_revision");
  return entries.length > 0 && entries.every(([, value]) => value !== undefined);
};
export const customGptReviseProductProfileInputSchema = reviseProductProfileInputSchema.safeExtend(commandIdentity)
  .refine(hasBusinessPatch, "patch must contain at least one defined business field");
export const customGptCorrectInventoryItemFactsInputSchema = correctInventoryItemFactsInputSchema.safeExtend(commandIdentity)
  .refine(hasBusinessPatch, "patch must contain at least one defined business field");
export const customGptSetInventoryItemCustomNotesInputSchema = updateInventoryItemCustomNotesInputSchema.extend(commandIdentity);
export const customGptRecordProductOpenedInputSchema = recordProductOpenedInputSchema.omit({ inventory_item_id: true }).extend(commandIdentity);
export const customGptEndInventoryItemUseInputSchema = z.discriminatedUnion("lifecycle_status", [
  endInventoryItemInputSchema.options[0].extend(commandIdentity),
  endInventoryItemInputSchema.options[1].extend(commandIdentity),
]);

const outputIdentity = { operation_id: factCommandOperationIdSchema, command_id: commandIdSchema };
const timestampSchema = z.iso.datetime({ precision: 3 });
export const customGptFactCommandOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...outputIdentity, status: z.literal("in_progress"), created_at: timestampSchema,
    completed_at: z.null(), failure_code: z.null(), result: z.null(),
  }),
  z.strictObject({
    ...outputIdentity, status: z.literal("succeeded"), created_at: timestampSchema,
    completed_at: timestampSchema, failure_code: z.null(), result: factCommandSuccessResultSchema,
  }),
  z.strictObject({
    ...outputIdentity, status: z.literal("failed"), created_at: timestampSchema,
    completed_at: timestampSchema, failure_code: factCommandFailureCodeSchema, result: z.null(),
  }),
]).refine((output) => output.status !== "succeeded" || parseFactCommandSuccessResult(output.operation_id, output.result) !== null,
  "result must match the command operation");

export const customGptFactActionErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      "INVALID_INPUT", "UNAUTHORIZED", "NOT_FOUND", "UPLOAD_TOO_LARGE",
      "COMMAND_PAYLOAD_CONFLICT", "COMMAND_STORE_BUSY", "COMMAND_STORE_FAILURE", "INTERNAL_ERROR",
    ]),
    message: z.string().min(1).max(512),
  }),
});

export type CustomGptFactCommandOutput = z.infer<typeof customGptFactCommandOutputSchema>;
export type CustomGptReviseProductProfileInput = z.infer<typeof customGptReviseProductProfileInputSchema>;
export type CustomGptCorrectInventoryItemFactsInput = z.infer<typeof customGptCorrectInventoryItemFactsInputSchema>;
export type CustomGptSetInventoryItemCustomNotesInput = z.infer<typeof customGptSetInventoryItemCustomNotesInputSchema>;
export type CustomGptRecordProductOpenedInput = z.infer<typeof customGptRecordProductOpenedInputSchema>;
export type CustomGptEndInventoryItemUseInput = z.infer<typeof customGptEndInventoryItemUseInputSchema>;

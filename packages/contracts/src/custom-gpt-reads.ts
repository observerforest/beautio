import { z } from "zod";
import {
  commandIdSchema,
  consequentialCommandOperationIdSchema,
} from "./command-execution.ts";
import {
  imageAssetIdSchema,
  inventoryItemIdSchema,
  isoDateSchema,
  searchInventoryInputSchema,
  searchInventoryOutputSchema,
} from "./inventory.ts";
import { versionedInventoryOutputSchema } from "./revisioned-inventory.ts";
import { customGptCommandSuccessResultSchema, parseCustomGptCommandSuccessResult } from "./custom-gpt-command-results.ts";

export const inventorySearchScopeSchema = z.enum(["active", "archived", "all"]);
export const inventorySearchOptionsSchema = z.strictObject({
  scope: inventorySearchScopeSchema.default("all"),
});

export const customGptSearchInputSchema = searchInventoryInputSchema.extend({
  scope: inventorySearchScopeSchema.default("active"),
});
export const customGptSearchOutputSchema = searchInventoryOutputSchema.extend({
  scope: inventorySearchScopeSchema,
});

export const customGptFetchInputSchema = z.strictObject({
  inventory_item_id: inventoryItemIdSchema,
  as_of: isoDateSchema.optional(),
  expected_image_asset_id: imageAssetIdSchema.optional(),
});
export const customGptFetchOutputSchema = z.strictObject({
  inventory_item: versionedInventoryOutputSchema,
  display_image_matches_expected: z.boolean().nullable(),
});

const commandStatusIdentity = {
  operation_id: consequentialCommandOperationIdSchema,
  command_id: commandIdSchema,
};
const commandTimestampSchema = z.iso.datetime({ precision: 3 });

export const customGptCommandStatusOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...commandStatusIdentity,
    status: z.literal("not_found").describe(
      "No matching command record is available; this does not establish whether an effect occurred.",
    ),
    created_at: z.null(),
    completed_at: z.null(),
    failure_code: z.null(),
    result: z.null(),
  }),
  z.strictObject({
    ...commandStatusIdentity,
    status: z.literal("in_progress"),
    created_at: commandTimestampSchema,
    completed_at: z.null(),
    failure_code: z.null(),
    result: z.null(),
  }),
  z.strictObject({
    ...commandStatusIdentity,
    status: z.literal("succeeded"),
    created_at: commandTimestampSchema,
    completed_at: commandTimestampSchema,
    failure_code: z.null(),
    result: customGptCommandSuccessResultSchema.nullable(),
  }),
  z.strictObject({
    ...commandStatusIdentity,
    status: z.literal("failed"),
    created_at: commandTimestampSchema,
    completed_at: commandTimestampSchema,
    failure_code: z.string().min(1).max(64),
    result: z.null(),
  }),
]).refine((output) => output.result === null || parseCustomGptCommandSuccessResult(output.operation_id, output.result) !== null,
  "status result must match the supported command operation");

export type InventorySearchScope = z.infer<typeof inventorySearchScopeSchema>;
export type InventorySearchOptions = z.infer<typeof inventorySearchOptionsSchema>;
export type CustomGptSearchInput = z.infer<typeof customGptSearchInputSchema>;
export type CustomGptSearchOutput = z.infer<typeof customGptSearchOutputSchema>;
export type CustomGptFetchInput = z.infer<typeof customGptFetchInputSchema>;
export type CustomGptFetchOutput = z.infer<typeof customGptFetchOutputSchema>;
export type CustomGptCommandStatusOutput = z.infer<typeof customGptCommandStatusOutputSchema>;

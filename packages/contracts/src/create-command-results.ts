import { z } from "zod";
import { canonicalUuidSchema } from "./command-execution.ts";

export const createCommandSuccessResultSchema = z.strictObject({
  outcome: z.literal("created"),
  inventory_item_ids: z.array(canonicalUuidSchema).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, "created identifiers must be unique")
    .describe("Created bottle identifiers in the confirmed inventory_items input order."),
});

export const createCommandFailureCodeSchema = z.enum([
  "PRODUCT_NOT_FOUND", "INVALID_INPUT", "IMAGE_ASSET_NOT_FOUND", "IMAGE_ASSET_EXPIRED", "BATCH_CONFLICT",
]);

export type CreateCommandSuccessResult = z.infer<typeof createCommandSuccessResultSchema>;
export type CreateCommandFailureCode = z.infer<typeof createCommandFailureCodeSchema>;

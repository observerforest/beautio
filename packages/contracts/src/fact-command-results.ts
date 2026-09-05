import { z } from "zod";
import { entityRevisionSchema } from "./revisioned-inventory.ts";
import { inventoryItemIdSchema, productIdSchema } from "./inventory.ts";

export const factCommandOperationIdSchema = z.enum([
  "revise_product_profile",
  "correct_inventory_item_facts",
  "set_inventory_item_custom_notes",
  "record_product_opened",
  "end_inventory_item_use",
]);
export type FactCommandOperationId = z.infer<typeof factCommandOperationIdSchema>;

const productResultSchema = z.strictObject({
  product_id: productIdSchema,
  revision: entityRevisionSchema,
  outcome: z.literal("updated"),
});
const inventoryResultFields = { inventory_item_id: inventoryItemIdSchema, revision: entityRevisionSchema };
const inventoryUpdatedResultSchema = z.strictObject({ ...inventoryResultFields, outcome: z.literal("updated") });
const inventoryOpenedResultSchema = z.strictObject({ ...inventoryResultFields, outcome: z.enum(["opened", "already_opened"]) });
const inventoryEndedResultSchema = z.strictObject({ ...inventoryResultFields, outcome: z.enum(["finished", "discarded"]) });

export const factCommandSuccessResultSchema = z.union([
  productResultSchema, inventoryUpdatedResultSchema, inventoryOpenedResultSchema, inventoryEndedResultSchema,
]);
export type FactCommandSuccessResult = z.infer<typeof factCommandSuccessResultSchema>;

export const factCommandFailureCodeSchema = z.enum([
  "PRODUCT_NOT_FOUND", "INVENTORY_ITEM_NOT_FOUND", "REVISION_CONFLICT",
  "INVENTORY_ITEM_TERMINAL", "OPENED_ON_CONFLICT", "INVALID_INPUT",
]);
export type FactCommandFailureCode = z.infer<typeof factCommandFailureCodeSchema>;

/**
 * Validates a minimal result against the specific fact operation that produced it.
 * @param operationId - Server-selected operation; other command families are unsupported.
 * @param value - Stored or newly produced result, including potentially older formats.
 * @returns Strict safe result, or null for an unsupported operation or incompatible record.
 */
export function parseFactCommandSuccessResult(operationId: string, value: unknown): FactCommandSuccessResult | null {
  const schema = operationId === "revise_product_profile" ? productResultSchema
    : operationId === "correct_inventory_item_facts" || operationId === "set_inventory_item_custom_notes" ? inventoryUpdatedResultSchema
    : operationId === "record_product_opened" ? inventoryOpenedResultSchema
    : operationId === "end_inventory_item_use" ? inventoryEndedResultSchema : null;
  const parsed = schema?.safeParse(value);
  return parsed?.success === true ? parsed.data : null;
}

import { maximumEntityRevision, parseEntityRevision } from "@beautio/domain";
import { z } from "zod";
import {
  inventoryReadModelOutputSchema,
  isoDateSchema,
  readInventoryProductOutputSchema,
  updateInventoryItemFactsInputSchema,
  updateProductInputSchema,
} from "./inventory.ts";

export const entityRevisionSchema = z.number().int().min(1)
  .max(maximumEntityRevision).transform(parseEntityRevision);

const productProfileFieldsSchema = updateProductInputSchema
  .omit({ image_asset_id: true }).partial();
const inventoryFactsFieldsSchema = updateInventoryItemFactsInputSchema
  .omit({ as_of: true, lifecycle_status: true }).partial().extend({
    opened_on_accuracy: z.enum(["exact", "estimated"]).nullable().optional(),
  });

function hasConcretePatch(value: Record<string, unknown>): boolean {
  const entries = Object.entries(value).filter(([key]) => key !== "expected_revision");
  return entries.length > 0 && entries.every(([, entry]) => entry !== undefined);
}

export const productProfilePatchSchema = productProfileFieldsSchema
  .refine(hasConcretePatch, "patch must contain at least one defined field");
export const inventoryFactsPatchSchema = inventoryFactsFieldsSchema
  .refine(hasConcretePatch, "patch must contain at least one defined field");

export const reviseProductProfileInputSchema = productProfileFieldsSchema.extend({
  expected_revision: entityRevisionSchema,
}).refine(hasConcretePatch, "patch must contain at least one defined field");

export const correctInventoryItemFactsInputSchema = inventoryFactsFieldsSchema.extend({
  expected_revision: entityRevisionSchema,
}).refine(hasConcretePatch, "patch must contain at least one defined field");

export const versionedProductOutputSchema = readInventoryProductOutputSchema.extend({
  revision: entityRevisionSchema,
});
export const versionedInventoryOutputSchema = inventoryReadModelOutputSchema.extend({
  revision: entityRevisionSchema,
  product: versionedProductOutputSchema.nullable(),
});
export const versionedReadOptionsSchema = z.strictObject({ as_of: isoDateSchema.optional() });

export type ProductProfilePatch = z.infer<typeof productProfilePatchSchema>;
export type InventoryFactsPatch = z.infer<typeof inventoryFactsPatchSchema>;
export type VersionedProductOutput = z.infer<typeof versionedProductOutputSchema>;
export type VersionedInventoryOutput = z.infer<typeof versionedInventoryOutputSchema>;

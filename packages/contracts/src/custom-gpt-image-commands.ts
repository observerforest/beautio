import { z } from "zod";
import { commandIdSchema } from "./command-execution.ts";
import { customGptFactActionErrorSchema } from "./custom-gpt-fact-commands.ts";
import { imageAssetIdSchema, sourceRefSchema } from "./inventory.ts";
import { entityRevisionSchema } from "./revisioned-inventory.ts";
import { imageCommandFailureCodeSchema, setDisplayImageCommandSuccessResultSchema, uploadImagesCommandSuccessResultSchema } from "./image-command-results.ts";

export const actionImageFileReferenceSchema = z.strictObject({
  name: z.string().min(1), id: sourceRefSchema, mime_type: z.string().min(1), download_link: z.string().min(1),
});
export const customGptUploadImagesCommandInputSchema = z.strictObject({
  command_id: commandIdSchema,
  openaiFileIdRefs: z.array(actionImageFileReferenceSchema).min(1).max(10)
    .refine((refs) => new Set(refs.map((ref) => ref.id)).size === refs.length, "file identities must be unique"),
});
export const customGptSetDisplayImageCommandInputSchema = z.strictObject({
  command_id: commandIdSchema, expected_revision: entityRevisionSchema, image_asset_id: imageAssetIdSchema,
});
const timestamp = z.iso.datetime({ precision: 3 });
function outputSchema<Operation extends "upload_product_images" | "set_product_display_image", Result extends z.ZodType>(operation: Operation, result: Result) {
  const identity = { operation_id: z.literal(operation), command_id: commandIdSchema };
  return z.discriminatedUnion("status", [
    z.strictObject({ ...identity, status: z.literal("in_progress"), created_at: timestamp, completed_at: z.null(), failure_code: z.null(), result: z.null() }),
    z.strictObject({ ...identity, status: z.literal("succeeded"), created_at: timestamp, completed_at: timestamp, failure_code: z.null(), result }),
    z.strictObject({ ...identity, status: z.literal("failed"), created_at: timestamp, completed_at: timestamp, failure_code: imageCommandFailureCodeSchema, result: z.null() }),
  ]);
}
export const customGptUploadImagesCommandOutputSchema = outputSchema("upload_product_images", uploadImagesCommandSuccessResultSchema);
export const customGptSetDisplayImageCommandOutputSchema = outputSchema("set_product_display_image", setDisplayImageCommandSuccessResultSchema);
export const customGptImageActionErrorSchema = customGptFactActionErrorSchema;
export const customGptImageCommandMaximumResponseBytes = 8192;
export type ActionImageFileReference = z.infer<typeof actionImageFileReferenceSchema>;
export type CustomGptUploadImagesCommandInput = z.infer<typeof customGptUploadImagesCommandInputSchema>;
export type CustomGptSetDisplayImageCommandInput = z.infer<typeof customGptSetDisplayImageCommandInputSchema>;
export type CustomGptUploadImagesCommandOutput = z.infer<typeof customGptUploadImagesCommandOutputSchema>;
export type CustomGptSetDisplayImageCommandOutput = z.infer<typeof customGptSetDisplayImageCommandOutputSchema>;

import { z } from "zod";
import { canonicalUuidSchema } from "./command-execution.ts";
import { productIdSchema } from "./inventory.ts";
import { entityRevisionSchema } from "./revisioned-inventory.ts";

export const uploadImagesCommandSuccessResultSchema = z.strictObject({
  outcome: z.literal("uploaded"),
  image_asset_ids: z.array(canonicalUuidSchema).min(1).max(10)
    .refine((ids) => new Set(ids).size === ids.length, "asset identities must be unique"),
  expires_at: z.iso.datetime({ precision: 3 }),
});
export const setDisplayImageCommandSuccessResultSchema = z.strictObject({
  outcome: z.literal("updated"), product_id: productIdSchema, revision: entityRevisionSchema,
});
export const imageCommandFailureCodeSchema = z.enum([
  "INVALID_INPUT", "UPLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "PRODUCT_NOT_FOUND",
  "REVISION_CONFLICT", "IMAGE_ASSET_NOT_FOUND", "IMAGE_ASSET_EXPIRED", "BATCH_CONFLICT",
]);
export type UploadImagesCommandSuccessResult = z.infer<typeof uploadImagesCommandSuccessResultSchema>;
export type SetDisplayImageCommandSuccessResult = z.infer<typeof setDisplayImageCommandSuccessResultSchema>;
export type ImageCommandFailureCode = z.infer<typeof imageCommandFailureCodeSchema>;

/**
 * Projects an image operation's strict minimal receipt without forwarding historical extras.
 * @param operationId - Stored server-selected operation.
 * @param value - Untrusted current or historical JSON result.
 * @returns The matching receipt, or null for unsupported or incompatible records.
 */
export function parseImageCommandSuccessResult(operationId: string, value: unknown) {
  const schema = operationId === "upload_product_images" ? uploadImagesCommandSuccessResultSchema
    : operationId === "set_product_display_image" ? setDisplayImageCommandSuccessResultSchema : null;
  const result = schema?.safeParse(value);
  return result?.success === true ? result.data : null;
}

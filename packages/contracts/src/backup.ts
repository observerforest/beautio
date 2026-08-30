import {
  customNotesMaximumLength,
  hasOnlySupportedTextCharacters,
  imageMediaTypes,
  ingredientListTextMaximumLength,
  lifecycleStatuses,
  openedOnAccuracies,
  productAliasMaximumLength,
  sharedNotesMaximumLength,
} from "@beautio/domain";
import { z } from "zod";

const opaqueIdSchema = z.string().trim().min(1).max(512);
const nullableText = (maximum: number) =>
  z.string().min(1).max(maximum).refine(hasOnlySupportedTextCharacters).nullable();
const nullableShortText = z.string().trim().min(1).max(200).nullable();
const nullableDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .nullable();
const nullableInstant = z.string().datetime({ offset: true }).nullable();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const base64Schema = z
  .string()
  .min(1)
  .max(28_000_000)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);

export const beautioBackupProductSchema = z
  .object({
    product_id: opaqueIdSchema,
    name: z.string().trim().min(1).max(200),
    alias: nullableText(productAliasMaximumLength),
    brand: nullableShortText,
    category: nullableShortText,
    size_label: nullableShortText,
    image_asset_id: opaqueIdSchema.nullable(),
    image_ref: z.string().trim().min(1).max(2_048).nullable(),
    ingredient_list_text: nullableText(ingredientListTextMaximumLength),
    shared_notes: nullableText(sharedNotesMaximumLength),
  })
  .strict();

export const beautioBackupInventoryItemSchema = z
  .object({
    inventory_item_id: opaqueIdSchema,
    product_id: opaqueIdSchema.nullable(),
    created_at: nullableInstant,
    lifecycle_status: z.enum(lifecycleStatuses),
    opened_on: nullableDate,
    opened_on_accuracy: z.enum(openedOnAccuracies).nullable(),
    expires_on: nullableDate,
    pao_duration_months: z.number().int().min(1).max(120).nullable(),
    pao_deadline: nullableDate,
    usable_until: nullableDate,
    custom_notes: nullableText(customNotesMaximumLength),
  })
  .strict();

export const beautioBackupImageSchema = z
  .object({
    image_asset_id: opaqueIdSchema,
    product_id: opaqueIdSchema,
    media_type: z.enum(imageMediaTypes),
    byte_size: z.number().int().positive().max(20 * 1024 * 1024),
    sha256: sha256Schema,
    bytes_base64: base64Schema,
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const beautioBackupSchema = z
  .object({
    format: z.literal("beautio-backup"),
    version: z.literal(1),
    created_at: z.string().datetime({ offset: true }),
    products: z.array(beautioBackupProductSchema).max(10_000),
    inventory_items: z.array(beautioBackupInventoryItemSchema).max(50_000),
    images: z.array(beautioBackupImageSchema).max(1_000),
  })
  .strict();

export const restoreBeautioBackupOutputSchema = z
  .object({
    restored: z.literal(true),
    products: z.number().int().nonnegative(),
    inventory_items: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
  })
  .strict();

export type BeautioBackup = z.infer<typeof beautioBackupSchema>;
export type BeautioBackupProduct = z.infer<typeof beautioBackupProductSchema>;
export type BeautioBackupInventoryItem = z.infer<
  typeof beautioBackupInventoryItemSchema
>;
export type BeautioBackupImage = z.infer<typeof beautioBackupImageSchema>;
export type RestoreBeautioBackupOutput = z.infer<
  typeof restoreBeautioBackupOutputSchema
>;

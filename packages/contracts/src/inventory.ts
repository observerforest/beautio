import {
  beautioErrorCodes,
  customNotesMaximumLength,
  hasOnlySupportedTextCharacters,
  imageMediaTypes,
  ingredientListTextMaximumLength,
  inventoryWarnings,
  isIsoDateString,
  lifecycleStatuses,
  openedOnAccuracies,
  sharedNotesMaximumLength,
  usabilityStatuses,
} from "@beautio/domain";
import { z } from "zod";

const invalidInput = (message: string): string => `INVALID_INPUT: ${message}`;
const BATCH_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MISSING_VALUE_SENTINELS = new Set(["未知", "n/a", "待补充", "unknown"]);

const requiredOpaqueIdSchema = (fieldName: string) =>
  z
    .string({ error: invalidInput(`${fieldName} must be a string`) })
    .trim()
    .min(1, { error: invalidInput(`${fieldName} is required`) });

const nullableTrimmedTextSchema = (fieldName: string, maximum: number) =>
  z
    .string({ error: invalidInput(`${fieldName} must be a string or null`) })
    .trim()
    .min(1, {
      error: invalidInput(`${fieldName} must be non-empty when provided`),
    })
    .max(maximum, {
      error: invalidInput(`${fieldName} must be at most ${maximum} characters`),
    })
    .nullable()
    .refine(
      (value) =>
        value === null || !MISSING_VALUE_SENTINELS.has(value.toLowerCase()),
      { error: invalidInput(`${fieldName} must be null when it is unknown`) },
    );

const nullableNormalizedTextSchema = (fieldName: string, maximum: number) =>
  z
    .string({ error: invalidInput(`${fieldName} must be a string or null`) })
    .refine(hasOnlySupportedTextCharacters, {
      error: invalidInput(
        `${fieldName} contains unsupported control characters`,
      ),
    })
    .trim()
    .max(maximum, {
      error: invalidInput(`${fieldName} must be at most ${maximum} characters`),
    })
    .nullable()
    .transform((value) => (value === null || value.length === 0 ? null : value));

const nullablePersistedTextSchema = (fieldName: string, maximum: number) =>
  z
    .string({ error: `${fieldName} must be a string or null` })
    .min(1)
    .max(maximum)
    .refine(hasOnlySupportedTextCharacters)
    .nullable();

const productNameSchema = z
  .string({ error: invalidInput("name must be a string") })
  .trim()
  .min(1, { error: invalidInput("name is required") })
  .max(200, { error: invalidInput("name must be at most 200 characters") })
  .refine((value) => !MISSING_VALUE_SENTINELS.has(value.toLowerCase()), {
    error: invalidInput("name must be a confirmed Product name"),
  });

export const inventoryItemIdSchema = requiredOpaqueIdSchema(
  "inventory_item_id",
).describe("Stable opaque identifier of an existing inventory item.");

export const productIdSchema = requiredOpaqueIdSchema("product_id").describe(
  "Stable opaque identifier of an existing Product.",
);

export const imageAssetIdSchema = requiredOpaqueIdSchema(
  "image_asset_id",
).describe("Stable opaque identifier of a Beautio-managed image asset.");

export const batchRefSchema = z
  .string({ error: invalidInput("batch_ref must be a string") })
  .regex(BATCH_REF_PATTERN, {
    error: invalidInput(
      "batch_ref must be 1-64 letters, numbers, underscores, or hyphens",
    ),
  });

export const sourceRefSchema = z
  .string({ error: invalidInput("source_ref must be a string") })
  .regex(BATCH_REF_PATTERN, {
    error: invalidInput(
      "source_ref must be 1-64 letters, numbers, underscores, or hyphens",
    ),
  });

export const isoDateSchema = z
  .string({ error: invalidInput("date must be a string") })
  .regex(/^\d{4}-\d{2}-\d{2}$/, {
    error: invalidInput("date must use YYYY-MM-DD format"),
  })
  .refine(isIsoDateString, {
    error: invalidInput("date must be a real calendar date"),
  })
  .describe("Explicit real calendar date in YYYY-MM-DD format.");

export const recordProductOpenedInputSchema = z
  .object({
    inventory_item_id: inventoryItemIdSchema,
    opened_on: isoDateSchema.describe(
      "Explicit opening date. The caller must resolve words such as today before calling; the service never guesses a date or time zone.",
    ),
  })
  .strict();

export const getInventoryItemInputSchema = z
  .object({
    inventory_item_id: inventoryItemIdSchema,
    as_of: isoDateSchema.describe(
      "Explicit date used to derive reproducible usability status.",
    ),
  })
  .strict();

export const listInventoryInputSchema = z
  .object({
    as_of: isoDateSchema.describe(
      "Explicit date used to derive reproducible usability status for every inventory item.",
    ),
  })
  .strict();

const searchInventoryQuerySchema = z
  .string({ error: invalidInput("query must be a string") })
  .trim()
  .min(1, {
    error: invalidInput("query must be non-empty when provided"),
  })
  .max(200, {
    error: invalidInput("query must be at most 200 characters"),
  });

export const searchInventoryInputSchema = z
  .object({
    query: searchInventoryQuerySchema.optional(),
    offset: z
      .number({ error: invalidInput("offset must be a number") })
      .int({ error: invalidInput("offset must be an integer") })
      .min(0, { error: invalidInput("offset must be at least 0") })
      .default(0),
    limit: z
      .number({ error: invalidInput("limit must be a number") })
      .int({ error: invalidInput("limit must be an integer") })
      .min(1, { error: invalidInput("limit must be at least 1") })
      .max(50, { error: invalidInput("limit must be at most 50") })
      .default(20),
    as_of: isoDateSchema.optional(),
  })
  .strict();

export const fetchInventoryInputSchema = z
  .object({
    inventory_item_id: inventoryItemIdSchema,
    as_of: isoDateSchema.optional(),
  })
  .strict();

export const lifecycleStatusSchema = z.enum(lifecycleStatuses);
export const activeLifecycleStatusSchema = z.enum(["unopened", "opened"]);
export const openedOnAccuracySchema = z.enum(openedOnAccuracies);
export const newOpenedOnAccuracySchema = z.enum(["exact", "estimated"]);
export const usabilityStatusSchema = z.enum(usabilityStatuses);
export const inventoryWarningSchema = z.enum(inventoryWarnings);
export const imageMediaTypeSchema = z.enum(imageMediaTypes);
export const beautioErrorCodeSchema = z.enum(beautioErrorCodes);

export const inventoryStateOutputSchema = z
  .object({
    inventory_item_id: z.string(),
    lifecycle_status: lifecycleStatusSchema,
    opened_on: isoDateSchema.nullable(),
    opened_on_accuracy: openedOnAccuracySchema.nullable(),
    expires_on: isoDateSchema.nullable(),
    pao_duration_months: z.number().int().min(1).max(120).nullable(),
    pao_deadline: isoDateSchema.nullable(),
    pao_deadline_accuracy: openedOnAccuracySchema.nullable(),
    usable_until: isoDateSchema.nullable(),
    usability_status: usabilityStatusSchema,
    warnings: z.array(inventoryWarningSchema),
    custom_notes: nullablePersistedTextSchema(
      "custom_notes",
      customNotesMaximumLength,
    ),
  })
  .strict();

export const productOutputSchema = z
  .object({
    product_id: z.string(),
    name: z.string(),
    category: z.string().nullable(),
    size_label: z.string().nullable(),
    image_asset_id: z.string().nullable(),
    image_ref: z.string().nullable(),
    ingredient_list_text: nullablePersistedTextSchema(
      "ingredient_list_text",
      ingredientListTextMaximumLength,
    ),
    shared_notes: nullablePersistedTextSchema(
      "shared_notes",
      sharedNotesMaximumLength,
    ),
  })
  .strict();

export const getInventoryItemOutputSchema = inventoryStateOutputSchema
  .extend({
    product_id: z.string().nullable(),
    product: productOutputSchema.nullable(),
  })
  .strict();

export const inventoryListItemOutputSchema = inventoryStateOutputSchema
  .extend({
    product_id: z.string().nullable(),
    product: productOutputSchema.nullable(),
    product_inventory_position: z.number().int().positive().nullable(),
    product_inventory_count: z.number().int().positive().nullable(),
  })
  .strict();

export const recordProductOpenedOutputSchema = inventoryStateOutputSchema
  .extend({
    outcome: z.enum(["opened", "already_opened"]),
    lifecycle_status: z.literal("opened"),
    opened_on: isoDateSchema,
  })
  .strict();

export const inventoryListOutputSchema = z
  .object({
    as_of: isoDateSchema,
    items: z.array(inventoryListItemOutputSchema),
  })
  .strict();

export const readInventoryProductOutputSchema = z
  .object({
    product_id: z.string(),
    name: z.string(),
    category: z.string().nullable(),
    size_label: z.string().nullable(),
    ingredient_list_text: nullablePersistedTextSchema(
      "ingredient_list_text",
      ingredientListTextMaximumLength,
    ),
    shared_notes: nullablePersistedTextSchema(
      "shared_notes",
      sharedNotesMaximumLength,
    ),
    has_image: z.boolean(),
  })
  .strict();

export const inventoryDerivedStatusOutputSchema = z
  .object({
    as_of: isoDateSchema,
    usability_status: usabilityStatusSchema,
    warnings: z.array(inventoryWarningSchema),
  })
  .strict();

export const inventoryReadModelOutputSchema = z
  .object({
    inventory_item_id: z.string(),
    product_id: z.string().nullable(),
    product: readInventoryProductOutputSchema.nullable(),
    lifecycle_status: lifecycleStatusSchema,
    opened_on: isoDateSchema.nullable(),
    opened_on_accuracy: openedOnAccuracySchema.nullable(),
    expires_on: isoDateSchema.nullable(),
    pao_duration_months: z.number().int().min(1).max(120).nullable(),
    pao_deadline: isoDateSchema.nullable(),
    pao_deadline_accuracy: openedOnAccuracySchema.nullable(),
    usable_until: isoDateSchema.nullable(),
    custom_notes: nullablePersistedTextSchema(
      "custom_notes",
      customNotesMaximumLength,
    ),
    derived_status: inventoryDerivedStatusOutputSchema.nullable(),
  })
  .strict();

export const inventorySearchItemOutputSchema = z
  .object({
    inventory_item_id: z.string(),
    product_id: z.string().nullable(),
    product_name: z.string().nullable(),
    category: z.string().nullable(),
    size_label: z.string().nullable(),
    lifecycle_status: lifecycleStatusSchema,
    opened_on: isoDateSchema.nullable(),
    expires_on: isoDateSchema.nullable(),
    usable_until: isoDateSchema.nullable(),
    has_image: z.boolean(),
    derived_status: inventoryDerivedStatusOutputSchema.nullable(),
  })
  .strict();

export const searchInventoryOutputSchema = z
  .object({
    query: searchInventoryQuerySchema.nullable(),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(50),
    total: z.number().int().min(0),
    next_offset: z.number().int().min(0).nullable(),
    items: z.array(inventorySearchItemOutputSchema),
  })
  .strict();

export const fetchInventoryOutputSchema = z
  .object({ inventory_item: inventoryReadModelOutputSchema })
  .strict();

const newProductInputSchema = z
  .object({
    batch_ref: batchRefSchema,
    name: productNameSchema,
    category: nullableTrimmedTextSchema("category", 100).optional(),
    size_label: nullableTrimmedTextSchema("size_label", 100).optional(),
    image_asset_id: imageAssetIdSchema.nullable().optional(),
    ingredient_list_text: nullableNormalizedTextSchema(
      "ingredient_list_text",
      ingredientListTextMaximumLength,
    ).optional(),
    shared_notes: nullableNormalizedTextSchema(
      "shared_notes",
      sharedNotesMaximumLength,
    ).optional(),
  })
  .strict();

const productReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("new"),
      batch_ref: batchRefSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("existing"),
      product_id: productIdSchema,
    })
    .strict(),
]);

const newInventoryItemInputSchema = z
  .object({
    batch_ref: batchRefSchema,
    product_ref: productReferenceSchema,
    lifecycle_status: activeLifecycleStatusSchema,
    opened_on: isoDateSchema.nullable().optional(),
    opened_on_accuracy: newOpenedOnAccuracySchema.nullable().optional(),
    expires_on: isoDateSchema.nullable().optional(),
    pao_duration_months: z.number().int().min(1).max(120).nullable().optional(),
    custom_notes: nullableNormalizedTextSchema(
      "custom_notes",
      customNotesMaximumLength,
    ).optional(),
  })
  .strict();

export const createInventoryBatchInputSchema = z
  .object({
    as_of: isoDateSchema,
    products: z.array(newProductInputSchema).max(25),
    inventory_items: z.array(newInventoryItemInputSchema).min(1).max(100),
  })
  .strict();

export const createdProductOutputSchema = productOutputSchema
  .extend({ batch_ref: batchRefSchema, image_ref: z.null() })
  .strict();

export const createdInventoryItemOutputSchema = inventoryStateOutputSchema
  .extend({
    batch_ref: batchRefSchema,
    product_id: z.string(),
    lifecycle_status: activeLifecycleStatusSchema,
  })
  .strict();

export const createInventoryBatchOutputSchema = z
  .object({
    outcome: z.literal("created"),
    as_of: isoDateSchema,
    products: z.array(createdProductOutputSchema),
    inventory_items: z.array(createdInventoryItemOutputSchema),
  })
  .strict();

export const imageAssetOutputSchema = z
  .object({
    source_ref: z.string(),
    image_asset_id: imageAssetIdSchema,
    media_type: imageMediaTypeSchema,
    byte_size: z.number().int().positive(),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const uploadProductImagesOutputSchema = z
  .object({ assets: z.array(imageAssetOutputSchema).min(1).max(10) })
  .strict();

export const uploadProductImagesMcpInputSchema = z
  .object({
    images: z
      .array(
        z
          .object({
            client_ref: batchRefSchema,
            file_path: z
              .string({ error: invalidInput("file_path must be a string") })
              .trim()
              .min(1, { error: invalidInput("file_path is required") }),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

export const updateProductInputSchema = z
  .object({
    name: productNameSchema,
    category: nullableTrimmedTextSchema("category", 100),
    size_label: nullableTrimmedTextSchema("size_label", 100),
    image_asset_id: imageAssetIdSchema.nullable(),
    ingredient_list_text: nullableNormalizedTextSchema(
      "ingredient_list_text",
      ingredientListTextMaximumLength,
    ),
    shared_notes: nullableNormalizedTextSchema(
      "shared_notes",
      sharedNotesMaximumLength,
    ),
  })
  .strict();

export const updateProductOutputSchema = z
  .object({ product: productOutputSchema })
  .strict();

export const setProductDisplayImageInputSchema = z
  .object({
    product_id: productIdSchema,
    image_asset_id: imageAssetIdSchema,
  })
  .strict();

export const setProductDisplayImageOutputSchema = z
  .object({ product: productOutputSchema })
  .strict();

export const updateInventoryItemFactsInputSchema = z
  .object({
    as_of: isoDateSchema,
    lifecycle_status: activeLifecycleStatusSchema,
    opened_on: isoDateSchema.nullable(),
    opened_on_accuracy: openedOnAccuracySchema.nullable(),
    expires_on: isoDateSchema.nullable(),
    pao_duration_months: z.number().int().min(1).max(120).nullable(),
  })
  .strict();

export const updateInventoryItemFactsOutputSchema = inventoryStateOutputSchema
  .extend({
    as_of: isoDateSchema,
    product_id: z.string(),
    lifecycle_status: activeLifecycleStatusSchema,
  })
  .strict();

export const updateInventoryItemCustomNotesInputSchema = z
  .object({
    custom_notes: nullableNormalizedTextSchema(
      "custom_notes",
      customNotesMaximumLength,
    ),
  })
  .strict();

export const updateInventoryItemCustomNotesOutputSchema = z
  .object({
    inventory_item: z
      .object({
        inventory_item_id: inventoryItemIdSchema,
        custom_notes: nullablePersistedTextSchema(
          "custom_notes",
          customNotesMaximumLength,
        ),
      })
      .strict(),
  })
  .strict();

const localImportIdentifierSchema = z.string().trim().min(1);

export const localInventoryImportSchema = z
  .object({
    products: z.array(
      z
        .object({
          id: localImportIdentifierSchema,
          name: z.string().trim().min(1),
          category: z.string().trim().min(1).nullable().default(null),
          size_label: z.string().trim().min(1).nullable().default(null),
          image_ref: z.string().trim().min(1).nullable().default(null),
          ingredient_list_text: nullableNormalizedTextSchema(
            "ingredient_list_text",
            ingredientListTextMaximumLength,
          ).default(null),
          shared_notes: nullableNormalizedTextSchema(
            "shared_notes",
            sharedNotesMaximumLength,
          ).default(null),
        })
        .strict(),
    ),
    inventory_items: z.array(
      z
        .object({
          id: localImportIdentifierSchema,
          product_id: localImportIdentifierSchema.nullable().default(null),
          lifecycle_status: lifecycleStatusSchema,
          opened_on: isoDateSchema.nullable().default(null),
          opened_on_accuracy: openedOnAccuracySchema.nullable().default(null),
          expires_on: isoDateSchema.nullable().default(null),
          pao_duration_months: z
            .number()
            .int()
            .min(1)
            .max(120)
            .nullable()
            .default(null),
          pao_deadline: isoDateSchema.nullable().default(null),
          usable_until: isoDateSchema.nullable().default(null),
          custom_notes: nullableNormalizedTextSchema(
            "custom_notes",
            customNotesMaximumLength,
          ).default(null),
        })
        .strict(),
    ),
  })
  .strict();

export const toolErrorOutputSchema = z
  .object({
    code: beautioErrorCodeSchema,
    message: z.string(),
    ref: z.string().optional(),
  })
  .strict();

export type RecordProductOpenedInput = z.infer<
  typeof recordProductOpenedInputSchema
>;
export type GetInventoryItemInput = z.infer<typeof getInventoryItemInputSchema>;
export type GetInventoryItemOutput = z.infer<
  typeof getInventoryItemOutputSchema
>;
export type ListInventoryInput = z.infer<typeof listInventoryInputSchema>;
export type InventoryStateOutput = z.infer<typeof inventoryStateOutputSchema>;
export type InventoryListItemOutput = z.infer<
  typeof inventoryListItemOutputSchema
>;
export type InventoryListOutput = z.infer<typeof inventoryListOutputSchema>;
export type SearchInventoryInput = z.infer<typeof searchInventoryInputSchema>;
export type SearchInventoryOutput = z.infer<
  typeof searchInventoryOutputSchema
>;
export type FetchInventoryInput = z.infer<typeof fetchInventoryInputSchema>;
export type FetchInventoryOutput = z.infer<typeof fetchInventoryOutputSchema>;
export type InventoryReadModelOutput = z.infer<
  typeof inventoryReadModelOutputSchema
>;
export type InventorySearchItemOutput = z.infer<
  typeof inventorySearchItemOutputSchema
>;
export type CreateInventoryBatchInput = z.infer<
  typeof createInventoryBatchInputSchema
>;
export type CreateInventoryBatchOutput = z.infer<
  typeof createInventoryBatchOutputSchema
>;
export type UploadProductImagesOutput = z.infer<
  typeof uploadProductImagesOutputSchema
>;
export type UploadProductImagesMcpInput = z.infer<
  typeof uploadProductImagesMcpInputSchema
>;
export type UpdateProductInput = z.infer<typeof updateProductInputSchema>;
export type UpdateProductOutput = z.infer<typeof updateProductOutputSchema>;
export type SetProductDisplayImageInput = z.infer<
  typeof setProductDisplayImageInputSchema
>;
export type SetProductDisplayImageOutput = z.infer<
  typeof setProductDisplayImageOutputSchema
>;
export type UpdateInventoryItemFactsInput = z.infer<
  typeof updateInventoryItemFactsInputSchema
>;
export type UpdateInventoryItemFactsOutput = z.infer<
  typeof updateInventoryItemFactsOutputSchema
>;
export type UpdateInventoryItemCustomNotesInput = z.infer<
  typeof updateInventoryItemCustomNotesInputSchema
>;
export type UpdateInventoryItemCustomNotesOutput = z.infer<
  typeof updateInventoryItemCustomNotesOutputSchema
>;
export type LocalInventoryImport = z.infer<typeof localInventoryImportSchema>;
export type RecordProductOpenedOutput = z.infer<
  typeof recordProductOpenedOutputSchema
>;
export type ToolErrorOutput = z.infer<typeof toolErrorOutputSchema>;

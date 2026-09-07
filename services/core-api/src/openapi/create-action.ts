import {
  customNotesMaximumLength,
  ingredientListTextMaximumLength,
  productAliasMaximumLength,
  sharedNotesMaximumLength,
} from "@beautio/domain";
import {
  bearerAuthSecurity,
  canonicalUuidSchema,
  commandExecutionOutputSchema,
  isoDateSchema,
  jsonResponse,
  nullableEnumSchema,
  nullableIntegerSchema,
  nullableNormalizedTextSchema,
  nullableSchema,
  requiredOpaqueIdSchema,
  strictObjectSchema,
  trimmedConfirmedTextSchema,
  trimmedSupportedConfirmedTextSchema,
  type JsonSchema,
  writeErrorResponse,
} from "./common.ts";

const batchReferenceSchema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9_-]+$",
} as const;

const nullableTrimmedTextSchema = (
  maximum: number,
  description: string,
): JsonSchema => nullableSchema(trimmedConfirmedTextSchema(maximum, description));

const productReferenceSchema = {
  oneOf: [
    strictObjectSchema(["kind", "batch_ref"], {
      kind: { const: "new" },
      batch_ref: batchReferenceSchema,
    }),
    strictObjectSchema(["kind", "product_id"], {
      kind: { const: "existing" },
      product_id: requiredOpaqueIdSchema,
    }),
  ],
} as const;

const newProductSchema = strictObjectSchema(["batch_ref", "name"], {
  batch_ref: batchReferenceSchema,
  name: trimmedConfirmedTextSchema(200, "Confirmed Product name."),
  alias: nullableSchema(
    trimmedSupportedConfirmedTextSchema(
      productAliasMaximumLength,
      "Optional user-provided nickname or commonly used online name that the user confirmed. Use null when missing or uncertain; never guess.",
    ),
  ),
  brand: nullableTrimmedTextSchema(
    100,
    "Optional confirmed brand read from the Product or packaging. Use null when missing or uncertain; never guess.",
  ),
  category: nullableTrimmedTextSchema(100, "Confirmed Product category."),
  size_label: nullableTrimmedTextSchema(100, "Confirmed Product size label."),
  pao_duration_months: {
    ...nullableIntegerSchema(1, 120),
    description:
      "Confirmed shared period-after-opening duration in months. Each bottle's opening date determines its own deadline. Use null when unknown.",
  },
  image_asset_id: nullableSchema(requiredOpaqueIdSchema),
  ingredient_list_text: nullableNormalizedTextSchema(
    ingredientListTextMaximumLength,
    "Optional confirmed packaging ingredient text shared by this Product. Preserve its internal order, line breaks, punctuation, and casing.",
  ),
  shared_notes: nullableNormalizedTextSchema(
    sharedNotesMaximumLength,
    "Optional notes shared by every bottle linked to this Product. Ask when scope is unclear.",
  ),
});

const newInventoryItemSchema = strictObjectSchema(
  ["batch_ref", "product_ref", "lifecycle_status"],
  {
    batch_ref: batchReferenceSchema,
    product_ref: productReferenceSchema,
    lifecycle_status: { enum: ["unopened", "opened"] },
    opened_on: nullableSchema(isoDateSchema),
    opened_on_accuracy: nullableEnumSchema(["exact", "estimated"]),
    expires_on: nullableSchema(isoDateSchema),
    pao_duration_months: {
      ...nullableIntegerSchema(1, 120),
      description:
        "Optional compatibility value for this bottle. Prefer Product PAO. Known Product PAO is inherited, and a conflicting non-null bottle value is rejected.",
    },
    custom_notes: nullableNormalizedTextSchema(
      customNotesMaximumLength,
      "Optional notes for only this physical bottle. Do not place Product-wide notes here; ask when scope is unclear.",
    ),
  },
);

const createInventoryBatchInputSchema = strictObjectSchema(
  ["command_id", "as_of", "products", "inventory_items"],
  {
    command_id: canonicalUuidSchema,
    as_of: isoDateSchema,
    products: {
      type: "array",
      maxItems: 25,
      items: newProductSchema,
    },
    inventory_items: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: newInventoryItemSchema,
    },
  },
);

export const createInventoryBatchActionOperation = {
  operationId: "create_inventory_batch",
  summary: "Create a confirmed inventory batch",
  description:
    "Atomically creates up to 25 new Products and 1–100 bottles, or adds bottles to existing Products, from confirmed facts. Existing Product fields are not changed. Use one command UUID for the confirmed write, and do not automatically retry after an unknown result.",
  "x-openai-isConsequential": true,
  security: bearerAuthSecurity,
  requestBody: {
    required: true,
    content: {
      "application/json": { schema: createInventoryBatchInputSchema },
    },
  },
  responses: {
    "200": jsonResponse(
      "The replay-safe command status and compact creation receipt.",
      commandExecutionOutputSchema("create_inventory_batch"),
    ),
    default: writeErrorResponse,
  },
} as const;

export const customGptCreateActionPaths = {
  "/api/actions/create-inventory-batch": {
    post: createInventoryBatchActionOperation,
  },
} as const;

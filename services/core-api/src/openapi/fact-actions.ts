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
  entityRevisionSchema,
  isoDateSchema,
  jsonResponse,
  nullableIntegerSchema,
  nullableNormalizedTextSchema,
  nullableSchema,
  pathIdSchema,
  strictObjectSchema,
  trimmedConfirmedTextSchema,
  trimmedSupportedConfirmedTextSchema,
  writeErrorResponse,
} from "./common.ts";

const nullableTrimmedConfirmedTextSchema = (
  maximum: number,
  description: string,
) => nullableSchema(trimmedConfirmedTextSchema(maximum, description));

const productProfilePatchFields = [
  "name",
  "alias",
  "brand",
  "category",
  "size_label",
  "pao_duration_months",
  "ingredient_list_text",
  "shared_notes",
] as const;

const productProfileProperties = {
    command_id: canonicalUuidSchema,
    expected_revision: {
      ...entityRevisionSchema,
      description:
        "Copy inventory_item.product.revision from the same most recent fetch_inventory_item response used for product_id, after verifying the target bottle. Do not use inventory_item.revision. If the Product ID or revision is missing, or inventory_item.product_id differs from inventory_item.product.product_id, stop without writing and fetch the target bottle again.",
    },
    name: trimmedConfirmedTextSchema(200, "Confirmed Product name."),
    alias: nullableSchema(
      trimmedSupportedConfirmedTextSchema(
        productAliasMaximumLength,
        "Confirmed Product nickname or common online name.",
      ),
    ),
    brand: nullableTrimmedConfirmedTextSchema(100, "Confirmed Product brand."),
    category: nullableTrimmedConfirmedTextSchema(
      100,
      "Confirmed Product category.",
    ),
    size_label: nullableTrimmedConfirmedTextSchema(
      100,
      "Confirmed Product size label.",
    ),
    pao_duration_months: nullableIntegerSchema(1, 120),
    ingredient_list_text: nullableNormalizedTextSchema(
      ingredientListTextMaximumLength,
      "Confirmed packaging ingredient text shared by this Product.",
    ),
    shared_notes: nullableNormalizedTextSchema(
      sharedNotesMaximumLength,
      "Confirmed notes shared by every bottle linked to this Product.",
    ),
} as const;

const reviseProductProfileInputSchema = {
  ...strictObjectSchema(
    ["command_id", "expected_revision"],
    productProfileProperties,
  ),
  anyOf: productProfilePatchFields.map((field) =>
    strictObjectSchema(
      ["command_id", "expected_revision", field],
      productProfileProperties,
    ),
  ),
} as const;

const inventoryFactPatchFields = [
  "opened_on",
  "opened_on_accuracy",
  "expires_on",
  "pao_duration_months",
] as const;

const inventoryItemFactProperties = {
    command_id: canonicalUuidSchema,
    expected_revision: entityRevisionSchema,
    opened_on: nullableSchema(isoDateSchema),
    opened_on_accuracy: nullableSchema({ enum: ["exact", "estimated"] }),
    expires_on: nullableSchema(isoDateSchema),
    pao_duration_months: nullableIntegerSchema(1, 120),
} as const;

const reviseInventoryItemFactsInputSchema = {
  ...strictObjectSchema(
    ["command_id", "expected_revision"],
    inventoryItemFactProperties,
  ),
  anyOf: inventoryFactPatchFields.map((field) =>
    strictObjectSchema(
      ["command_id", "expected_revision", field],
      inventoryItemFactProperties,
    ),
  ),
} as const;

const setInventoryItemCustomNotesInputSchema = strictObjectSchema(
  ["command_id", "custom_notes"],
  {
    command_id: canonicalUuidSchema,
    custom_notes: nullableNormalizedTextSchema(
      customNotesMaximumLength,
      "Confirmed notes for this physical inventory item.",
    ),
  },
);

const recordProductOpenedInputSchema = strictObjectSchema(
  ["command_id", "opened_on", "opened_on_accuracy"],
  {
    command_id: canonicalUuidSchema,
    opened_on: isoDateSchema,
    opened_on_accuracy: { enum: ["exact", "estimated"] },
  },
);

const endInventoryItemUseInputSchema = {
  ...strictObjectSchema(["command_id", "as_of", "lifecycle_status"], {
    command_id: canonicalUuidSchema,
    as_of: isoDateSchema,
    lifecycle_status: { type: "string", enum: ["finished", "discarded"] },
    remaining_percent_estimate: nullableIntegerSchema(0, 100),
  }),
  oneOf: [
    strictObjectSchema(["command_id", "as_of", "lifecycle_status"], {
      command_id: canonicalUuidSchema,
      as_of: isoDateSchema,
      lifecycle_status: { const: "finished" },
    }),
    strictObjectSchema(
      [
        "command_id",
        "as_of",
        "lifecycle_status",
        "remaining_percent_estimate",
      ],
      {
        command_id: canonicalUuidSchema,
        as_of: isoDateSchema,
        lifecycle_status: { const: "discarded" },
        remaining_percent_estimate: nullableIntegerSchema(0, 100),
      },
    ),
  ],
} as const;

const productIdPathParameter = {
  name: "product_id",
  in: "path",
  required: true,
  description:
    "Copy inventory_item.product.product_id verbatim from the most recent fetch_inventory_item response after verifying the target bottle. Do not use inventory_item.inventory_item_id or command_id, and never generate or rewrite an entity ID. If the Product ID or revision is missing, or inventory_item.product_id differs from inventory_item.product.product_id, stop without writing and fetch the target bottle again.",
  schema: pathIdSchema,
} as const;

const inventoryItemIdPathParameter = {
  name: "inventory_item_id",
  in: "path",
  required: true,
  description: "Stable opaque identifier of the inventory item to update.",
  schema: pathIdSchema,
} as const;

export const reviseProductProfileActionOperation = {
  operationId: "revise_product_profile",
  summary: "Revise a shared Product profile",
  description:
    "Updates confirmed shared Product fields and revision, not images. Omitted fields stay unchanged; null clears nullable fields. Requires a profile field. Bind Product ID and revision to the same verified fetch as specified below; stop without writing if values are missing or linkage is inconsistent.",
  "x-openai-isConsequential": true,
  security: bearerAuthSecurity,
  parameters: [productIdPathParameter],
  requestBody: {
    required: true,
    content: {
      "application/json": { schema: reviseProductProfileInputSchema },
    },
  },
  responses: {
    "200": jsonResponse(
      "The command status and operation-specific receipt.",
      commandExecutionOutputSchema("revise_product_profile"),
    ),
    default: writeErrorResponse,
  },
} as const;

export const correctInventoryItemFactsActionOperation = {
  operationId: "correct_inventory_item_facts",
  summary: "Correct active inventory item facts",
  description:
    "Updates confirmed opening, expiry, or PAO facts and the revision of one active inventory item. Omitted fields are preserved; null clears nullable fields. At least one fact is required. This operation does not change lifecycle status or notes.",
  "x-openai-isConsequential": true,
  security: bearerAuthSecurity,
  parameters: [inventoryItemIdPathParameter],
  requestBody: {
    required: true,
    content: {
      "application/json": { schema: reviseInventoryItemFactsInputSchema },
    },
  },
  responses: {
    "200": jsonResponse(
      "The command status and operation-specific receipt.",
      commandExecutionOutputSchema("correct_inventory_item_facts"),
    ),
    default: writeErrorResponse,
  },
} as const;

export const setInventoryItemCustomNotesActionOperation = {
  operationId: "set_inventory_item_custom_notes",
  summary: "Set inventory item custom notes",
  description:
    "Sets or clears notes for one physical inventory item, including a finished or discarded item. Use null to clear. The path identifies the bottle, and this operation does not change Product-wide shared notes.",
  "x-openai-isConsequential": true,
  security: bearerAuthSecurity,
  parameters: [inventoryItemIdPathParameter],
  requestBody: {
    required: true,
    content: {
      "application/json": { schema: setInventoryItemCustomNotesInputSchema },
    },
  },
  responses: {
    "200": jsonResponse(
      "The command status and operation-specific receipt.",
      commandExecutionOutputSchema("set_inventory_item_custom_notes"),
    ),
    default: writeErrorResponse,
  },
} as const;

export const recordProductOpenedActionOperation = {
  operationId: "record_product_opened",
  summary: "Record an inventory item as opened",
  description:
    "Records an explicit opening date and whether it is exact or estimated for one inventory item. The path identifies the bottle. Resolve relative dates before calling; the service never guesses a date or time zone.",
  "x-openai-isConsequential": true,
  security: bearerAuthSecurity,
  parameters: [inventoryItemIdPathParameter],
  requestBody: {
    required: true,
    content: {
      "application/json": { schema: recordProductOpenedInputSchema },
    },
  },
  responses: {
    "200": jsonResponse(
      "The command status and operation-specific receipt.",
      commandExecutionOutputSchema("record_product_opened"),
    ),
    default: writeErrorResponse,
  },
} as const;

export const endInventoryItemUseActionOperation = {
  operationId: "end_inventory_item_use",
  summary: "End use of an inventory item",
  description:
    "Ends use of an opened inventory item as finished or discarded. finished accepts no remaining percentage; discarded requires an integer estimate from 0 to 100, or null when the amount is unknown.",
  "x-openai-isConsequential": true,
  security: bearerAuthSecurity,
  parameters: [inventoryItemIdPathParameter],
  requestBody: {
    required: true,
    content: {
      "application/json": { schema: endInventoryItemUseInputSchema },
    },
  },
  responses: {
    "200": jsonResponse(
      "The command status and operation-specific receipt.",
      commandExecutionOutputSchema("end_inventory_item_use"),
    ),
    default: writeErrorResponse,
  },
} as const;

export const customGptFactActionPaths = {
  "/api/actions/products/{product_id}/profile": {
    patch: reviseProductProfileActionOperation,
  },
  "/api/actions/inventory-items/{inventory_item_id}/facts": {
    patch: correctInventoryItemFactsActionOperation,
  },
  "/api/actions/inventory-items/{inventory_item_id}/custom-notes": {
    put: setInventoryItemCustomNotesActionOperation,
  },
  "/api/actions/inventory-items/{inventory_item_id}/open": {
    post: recordProductOpenedActionOperation,
  },
  "/api/actions/inventory-items/{inventory_item_id}/end-use": {
    post: endInventoryItemUseActionOperation,
  },
} as const;

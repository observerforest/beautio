import {
  customNotesMaximumLength,
  ingredientListTextMaximumLength,
  inventoryWarnings,
  lifecycleStatuses,
  openedOnAccuracies,
  productAliasMaximumLength,
  sharedNotesMaximumLength,
  usabilityStatuses,
} from "@beautio/domain";
import {
  bearerAuthSecurity,
  canonicalUuidSchema,
  commandOperationIdSchema,
  commandStatusOutputSchema,
  entityRevisionSchema,
  fetchReadErrorResponse,
  isoDateSchema,
  jsonResponse,
  nullableEnumSchema,
  nullableIntegerSchema,
  nullablePersistedTextSchema,
  nullableSchema,
  nullableStringSchema,
  opaqueIdSchema,
  requiredOpaqueIdSchema,
  readErrorResponse,
  strictObjectSchema,
  trimmedTextSchema,
  type JsonSchema,
} from "./common.ts";

const searchQuerySchema = trimmedTextSchema(
  200,
  "Optional inventory search text.",
);

const inventorySearchScopeSchema = {
  enum: ["active", "archived", "all"],
} as const;

const customGptSearchInputSchema = strictObjectSchema([], {
  query: searchQuerySchema,
  offset: { type: "integer", minimum: 0, default: 0 },
  limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
  as_of: isoDateSchema,
  scope: { ...inventorySearchScopeSchema, default: "active" },
});

const nullableDateSchema = nullableSchema(isoDateSchema);
const nullableDerivedStatusSchema = nullableSchema(
  strictObjectSchema(["as_of", "usability_status", "warnings"], {
    as_of: isoDateSchema,
    usability_status: { enum: usabilityStatuses },
    warnings: {
      type: "array",
      items: { enum: inventoryWarnings },
    },
  }),
);

const inventorySearchItemSchema = strictObjectSchema(
  [
    "inventory_item_id",
    "product_id",
    "product_name",
    "alias",
    "brand",
    "category",
    "size_label",
    "lifecycle_status",
    "opened_on",
    "expires_on",
    "usable_until",
    "remaining_percent_estimate",
    "has_image",
    "derived_status",
  ],
  {
    inventory_item_id: opaqueIdSchema,
    product_id: nullableSchema(opaqueIdSchema),
    product_name: nullableStringSchema(),
    alias: nullableStringSchema(productAliasMaximumLength),
    brand: nullableStringSchema(),
    category: nullableStringSchema(),
    size_label: nullableStringSchema(),
    lifecycle_status: { enum: lifecycleStatuses },
    opened_on: nullableDateSchema,
    expires_on: nullableDateSchema,
    usable_until: nullableDateSchema,
    remaining_percent_estimate: nullableIntegerSchema(0, 100),
    has_image: { type: "boolean" },
    derived_status: nullableDerivedStatusSchema,
  },
);

const customGptSearchOutputSchema = strictObjectSchema(
  ["query", "offset", "limit", "total", "next_offset", "items", "scope"],
  {
    query: nullableSchema(searchQuerySchema),
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 50 },
    total: { type: "integer", minimum: 0 },
    next_offset: nullableSchema({ type: "integer", minimum: 0 }),
    items: { type: "array", items: inventorySearchItemSchema },
    scope: inventorySearchScopeSchema,
  },
);

const customGptFetchInputSchema = strictObjectSchema(
  ["inventory_item_id"],
  {
    inventory_item_id: requiredOpaqueIdSchema,
    as_of: isoDateSchema,
    expected_image_asset_id: requiredOpaqueIdSchema,
  },
);

const versionedProductSchema = strictObjectSchema(
  [
    "product_id",
    "name",
    "alias",
    "brand",
    "category",
    "size_label",
    "pao_duration_months",
    "ingredient_list_text",
    "shared_notes",
    "has_image",
    "revision",
  ],
  {
    product_id: opaqueIdSchema,
    name: { type: "string" },
    alias: nullableStringSchema(productAliasMaximumLength),
    brand: nullableStringSchema(),
    category: nullableStringSchema(),
    size_label: nullableStringSchema(),
    pao_duration_months: nullableIntegerSchema(1, 120),
    ingredient_list_text: nullablePersistedTextSchema(
      ingredientListTextMaximumLength,
    ),
    shared_notes: nullablePersistedTextSchema(sharedNotesMaximumLength),
    has_image: { type: "boolean" },
    revision: entityRevisionSchema,
  },
);

const versionedInventoryItemSchema = strictObjectSchema(
  [
    "inventory_item_id",
    "product_id",
    "product",
    "lifecycle_status",
    "opened_on",
    "opened_on_accuracy",
    "expires_on",
    "pao_duration_months",
    "pao_deadline",
    "pao_deadline_accuracy",
    "usable_until",
    "remaining_percent_estimate",
    "custom_notes",
    "derived_status",
    "revision",
  ],
  {
    inventory_item_id: opaqueIdSchema,
    product_id: nullableSchema(opaqueIdSchema),
    product: nullableSchema(versionedProductSchema),
    lifecycle_status: { enum: lifecycleStatuses },
    opened_on: nullableDateSchema,
    opened_on_accuracy: nullableEnumSchema(openedOnAccuracies),
    expires_on: nullableDateSchema,
    pao_duration_months: nullableIntegerSchema(1, 120),
    pao_deadline: nullableDateSchema,
    pao_deadline_accuracy: nullableEnumSchema(openedOnAccuracies),
    usable_until: nullableDateSchema,
    remaining_percent_estimate: nullableIntegerSchema(0, 100),
    custom_notes: nullablePersistedTextSchema(customNotesMaximumLength),
    derived_status: nullableDerivedStatusSchema,
    revision: entityRevisionSchema,
  },
);

const customGptFetchOutputSchema = strictObjectSchema(
  ["inventory_item", "display_image_matches_expected"],
  {
    inventory_item: versionedInventoryItemSchema,
    display_image_matches_expected: nullableSchema({ type: "boolean" }),
  },
);

const getCommandStatusInputSchema = strictObjectSchema(
  ["operation_id", "command_id"],
  {
    operation_id: commandOperationIdSchema,
    command_id: canonicalUuidSchema,
  },
);

export const searchInventoryActionOperation = {
  operationId: "search_inventory",
  summary: "Search inventory summaries",
  description:
    "Searches Product and bottle text and returns stable, paginated inventory summaries. scope defaults to active; archived means finished or discarded. Without as_of, derived_status is null. Fetch a selected bottle for complete Product details, ingredients, notes, and revisions.",
  "x-openai-isConsequential": false,
  security: bearerAuthSecurity,
  requestBody: {
    required: true,
    content: {
      "application/json": { schema: customGptSearchInputSchema },
    },
  },
  responses: {
    "200": jsonResponse(
      "Stable paginated inventory summaries.",
      customGptSearchOutputSchema,
    ),
    default: readErrorResponse,
  },
} as const;

export const fetchInventoryItemActionOperation = {
  operationId: "fetch_inventory_item",
  summary: "Fetch a versioned inventory item",
  description:
    "Returns one bottle and its complete recorded Product fields with both entity revisions. Optional as_of derives date-relative status. Optional expected_image_asset_id reports only whether the current display image matches; no image identity or bytes are exposed.",
  "x-openai-isConsequential": false,
  security: bearerAuthSecurity,
  requestBody: {
    required: true,
    content: {
      "application/json": { schema: customGptFetchInputSchema },
    },
  },
  responses: {
    "200": jsonResponse(
      "One complete versioned inventory record.",
      customGptFetchOutputSchema,
    ),
    default: fetchReadErrorResponse,
  },
} as const;

export const getCommandStatusActionOperation = {
  operationId: "get_command_status",
  summary: "Read a command status",
  description:
    "Reads the original supported operation and command UUID without replaying, repairing, or continuing it. not_found and a null historical success result do not prove that no effect occurred. Successful receipts are limited to the result shape for that operation.",
  "x-openai-isConsequential": false,
  security: bearerAuthSecurity,
  requestBody: {
    required: true,
    content: {
      "application/json": { schema: getCommandStatusInputSchema },
    },
  },
  responses: {
    "200": jsonResponse("The stored command status.", commandStatusOutputSchema),
    default: readErrorResponse,
  },
} as const;

export const customGptReadActionPaths = {
  "/api/actions/inventory/search": {
    post: searchInventoryActionOperation,
  },
  "/api/actions/inventory/fetch": {
    post: fetchInventoryItemActionOperation,
  },
  "/api/actions/commands/status": {
    post: getCommandStatusActionOperation,
  },
} as const;

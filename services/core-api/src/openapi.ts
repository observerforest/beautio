const imageAssetSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "source_ref",
    "image_asset_id",
    "media_type",
    "byte_size",
    "expires_at",
  ],
  properties: {
    source_ref: { type: "string" },
    image_asset_id: { type: "string" },
    media_type: { enum: ["image/jpeg", "image/png", "image/webp"] },
    byte_size: { type: "integer", minimum: 1 },
    expires_at: { type: "string", format: "date-time" },
  },
} as const;

const inventoryResultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "batch_ref",
    "inventory_item_id",
    "product_id",
    "lifecycle_status",
    "opened_on",
    "opened_on_accuracy",
    "expires_on",
    "pao_duration_months",
    "pao_deadline",
    "pao_deadline_accuracy",
    "usable_until",
    "usability_status",
    "warnings",
    "custom_notes",
  ],
  properties: {
    batch_ref: { type: "string" },
    inventory_item_id: { type: "string" },
    product_id: { type: "string" },
    lifecycle_status: { enum: ["unopened", "opened"] },
    opened_on: nullableDate(),
    opened_on_accuracy: nullableEnum([
      "exact",
      "estimated",
      "legacy_unknown",
    ]),
    expires_on: nullableDate(),
    pao_duration_months: nullableInteger(1, 120),
    pao_deadline: nullableDate(),
    pao_deadline_accuracy: nullableEnum([
      "exact",
      "estimated",
      "legacy_unknown",
    ]),
    usable_until: nullableDate(),
    usability_status: { enum: ["usable", "expired", "unknown"] },
    warnings: {
      type: "array",
      items: { enum: ["already_expired", "pao_unknown"] },
    },
    custom_notes: nullableString(1000),
  },
} as const;

/**
 * Version-one OpenAPI document intentionally limited to the two Custom GPT actions.
 */
export const beautioActionsOpenApiV1 = {
  openapi: "3.1.0",
  info: {
    title: "Beautio confirmed inventory actions",
    version: "1.1.0",
    description:
      "Private actions for uploading user-confirmed product images and atomically creating confirmed inventory with optional confirmed Product ingredient text, shared Product notes, and per-bottle custom notes. Draft recognition never writes by itself.",
  },
  paths: {
    "/api/actions/upload-product-images": {
      post: {
        operationId: "upload_product_images",
        summary: "Upload confirmed product display images",
        description:
          "Call only after the user confirms which product display images to keep. Uploaded images remain temporary for 24 hours unless linked by create_inventory_batch.",
        "x-openai-isConsequential": true,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["openaiFileIdRefs"],
                properties: {
                  openaiFileIdRefs: {
                    type: "array",
                    minItems: 1,
                    maxItems: 10,
                    description:
                      "Attach only 1-10 JPEG, PNG, or static WebP product display images the user has already confirmed to save. Do not attach receipts, whole PDFs, scanned documents, or unselected images.",
                    items: { type: "string" },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "All images were stored as temporary private assets.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["assets"],
                  properties: {
                    assets: { type: "array", items: imageAssetSchema },
                  },
                },
              },
            },
          },
          default: errorResponse(),
        },
      },
    },
    "/api/actions/create-inventory-batch": {
      post: {
        operationId: "create_inventory_batch",
        summary: "Create a confirmed inventory batch",
        description:
          "Atomically creates confirmed Products and one InventoryItem per physical bottle. ingredient_list_text and shared_notes are shared Product fields; custom_notes belongs to one bottle. If note scope is unclear, ask before calling. Never guess missing fields or retry when a write result is unknown.",
        "x-openai-isConsequential": true,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: createBatchInputSchema() },
          },
        },
        responses: {
          "200": {
            description: "The complete batch committed and was read back.",
            content: {
              "application/json": { schema: createBatchOutputSchema() },
            },
          },
          default: errorResponse(),
        },
      },
    },
  },
  components: {
    schemas: {},
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Use the private Beautio Action key.",
      },
    },
  },
} as const;

type PublicBeautioActionsOpenApiV1 = typeof beautioActionsOpenApiV1 & {
  readonly servers: readonly [{ readonly url: string }];
};

/**
 * Creates the version-one Action document for a specific public HTTPS origin.
 *
 * @param publicOrigin - Normalized HTTPS origin used by Custom GPT, or undefined for local tests.
 * @returns The immutable base schema locally, or a copy with one explicit public server.
 */
export function createBeautioActionsOpenApiV1(
  publicOrigin: string,
): PublicBeautioActionsOpenApiV1;
export function createBeautioActionsOpenApiV1(
  publicOrigin?: undefined,
): typeof beautioActionsOpenApiV1;
export function createBeautioActionsOpenApiV1(
  publicOrigin?: string,
): typeof beautioActionsOpenApiV1 | PublicBeautioActionsOpenApiV1;
export function createBeautioActionsOpenApiV1(
  publicOrigin?: string,
): typeof beautioActionsOpenApiV1 | PublicBeautioActionsOpenApiV1 {
  if (publicOrigin === undefined) {
    return beautioActionsOpenApiV1;
  }
  return {
    ...beautioActionsOpenApiV1,
    servers: [{ url: publicOrigin }],
  };
}

function createBatchInputSchema(): Record<string, unknown> {
  const nullableText = (maximum: number): Record<string, unknown> => ({
    anyOf: [
      { type: "string", minLength: 1, maxLength: maximum },
      { type: "null" },
    ],
  });
  return {
    type: "object",
    additionalProperties: false,
    required: ["as_of", "products", "inventory_items"],
    properties: {
      as_of: { type: "string", format: "date" },
      products: {
        type: "array",
        maxItems: 25,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["batch_ref", "name"],
          properties: {
            batch_ref: referenceSchema(),
            name: { type: "string", minLength: 1, maxLength: 200 },
            category: nullableText(100),
            size_label: nullableText(100),
            image_asset_id: nullableString(),
            ingredient_list_text: nullableConfirmedText(
              5000,
              "Optional user-confirmed packaging INCI or ingredient text for this shared Product. Preserve its internal order, line breaks, punctuation, and casing. This is not a complete manufacturer formula.",
            ),
            shared_notes: nullableConfirmedText(
              1000,
              "Optional notes shared by every inventory bottle linked to this Product. If it is unclear whether a note is shared or bottle-specific, ask the user before calling.",
            ),
          },
        },
      },
      inventory_items: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["batch_ref", "product_ref", "lifecycle_status"],
          properties: {
            batch_ref: referenceSchema(),
            product_ref: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "batch_ref"],
                  properties: {
                    kind: { const: "new" },
                    batch_ref: referenceSchema(),
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "product_id"],
                  properties: {
                    kind: { const: "existing" },
                    product_id: { type: "string", minLength: 1 },
                  },
                },
              ],
            },
            lifecycle_status: { enum: ["unopened", "opened"] },
            opened_on: nullableDate(),
            opened_on_accuracy: nullableEnum(["exact", "estimated"]),
            expires_on: nullableDate(),
            pao_duration_months: nullableInteger(1, 120),
            custom_notes: nullableConfirmedText(
              1000,
              "Optional notes for only this physical inventory bottle. Do not place Product-wide notes here; ask the user before calling when the intended scope is unclear.",
            ),
          },
        },
      },
    },
  };
}

function createBatchOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["outcome", "as_of", "products", "inventory_items"],
    properties: {
      outcome: { const: "created" },
      as_of: { type: "string", format: "date" },
      products: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "batch_ref",
            "product_id",
            "name",
            "category",
            "size_label",
            "image_asset_id",
            "image_ref",
            "ingredient_list_text",
            "shared_notes",
          ],
          properties: {
            batch_ref: { type: "string" },
            product_id: { type: "string" },
            name: { type: "string" },
            category: nullableString(),
            size_label: nullableString(),
            image_asset_id: nullableString(),
            image_ref: { type: "null" },
            ingredient_list_text: nullableString(5000),
            shared_notes: nullableString(1000),
          },
        },
      },
      inventory_items: { type: "array", items: inventoryResultSchema },
    },
  };
}

function referenceSchema(): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    maxLength: 64,
    pattern: "^[A-Za-z0-9_-]+$",
  };
}

function nullableDate(): Record<string, unknown> {
  return {
    anyOf: [
      { type: "string", format: "date" },
      { type: "null" },
    ],
  };
}

function nullableString(maxLength?: number): Record<string, unknown> {
  return {
    anyOf: [
      {
        type: "string",
        ...(maxLength === undefined ? {} : { maxLength }),
      },
      { type: "null" },
    ],
  };
}

function nullableConfirmedText(
  maximum: number,
  description: string,
): Record<string, unknown> {
  return {
    description,
    anyOf: [
      { type: "string", maxLength: maximum },
      { type: "null" },
    ],
  };
}

function nullableInteger(minimum: number, maximum: number): Record<string, unknown> {
  return {
    anyOf: [
      { type: "integer", minimum, maximum },
      { type: "null" },
    ],
  };
}

function nullableEnum(values: readonly string[]): Record<string, unknown> {
  return { anyOf: [{ enum: values }, { type: "null" }] };
}

function errorResponse(): Record<string, unknown> {
  return {
    description: "Stable Beautio error.",
    content: {
      "application/json": {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["error"],
          properties: {
            error: {
              type: "object",
              additionalProperties: false,
              required: ["code", "message"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                ref: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}

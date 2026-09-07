import {
  bearerAuthSecurity,
  canonicalUuidSchema,
  commandExecutionOutputSchema,
  entityRevisionSchema,
  jsonResponse,
  pathIdSchema,
  requiredOpaqueIdSchema,
  strictObjectSchema,
  writeErrorResponse,
} from "./common.ts";

const uploadProductImagesInputSchema = strictObjectSchema(
  ["command_id", "openaiFileIdRefs"],
  {
    command_id: canonicalUuidSchema,
    openaiFileIdRefs: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
      description:
        "Attach only 1–10 JPEG, PNG, or static WebP Product display images the user confirmed to save. Do not attach receipts, PDFs, scanned documents, evidence images, or unselected images. Each string is supplied to the service by the platform at runtime as a file-reference object with name, id, mime_type, and download_link.",
      items: { type: "string" },
    },
  },
);

const setProductDisplayImageInputSchema = strictObjectSchema(
  ["command_id", "expected_revision", "image_asset_id"],
  {
    command_id: canonicalUuidSchema,
    expected_revision: entityRevisionSchema,
    image_asset_id: requiredOpaqueIdSchema,
  },
);

const productIdPathParameter = {
  name: "product_id",
  in: "path",
  required: true,
  description: "Opaque identifier of the existing Product to update.",
  schema: pathIdSchema,
} as const;

export const uploadProductImagesActionOperation = {
  operationId: "upload_product_images",
  summary: "Upload confirmed Product display images",
  description:
    "Stores 1–10 user-confirmed display images as temporary private image records. A succeeded command returns ordered image IDs and one expiry but does not associate them with a Product. Do not automatically retry after an unknown result.",
  "x-openai-isConsequential": true,
  security: bearerAuthSecurity,
  requestBody: {
    required: true,
    content: {
      "application/json": { schema: uploadProductImagesInputSchema },
    },
  },
  responses: {
    "200": jsonResponse(
      "The replay-safe command status and compact upload receipt.",
      commandExecutionOutputSchema("upload_product_images"),
    ),
    default: writeErrorResponse,
  },
} as const;

export const setProductDisplayImageActionOperation = {
  operationId: "set_product_display_image",
  summary: "Set a Product display image",
  description:
    "Sets or replaces one Product's shared display image with a still-valid image ID, guarded by the Product's expected revision. This affects every linked bottle and does not remove images. Do not automatically retry after an unknown result.",
  "x-openai-isConsequential": true,
  security: bearerAuthSecurity,
  parameters: [productIdPathParameter],
  requestBody: {
    required: true,
    content: {
      "application/json": { schema: setProductDisplayImageInputSchema },
    },
  },
  responses: {
    "200": jsonResponse(
      "The replay-safe command status and compact Product update receipt.",
      commandExecutionOutputSchema("set_product_display_image"),
    ),
    default: writeErrorResponse,
  },
} as const;

export const customGptImageActionPaths = {
  "/api/actions/upload-product-images": {
    post: uploadProductImagesActionOperation,
  },
  "/api/actions/products/{product_id}/display-image": {
    put: setProductDisplayImageActionOperation,
  },
} as const;

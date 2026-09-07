import {
  consequentialCommandOperationIds,
  createCommandFailureCodeSchema,
  factCommandFailureCodeSchema,
  imageCommandFailureCodeSchema,
} from "@beautio/contracts";
import { maximumEntityRevision } from "@beautio/domain";

export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * Creates a closed JSON object schema with an explicit required-key list.
 * @param required - Property names that must be present on the wire.
 * @param properties - Complete map of accepted object properties.
 * @returns An object schema that rejects every unlisted property.
 */
export function strictObjectSchema(
  required: readonly string[],
  properties: Readonly<Record<string, JsonSchema>>,
): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

/**
 * Adds JSON null as an alternative to a non-null schema.
 * @param schema - Schema for the non-null value.
 * @returns An `anyOf` schema accepting either the supplied value or null.
 */
export function nullableSchema(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: "null" }] };
}

/**
 * Creates a nullable string schema with an optional raw-length ceiling.
 * @param maxLength - Maximum string length, or undefined for no declared limit.
 * @returns A schema accepting a string within the limit or null.
 */
export function nullableStringSchema(maxLength?: number): JsonSchema {
  return nullableSchema({
    type: "string",
    ...(maxLength === undefined ? {} : { maxLength }),
  });
}

/**
 * Creates a nullable bounded-integer schema.
 * @param minimum - Inclusive minimum integer value.
 * @param maximum - Inclusive maximum integer value.
 * @returns A schema accepting an integer in the closed range or null.
 */
export function nullableIntegerSchema(
  minimum: number,
  maximum: number,
): JsonSchema {
  return nullableSchema({ type: "integer", minimum, maximum });
}

/**
 * Creates a nullable enum schema from a fixed string value set.
 * @param values - Complete list of accepted non-null enum values.
 * @returns A schema accepting one listed value or null.
 */
export function nullableEnumSchema(values: readonly string[]): JsonSchema {
  return nullableSchema({ enum: values });
}

/**
 * Wraps a JSON Schema in an OpenAPI JSON response content entry.
 * @param description - Public description of the response meaning.
 * @param schema - JSON Schema for the complete response body.
 * @returns An OpenAPI response object for `application/json`.
 */
export function jsonResponse(
  description: string,
  schema: JsonSchema,
): Readonly<Record<string, unknown>> {
  return {
    description,
    content: {
      "application/json": { schema },
    },
  };
}

export const bearerAuthSecurityScheme = {
  type: "http",
  scheme: "bearer",
  description: "Use the private Beautio Custom GPT key.",
} as const;

export const bearerAuthSecurity = [{ bearerAuth: [] }] as const;

const writeErrorCodes = [
  "INVALID_INPUT",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "UPLOAD_TOO_LARGE",
  "COMMAND_PAYLOAD_CONFLICT",
  "COMMAND_STORE_BUSY",
  "COMMAND_STORE_FAILURE",
  "INTERNAL_ERROR",
] as const;

const readErrorCodes = [
  "INVALID_INPUT",
  "UNAUTHORIZED",
  "UPLOAD_TOO_LARGE",
  "INTERNAL_ERROR",
] as const;

function errorSchema(codes: readonly string[]): JsonSchema {
  return strictObjectSchema(["error"], {
    error: strictObjectSchema(["code", "message"], {
      code: { enum: codes },
      message: { type: "string", minLength: 1, maxLength: 512 },
    }),
  });
}

export const readErrorResponse = jsonResponse(
  "Stable bounded Beautio read error.",
  errorSchema(readErrorCodes),
);

export const fetchReadErrorResponse = jsonResponse(
  "Stable bounded Beautio inventory fetch error.",
  errorSchema([...readErrorCodes, "INVENTORY_ITEM_NOT_FOUND"]),
);

export const writeErrorResponse = jsonResponse(
  "Stable bounded Beautio write error.",
  errorSchema(writeErrorCodes),
);

export const opaqueIdSchema = { type: "string" } as const;

export const requiredOpaqueIdSchema = {
  type: "string",
  minLength: 1,
  pattern: "\\S",
} as const;

export const pathIdSchema = {
  type: "string",
  pattern:
    "^(?!\\.{1,2}$)(?![\\s\\S]*[\\\\/])(?![\\s\\S]*%[0-9A-Fa-f]{2})(?![\\s\\S]*[\\u0000-\\u001F\\u007F-\\u009F])[\\s\\S]{1,1024}$",
  description:
    "Decoded opaque path ID. Dot segments, separators, controls, encoded-octet text, and values over 1024 UTF-16 units are rejected; the runtime can reject non-BMP text earlier than this portable schema.",
} as const;

export const canonicalUuidSchema = {
  type: "string",
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
} as const;

export const isoDateSchema = {
  type: "string",
  format: "date",
  pattern: "^(?!0000-)\\d{4}-\\d{2}-\\d{2}$",
  description:
    "Real calendar date in YYYY-MM-DD form with year 0001–9999. The service rejects impossible calendar dates.",
} as const;

const missingValueSentinelPattern =
  "[uU][nN][kK][nN][oO][wW][nN]|[nN]\\/[aA]|待补充|未知";
const supportedTextCharacterBody =
  "[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]*";
const supportedControlCharactersPattern =
  `^${supportedTextCharacterBody}$`;

/**
 * Describes text that the service trims before enforcing non-empty length and
 * rejecting known missing-value sentinels. Raw surrounding whitespace is not
 * length-limited so valid normalized inputs remain representable.
 *
 * @param maximum - Maximum character count after trimming.
 * @param description - Field-specific public guidance.
 * @returns A string schema covering the expressible normalization constraints.
 */
export function trimmedConfirmedTextSchema(
  maximum: number,
  description: string,
): JsonSchema {
  return {
    type: "string",
    description: `${description} The service trims surrounding whitespace, applies the ${maximum}-character limit afterward, and rejects unknown, n/a, 待补充, and 未知 as missing-value sentinels. Its UTF-16 length check can reject non-BMP text earlier than this portable schema.`,
    pattern: `^(?!\\s*(?:${missingValueSentinelPattern})\\s*$)(?=\\s*[\\s\\S]{1,${maximum}}\\s*$)(?=[\\s\\S]*\\S)[\\s\\S]*$`,
  };
}

/**
 * Describes confirmed trimmed text that must also exclude unsupported C0
 * controls. The service additionally rejects unpaired UTF-16 surrogates.
 * @param maximum - Maximum character count after trimming.
 * @param description - Field-specific public guidance.
 * @returns A string schema covering portable sentinel, length, and control rules.
 */
export function trimmedSupportedConfirmedTextSchema(
  maximum: number,
  description: string,
): JsonSchema {
  const base = trimmedConfirmedTextSchema(maximum, description);
  return {
    ...base,
    description: `${String(base.description)} Unsupported C0 controls are rejected; tab and line breaks are allowed. The service also rejects unpaired UTF-16 surrogates.`,
    pattern: `^(?=\\s*${supportedTextCharacterBody}\\s*$)${String(base.pattern).slice(1)}`,
  };
}

/**
 * Describes non-empty text whose service-side length check occurs after trim.
 * @param maximum - Maximum character count after trimming.
 * @param description - Field-specific public guidance.
 * @returns A string schema that keeps raw surrounding whitespace valid.
 */
export function trimmedTextSchema(
  maximum: number,
  description: string,
): JsonSchema {
  return {
    type: "string",
    description: `${description} The service trims surrounding whitespace and applies the ${maximum}-character limit afterward. Its UTF-16 length check can reject non-BMP text earlier than this portable schema.`,
    pattern: `^(?=\\s*[\\s\\S]{1,${maximum}}\\s*$)(?=[\\s\\S]*\\S)[\\s\\S]*$`,
  };
}

/**
 * Describes nullable free-form text normalized by trimming; blank input becomes
 * null and length is checked after trimming. JSON Schema cannot portably detect
 * unpaired UTF-16 surrogates, which the service also rejects.
 *
 * @param maximum - Maximum character count after trimming.
 * @param description - Field-specific public guidance.
 * @returns A nullable schema that rejects unsupported C0 controls without
 * rejecting raw surrounding whitespace accepted by the service.
 */
export function nullableNormalizedTextSchema(
  maximum: number,
  description: string,
): JsonSchema {
  return nullableSchema({
    type: "string",
    description: `${description} The service trims surrounding whitespace, converts blank text to null, applies the ${maximum}-character limit afterward, and rejects unsupported C0 controls or unpaired UTF-16 surrogates; tab and line breaks are allowed. Its UTF-16 length check can reject non-BMP text earlier than this portable schema.`,
    pattern: `^(?=${supportedControlCharactersPattern})(?:\\s*|(?=\\s*[\\s\\S]{1,${maximum}}\\s*$)[\\s\\S]*)$`,
  });
}

/**
 * Creates the nullable persisted-text schema used by read responses.
 * Persisted values are already normalized and non-empty; the runtime also
 * rejects unpaired UTF-16 surrogates that JSON Schema cannot portably detect.
 * @param maximum - Inclusive persisted string length limit.
 * @returns A nullable non-empty string schema rejecting unsupported C0 controls.
 */
export function nullablePersistedTextSchema(maximum: number): JsonSchema {
  return nullableSchema({
    type: "string",
    minLength: 1,
    maxLength: maximum,
    pattern: supportedControlCharactersPattern,
    description:
      "Persisted text excludes unsupported C0 controls and unpaired UTF-16 surrogates; tab and line breaks are allowed.",
  });
}

export const millisecondTimestampSchema = {
  type: "string",
  format: "date-time",
  pattern:
    "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
} as const;

export const entityRevisionSchema = {
  type: "integer",
  minimum: 1,
  maximum: maximumEntityRevision,
} as const;

export const commandOperationIdSchema = {
  enum: consequentialCommandOperationIds,
} as const;

const uploadedImagesResultSchema = strictObjectSchema(
  ["outcome", "image_asset_ids", "expires_at"],
  {
    outcome: { const: "uploaded" },
    image_asset_ids: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
      items: canonicalUuidSchema,
    },
    expires_at: millisecondTimestampSchema,
  },
);

const createdInventoryResultSchema = strictObjectSchema(
  ["outcome", "inventory_item_ids"],
  {
    outcome: { const: "created" },
    inventory_item_ids: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: canonicalUuidSchema,
    },
  },
);

const updatedProductResultSchema = strictObjectSchema(
  ["product_id", "revision", "outcome"],
  {
    product_id: requiredOpaqueIdSchema,
    revision: entityRevisionSchema,
    outcome: { const: "updated" },
  },
);

const updatedInventoryItemResultSchema = strictObjectSchema(
  ["inventory_item_id", "revision", "outcome"],
  {
    inventory_item_id: requiredOpaqueIdSchema,
    revision: entityRevisionSchema,
    outcome: { const: "updated" },
  },
);

const openedInventoryItemResultSchema = strictObjectSchema(
  ["inventory_item_id", "revision", "outcome"],
  {
    inventory_item_id: requiredOpaqueIdSchema,
    revision: entityRevisionSchema,
    outcome: { enum: ["opened", "already_opened"] },
  },
);

const endedInventoryItemResultSchema = strictObjectSchema(
  ["inventory_item_id", "revision", "outcome"],
  {
    inventory_item_id: requiredOpaqueIdSchema,
    revision: entityRevisionSchema,
    outcome: { enum: ["finished", "discarded"] },
  },
);

export const commandSuccessResultSchemas = {
  upload_product_images: uploadedImagesResultSchema,
  create_inventory_batch: createdInventoryResultSchema,
  revise_product_profile: updatedProductResultSchema,
  set_product_display_image: updatedProductResultSchema,
  correct_inventory_item_facts: updatedInventoryItemResultSchema,
  set_inventory_item_custom_notes: updatedInventoryItemResultSchema,
  record_product_opened: openedInventoryItemResultSchema,
  end_inventory_item_use: endedInventoryItemResultSchema,
} as const satisfies Record<
  (typeof consequentialCommandOperationIds)[number],
  JsonSchema
>;

export const commandSuccessResultSchema = {
  anyOf: consequentialCommandOperationIds.map(
    (operationId) => commandSuccessResultSchemas[operationId],
  ),
} as const;

export const commandFailureCodes = {
  upload_product_images: imageCommandFailureCodeSchema.options,
  create_inventory_batch: createCommandFailureCodeSchema.options,
  revise_product_profile: factCommandFailureCodeSchema.options,
  set_product_display_image: imageCommandFailureCodeSchema.options,
  correct_inventory_item_facts: factCommandFailureCodeSchema.options,
  set_inventory_item_custom_notes: factCommandFailureCodeSchema.options,
  record_product_opened: factCommandFailureCodeSchema.options,
  end_inventory_item_use: factCommandFailureCodeSchema.options,
} as const satisfies Record<
  (typeof consequentialCommandOperationIds)[number],
  readonly string[]
>;

export const commandStatusFields = [
  "operation_id",
  "command_id",
  "status",
  "created_at",
  "completed_at",
  "failure_code",
  "result",
] as const;

const nullSchema = { type: "null" } as const;
const failureCodeSchema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
} as const;

function commandIdentitySchema(
  operationId?: (typeof consequentialCommandOperationIds)[number],
): Readonly<Record<string, JsonSchema>> {
  return {
    operation_id:
      operationId === undefined
        ? commandOperationIdSchema
        : { const: operationId },
    command_id: canonicalUuidSchema,
  };
}

function inProgressCommandSchema(
  operationId?: (typeof consequentialCommandOperationIds)[number],
): JsonSchema {
  return strictObjectSchema(commandStatusFields, {
    ...commandIdentitySchema(operationId),
    status: { const: "in_progress" },
    created_at: millisecondTimestampSchema,
    completed_at: nullSchema,
    failure_code: nullSchema,
    result: nullSchema,
  });
}

function succeededCommandSchema(
  operationId: (typeof consequentialCommandOperationIds)[number],
): JsonSchema {
  return strictObjectSchema(commandStatusFields, {
    ...commandIdentitySchema(operationId),
    status: { const: "succeeded" },
    created_at: millisecondTimestampSchema,
    completed_at: millisecondTimestampSchema,
    failure_code: nullSchema,
    result: nullableSchema(commandSuccessResultSchemas[operationId]),
  });
}

function failedCommandSchema(
  operationId?: (typeof consequentialCommandOperationIds)[number],
  failureCodes?: readonly string[],
): JsonSchema {
  return strictObjectSchema(commandStatusFields, {
    ...commandIdentitySchema(operationId),
    status: { const: "failed" },
    created_at: millisecondTimestampSchema,
    completed_at: millisecondTimestampSchema,
    failure_code:
      failureCodes === undefined ? failureCodeSchema : { enum: failureCodes },
    result: nullSchema,
  });
}

const notFoundCommandSchema = strictObjectSchema(commandStatusFields, {
  ...commandIdentitySchema(),
  status: {
    const: "not_found",
    description:
      "No matching command record is available; this does not establish whether an effect occurred.",
  },
  created_at: nullSchema,
  completed_at: nullSchema,
  failure_code: nullSchema,
  result: nullSchema,
});

/**
 * Creates the strict three-state direct response schema for one write command.
 * @param operationId - Consequential operation whose identity, failure codes,
 * and non-null success receipt must be fixed in every branch.
 * @returns A `oneOf` schema for in-progress, succeeded, or failed responses.
 */
export function commandExecutionOutputSchema(
  operationId: (typeof consequentialCommandOperationIds)[number],
): JsonSchema {
  return {
    oneOf: [
      inProgressCommandSchema(operationId),
      strictObjectSchema(commandStatusFields, {
        ...commandIdentitySchema(operationId),
        status: { const: "succeeded" },
        created_at: millisecondTimestampSchema,
        completed_at: millisecondTimestampSchema,
        failure_code: nullSchema,
        result: commandSuccessResultSchemas[operationId],
      }),
      failedCommandSchema(operationId, commandFailureCodes[operationId]),
    ],
  };
}

export const commandStatusOutputSchema = {
  oneOf: [
    notFoundCommandSchema,
    inProgressCommandSchema(),
    ...consequentialCommandOperationIds.map(succeededCommandSchema),
    failedCommandSchema(),
  ],
} as const;

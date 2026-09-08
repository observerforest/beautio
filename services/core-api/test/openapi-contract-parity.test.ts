import assert from "node:assert/strict";
import test from "node:test";
import {
  customGptCorrectInventoryItemFactsInputSchema,
  customGptCreateCommandInputSchema,
  customGptEndInventoryItemUseInputSchema,
  customGptFactActionErrorSchema,
  customGptFetchInputSchema,
  customGptRecordProductOpenedInputSchema,
  customGptReviseProductProfileInputSchema,
  customGptSearchInputSchema,
  customGptSetDisplayImageCommandInputSchema,
  customGptSetInventoryItemCustomNotesInputSchema,
  customGptUploadImagesCommandInputSchema,
  getCommandStatusInputSchema,
} from "@beautio/contracts";
import { z } from "zod";
import { beautioActionsOpenApiV1 } from "../src/openapi.ts";
import { routeId } from "../src/path-segment.ts";

interface JsonSchema {
  readonly type?: string;
  readonly format?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
  readonly allOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
}

interface RuntimeSchema {
  safeParse(value: unknown): { readonly success: boolean };
}

interface RequestCase {
  readonly operationId: string;
  readonly path: string;
  readonly method: "patch" | "post" | "put";
  readonly builderInput: unknown;
  readonly runtimeInput?: unknown;
  readonly runtimeSchema: RuntimeSchema;
}

const commandId = "123e4567-e89b-42d3-a456-426614174000";
const validCases: readonly RequestCase[] = [
  {
    operationId: "search_inventory",
    path: "/api/actions/inventory/search",
    method: "post",
    builderInput: {},
    runtimeSchema: customGptSearchInputSchema,
  },
  {
    operationId: "fetch_inventory_item",
    path: "/api/actions/inventory/fetch",
    method: "post",
    builderInput: { inventory_item_id: "synthetic-bottle", as_of: "2026-09-07" },
    runtimeSchema: customGptFetchInputSchema,
  },
  {
    operationId: "get_command_status",
    path: "/api/actions/commands/status",
    method: "post",
    builderInput: { operation_id: "revise_product_profile", command_id: commandId },
    runtimeSchema: getCommandStatusInputSchema,
  },
  {
    operationId: "revise_product_profile",
    path: "/api/actions/products/{product_id}/profile",
    method: "patch",
    builderInput: { command_id: commandId, expected_revision: 1, alias: " 1234567890 " },
    runtimeSchema: customGptReviseProductProfileInputSchema,
  },
  {
    operationId: "correct_inventory_item_facts",
    path: "/api/actions/inventory-items/{inventory_item_id}/facts",
    method: "patch",
    builderInput: { command_id: commandId, expected_revision: 1, expires_on: null },
    runtimeSchema: customGptCorrectInventoryItemFactsInputSchema,
  },
  {
    operationId: "set_inventory_item_custom_notes",
    path: "/api/actions/inventory-items/{inventory_item_id}/custom-notes",
    method: "put",
    builderInput: { command_id: commandId, custom_notes: "Synthetic\tnote\nline" },
    runtimeSchema: customGptSetInventoryItemCustomNotesInputSchema,
  },
  {
    operationId: "record_product_opened",
    path: "/api/actions/inventory-items/{inventory_item_id}/open",
    method: "post",
    builderInput: { command_id: commandId, opened_on: "2026-09-07", opened_on_accuracy: "exact" },
    runtimeSchema: customGptRecordProductOpenedInputSchema,
  },
  {
    operationId: "end_inventory_item_use",
    path: "/api/actions/inventory-items/{inventory_item_id}/end-use",
    method: "post",
    builderInput: { command_id: commandId, as_of: "2026-09-07", lifecycle_status: "discarded", remaining_percent_estimate: null },
    runtimeSchema: customGptEndInventoryItemUseInputSchema,
  },
  {
    operationId: "create_inventory_batch",
    path: "/api/actions/create-inventory-batch",
    method: "post",
    builderInput: {
      command_id: commandId,
      as_of: "2026-09-07",
      products: [{ batch_ref: "product_1", name: " Synthetic Product ", ingredient_list_text: "Water\nGlycerin" }],
      inventory_items: [{ batch_ref: "bottle_1", product_ref: { kind: "new", batch_ref: "product_1" }, lifecycle_status: "unopened", custom_notes: "  " }],
    },
    runtimeSchema: customGptCreateCommandInputSchema,
  },
  {
    operationId: "upload_product_images",
    path: "/api/actions/upload-product-images",
    method: "post",
    builderInput: { command_id: commandId, openaiFileIdRefs: ["file-1"] },
    runtimeInput: {
      command_id: commandId,
      openaiFileIdRefs: [{ name: "synthetic.png", id: "file-1", mime_type: "image/png", download_link: "https://files.example.test/synthetic.png" }],
    },
    runtimeSchema: customGptUploadImagesCommandInputSchema,
  },
  {
    operationId: "set_product_display_image",
    path: "/api/actions/products/{product_id}/display-image",
    method: "put",
    builderInput: { command_id: commandId, expected_revision: 1, image_asset_id: "synthetic-image" },
    runtimeSchema: customGptSetDisplayImageCommandInputSchema,
  },
];

test("all eleven request schemas accept representative Builder and runtime input pairs", () => {
  assert.equal(validCases.length, 11);
  for (const sample of validCases) {
    assert.equal(
      validates(requestSchema(sample.path, sample.method), sample.builderInput),
      true,
      `${sample.operationId} OpenAPI request`,
    );
    assert.equal(
      sample.runtimeSchema.safeParse(sample.runtimeInput ?? sample.builderInput).success,
      true,
      `${sample.operationId} runtime request`,
    );
  }
});

test("all eleven request contracts reject a missing body or required field and unknown extras", () => {
  for (const sample of validCases) {
    const schema = requestSchema(sample.path, sample.method);
    const runtimeValue = sample.runtimeInput ?? sample.builderInput;
    const requiredKey = firstRequiredKey(schema, sample.builderInput);
    const missingBuilder = requiredKey === undefined
      ? null
      : withoutProperty(sample.builderInput, requiredKey);
    const missingRuntime = requiredKey === undefined
      ? null
      : withoutProperty(runtimeValue, requiredKey);
    const extraBuilder = withProperty(sample.builderInput, "unexpected", true);
    const extraRuntime = withProperty(runtimeValue, "unexpected", true);

    assert.equal(
      validates(schema, missingBuilder),
      false,
      `${sample.operationId} OpenAPI missing input`,
    );
    assert.equal(
      sample.runtimeSchema.safeParse(missingRuntime).success,
      false,
      `${sample.operationId} runtime missing input`,
    );
    assert.equal(
      validates(schema, extraBuilder),
      false,
      `${sample.operationId} OpenAPI unknown property`,
    );
    assert.equal(
      sample.runtimeSchema.safeParse(extraRuntime).success,
      false,
      `${sample.operationId} runtime unknown property`,
    );
  }
});

test("patch, create reference, and end-use branches match the runtime contracts", () => {
  const profileSchema = requestSchema(
    "/api/actions/products/{product_id}/profile",
    "patch",
  );
  const emptyProfile = { command_id: commandId, expected_revision: 1 };
  assert.equal(validates(profileSchema, emptyProfile), false);
  assert.equal(customGptReviseProductProfileInputSchema.safeParse(emptyProfile).success, false);

  const factsSchema = requestSchema(
    "/api/actions/inventory-items/{inventory_item_id}/facts",
    "patch",
  );
  const emptyFacts = { command_id: commandId, expected_revision: 1 };
  assert.equal(validates(factsSchema, emptyFacts), false);
  assert.equal(customGptCorrectInventoryItemFactsInputSchema.safeParse(emptyFacts).success, false);

  const createSchema = requestSchema("/api/actions/create-inventory-batch", "post");
  const existingProduct = {
    command_id: commandId,
    as_of: "2026-09-07",
    products: [],
    inventory_items: [{
      batch_ref: "bottle_1",
      product_ref: { kind: "existing", product_id: "synthetic-product" },
      lifecycle_status: "unopened",
    }],
  };
  assert.equal(validates(createSchema, existingProduct), true);
  assert.equal(customGptCreateCommandInputSchema.safeParse(existingProduct).success, true);

  const endSchema = requestSchema(
    "/api/actions/inventory-items/{inventory_item_id}/end-use",
    "post",
  );
  const finished = { command_id: commandId, as_of: "2026-09-07", lifecycle_status: "finished" };
  const discarded = { command_id: commandId, as_of: "2026-09-07", lifecycle_status: "discarded", remaining_percent_estimate: 25 };
  for (const value of [finished, discarded]) {
    assert.equal(validates(endSchema, value), true);
    assert.equal(customGptEndInventoryItemUseInputSchema.safeParse(value).success, true);
  }
  for (const value of [
    { ...finished, remaining_percent_estimate: 0 },
    { command_id: commandId, as_of: "2026-09-07", lifecycle_status: "discarded" },
  ]) {
    assert.equal(validates(endSchema, value), false);
    assert.equal(customGptEndInventoryItemUseInputSchema.safeParse(value).success, false);
  }
});

test("composed action bodies expose root object fields without weakening their branches", () => {
  for (const path of [
    "/api/actions/products/{product_id}/profile",
    "/api/actions/inventory-items/{inventory_item_id}/facts",
  ]) {
    const schema = requestSchema(path, "patch");
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["command_id", "expected_revision"]);
    assert.ok(schema.anyOf && schema.anyOf.length > 1);
    for (const branch of schema.anyOf) {
      assert.equal(branch.type, schema.type);
      assert.equal(branch.additionalProperties, schema.additionalProperties);
      assert.deepEqual(branch.properties, schema.properties);
      assert.ok(schema.required.every((key) => branch.required?.includes(key)));
      assert.equal(branch.required?.length, schema.required.length + 1);
    }
  }
  const schema = requestSchema("/api/actions/inventory-items/{inventory_item_id}/end-use", "post");
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["command_id", "as_of", "lifecycle_status"]);
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["as_of", "command_id", "lifecycle_status", "remaining_percent_estimate"]);
  assert.equal(schema.oneOf?.length, 2);
  const formerSchema = { oneOf: schema.oneOf };
  const base = { command_id: commandId, as_of: "2026-09-07" };
  for (const lifecycle_status of ["finished", "discarded", "opened", null]) {
    for (const remaining of [undefined, null, 0, 25, 100, -1, 101, 1.5, "25"]) {
      const value = { ...base, lifecycle_status, ...(remaining === undefined ? {} : { remaining_percent_estimate: remaining }) };
      assert.equal(validates(schema, value), validates(formerSchema, value));
      assert.equal(validates(schema, value), customGptEndInventoryItemUseInputSchema.safeParse(value).success);
    }
  }
});

test("trimmed Product text encodes sentinels without rejecting valid normalized lengths", () => {
  const profileSchema = requestSchema(
    "/api/actions/products/{product_id}/profile",
    "patch",
  );
  for (const field of ["name", "alias", "brand", "category", "size_label"] as const) {
    const maximum = field === "name" ? 200 : field === "alias" ? 10 : 100;
    const runtimeSchema = customGptReviseProductProfileInputSchema;
    const accepted = { command_id: commandId, expected_revision: 1, [field]: ` ${"x".repeat(maximum)} ` };
    assert.equal(validates(profileSchema, accepted), true, `${field} OpenAPI trimmed maximum`);
    assert.equal(runtimeSchema.safeParse(accepted).success, true, `${field} runtime trimmed maximum`);
    const tooLong = { command_id: commandId, expected_revision: 1, [field]: "x".repeat(maximum + 1) };
    assert.equal(validates(profileSchema, tooLong), false, `${field} OpenAPI maximum + 1`);
    assert.equal(runtimeSchema.safeParse(tooLong).success, false, `${field} runtime maximum + 1`);

    for (const sentinel of ["unknown", "UnKnOwN", "n/a", "N/A", "待补充", "未知"]) {
      const rejected = { command_id: commandId, expected_revision: 1, [field]: ` ${sentinel} ` };
      assert.equal(validates(profileSchema, rejected), false, `${field} OpenAPI ${sentinel}`);
      assert.equal(runtimeSchema.safeParse(rejected).success, false, `${field} runtime ${sentinel}`);
    }
  }

  const createSchema = requestSchema("/api/actions/create-inventory-batch", "post");
  const invalidCreateName = {
    command_id: commandId,
    as_of: "2026-09-07",
    products: [{ batch_ref: "product_1", name: " unknown " }],
    inventory_items: [{ batch_ref: "bottle_1", product_ref: { kind: "new", batch_ref: "product_1" }, lifecycle_status: "unopened" }],
  };
  assert.equal(validates(createSchema, invalidCreateName), false);
  assert.equal(customGptCreateCommandInputSchema.safeParse(invalidCreateName).success, false);

  const aliasWithControl = { command_id: commandId, expected_revision: 1, alias: "unsafe\u0000alias" };
  assert.equal(validates(profileSchema, aliasWithControl), false);
  assert.equal(customGptReviseProductProfileInputSchema.safeParse(aliasWithControl).success, false);
  for (const alias of ["\u000babc\u000c", "\u000cabc\u000b"]) {
    const profileValue = { command_id: commandId, expected_revision: 1, alias };
    assert.equal(validates(profileSchema, profileValue), true);
    assert.equal(customGptReviseProductProfileInputSchema.safeParse(profileValue).success, true);

    const createValue = {
      command_id: commandId,
      as_of: "2026-09-07",
      products: [{ batch_ref: "product_1", name: "Synthetic Product", alias }],
      inventory_items: [{ batch_ref: "bottle_1", product_ref: { kind: "new", batch_ref: "product_1" }, lifecycle_status: "unopened" }],
    };
    const createSchema = requestSchema("/api/actions/create-inventory-batch", "post");
    assert.equal(validates(createSchema, createValue), true);
    assert.equal(customGptCreateCommandInputSchema.safeParse(createValue).success, true);
  }
  for (const alias of ["a\u000bb", "a\u000cb"]) {
    const profileValue = { command_id: commandId, expected_revision: 1, alias };
    assert.equal(validates(profileSchema, profileValue), false);
    assert.equal(customGptReviseProductProfileInputSchema.safeParse(profileValue).success, false);

    const createValue = {
      command_id: commandId,
      as_of: "2026-09-07",
      products: [{ batch_ref: "product_1", name: "Synthetic Product", alias }],
      inventory_items: [{ batch_ref: "bottle_1", product_ref: { kind: "new", batch_ref: "product_1" }, lifecycle_status: "unopened" }],
    };
    const createSchema = requestSchema("/api/actions/create-inventory-batch", "post");
    assert.equal(validates(createSchema, createValue), false);
    assert.equal(customGptCreateCommandInputSchema.safeParse(createValue).success, false);
  }
  const aliasWithUnpairedSurrogate = { command_id: commandId, expected_revision: 1, alias: "a\ud800b" };
  assert.equal(validates(profileSchema, aliasWithUnpairedSurrogate), true);
  assert.equal(customGptReviseProductProfileInputSchema.safeParse(aliasWithUnpairedSurrogate).success, false);
});

test("path parameters encode the portable routeId rejection boundary", () => {
  const parameterSchemas = [
    pathParameterSchema("/api/actions/products/{product_id}/profile", "patch"),
    pathParameterSchema("/api/actions/inventory-items/{inventory_item_id}/facts", "patch"),
  ];
  const rejected = [".", "..", "a/b", "a\\b", "a%2Fb", "a\u0000b", "a\u0080b", "a\u007fb", "x".repeat(1025)];
  for (const schema of parameterSchemas) {
    for (const value of rejected) {
      assert.equal(validates(schema, value), false, JSON.stringify(value));
    }
    assert.equal(validates(schema, "synthetic-product"), true);
  }
  for (const value of rejected) {
    assert.equal(
      routeId(
        `/api/actions/products/${encodeURIComponent(value)}/profile`,
        "/api/actions/products/",
        "/profile",
      ),
      null,
      JSON.stringify(value),
    );
  }
});

test("trimmed search text accepts raw surrounding whitespace and records the Unicode length superset", () => {
  const searchSchema = requestSchema("/api/actions/inventory/search", "post");
  const trimmedMaximum = { query: ` ${"x".repeat(200)} ` };
  assert.equal(validates(searchSchema, trimmedMaximum), true);
  assert.equal(customGptSearchInputSchema.safeParse(trimmedMaximum).success, true);

  const overMaximum = { query: "x".repeat(201) };
  assert.equal(validates(searchSchema, overMaximum), false);
  assert.equal(customGptSearchInputSchema.safeParse(overMaximum).success, false);
  assert.equal(validates(searchSchema, { query: " unknown " }), true);
  assert.equal(customGptSearchInputSchema.safeParse({ query: " unknown " }).success, true);

  // JSON Schema string length is Unicode-code-point based while the current
  // runtime uses JavaScript UTF-16 code units. The public schema is therefore
  // intentionally a documented superset for non-BMP text at the boundary.
  // z.fromJSONSchema currently compiles pattern without Unicode mode, so this
  // one standards boundary is checked directly with the required ECMA-262 flag.
  const nonBmpBoundary = { query: "😀".repeat(200) };
  const queryPattern = searchSchema.properties?.query?.pattern;
  assert.ok(queryPattern);
  assert.equal(new RegExp(queryPattern, "u").test(nonBmpBoundary.query), true);
  assert.equal(customGptSearchInputSchema.safeParse(nonBmpBoundary).success, false);
});

test("normalized notes and ingredient text reject unsupported C0 controls but allow tab and line breaks", () => {
  const notesSchema = requestSchema(
    "/api/actions/inventory-items/{inventory_item_id}/custom-notes",
    "put",
  );
  const rejected = { command_id: commandId, custom_notes: "a\u0000b" };
  const accepted = { command_id: commandId, custom_notes: "a\tb\nc\rd" };
  assert.equal(validates(notesSchema, rejected), false);
  assert.equal(customGptSetInventoryItemCustomNotesInputSchema.safeParse(rejected).success, false);
  assert.equal(validates(notesSchema, accepted), true);
  assert.equal(customGptSetInventoryItemCustomNotesInputSchema.safeParse(accepted).success, true);
  const trimmedMaximum = { command_id: commandId, custom_notes: ` ${"x".repeat(1000)} ` };
  const tooLong = { command_id: commandId, custom_notes: "x".repeat(1001) };
  assert.equal(validates(notesSchema, trimmedMaximum), true);
  assert.equal(customGptSetInventoryItemCustomNotesInputSchema.safeParse(trimmedMaximum).success, true);
  assert.equal(validates(notesSchema, tooLong), false);
  assert.equal(customGptSetInventoryItemCustomNotesInputSchema.safeParse(tooLong).success, false);

  const profileSchema = requestSchema("/api/actions/products/{product_id}/profile", "patch");
  const rejectedIngredient = { command_id: commandId, expected_revision: 1, ingredient_list_text: "water\u0001oil" };
  assert.equal(validates(profileSchema, rejectedIngredient), false);
  assert.equal(customGptReviseProductProfileInputSchema.safeParse(rejectedIngredient).success, false);

  // ECMA-262 patterns cannot portably distinguish every unpaired UTF-16
  // surrogate. The OpenAPI is intentionally a documented superset here; the
  // runtime remains authoritative and returns INVALID_INPUT.
  const unpaired = { command_id: commandId, custom_notes: "a\ud800b" };
  assert.equal(validates(notesSchema, unpaired), true);
  assert.equal(customGptSetInventoryItemCustomNotesInputSchema.safeParse(unpaired).success, false);
});

test("date schemas reject year zero and format validation rejects impossible calendar dates", () => {
  const openSchema = requestSchema(
    "/api/actions/inventory-items/{inventory_item_id}/open",
    "post",
  );
  for (const opened_on of ["0000-01-01", "2026-02-30"]) {
    const value = { command_id: commandId, opened_on, opened_on_accuracy: "exact" };
    assert.equal(validates(openSchema, value), false, `OpenAPI ${opened_on}`);
    assert.equal(customGptRecordProductOpenedInputSchema.safeParse(value).success, false, `runtime ${opened_on}`);
  }
});

test("read and write default errors enforce their distinct handler code unions and strict messages", () => {
  const readError = defaultErrorSchema("/api/actions/inventory/fetch", "post");
  const searchError = defaultErrorSchema("/api/actions/inventory/search", "post");
  const statusError = defaultErrorSchema("/api/actions/commands/status", "post");
  const writeError = defaultErrorSchema(
    "/api/actions/products/{product_id}/profile",
    "patch",
  );
  const readCodes = ["INVALID_INPUT", "UNAUTHORIZED", "UPLOAD_TOO_LARGE", "INVENTORY_ITEM_NOT_FOUND", "INTERNAL_ERROR"];
  const writeCodes = ["INVALID_INPUT", "UNAUTHORIZED", "NOT_FOUND", "UPLOAD_TOO_LARGE", "COMMAND_PAYLOAD_CONFLICT", "COMMAND_STORE_BUSY", "COMMAND_STORE_FAILURE", "INTERNAL_ERROR"];

  for (const code of readCodes) {
    assert.equal(validates(readError, { error: { code, message: "Synthetic error." } }), true, `read ${code}`);
  }
  for (const code of writeCodes) {
    const value = { error: { code, message: "Synthetic error." } };
    assert.equal(validates(writeError, value), true, `write ${code}`);
    assert.equal(customGptFactActionErrorSchema.safeParse(value).success, true, `runtime write ${code}`);
  }
  assert.equal(validates(readError, { error: { code: "NOT_FOUND", message: "Synthetic error." } }), false);
  assert.equal(validates(readError, { error: { code: "COMMAND_STORE_BUSY", message: "Synthetic error." } }), false);
  assert.equal(validates(writeError, { error: { code: "INVENTORY_ITEM_NOT_FOUND", message: "Synthetic error." } }), false);
  for (const invalid of [
    { error: { code: "ARBITRARY", message: "Synthetic error." } },
    { error: { code: "INVALID_INPUT", message: "" } },
    { error: { code: "INVALID_INPUT", message: "x".repeat(513) } },
    { error: { code: "INVALID_INPUT", message: "Synthetic error.", ref: "private" } },
  ]) {
    assert.equal(validates(writeError, invalid), false);
    assert.equal(customGptFactActionErrorSchema.safeParse(invalid).success, false);
  }
  for (const genericReadError of [searchError, statusError]) {
    assert.equal(validates(genericReadError, { error: { code: "INVENTORY_ITEM_NOT_FOUND", message: "Synthetic error." } }), false);
  }
});

function requestSchema(path: string, method: RequestCase["method"]): JsonSchema {
  const actionOperation = operation(path, method);
  return actionOperation.requestBody.content["application/json"].schema;
}

function defaultErrorSchema(path: string, method: RequestCase["method"]): JsonSchema {
  return operation(path, method).responses.default.content["application/json"].schema;
}

function pathParameterSchema(path: string, method: RequestCase["method"]): JsonSchema {
  const paths = beautioActionsOpenApiV1.paths as unknown as Readonly<Record<string, Readonly<Record<string, {
    readonly parameters?: readonly [{ readonly schema: JsonSchema }];
  }>>>>;
  const schema = paths[path]?.[method]?.parameters?.[0]?.schema;
  assert.ok(schema, `missing path parameter for ${method} ${path}`);
  return schema;
}

function operation(path: string, method: RequestCase["method"]): {
  readonly requestBody: { readonly content: { readonly "application/json": { readonly schema: JsonSchema } } };
  readonly responses: { readonly default: { readonly content: { readonly "application/json": { readonly schema: JsonSchema } } } };
} {
  const paths = beautioActionsOpenApiV1.paths as unknown as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  const value = paths[path]?.[method];
  assert.ok(value, `missing ${method} ${path}`);
  return value as ReturnType<typeof operation>;
}

function validates(schema: JsonSchema, value: unknown): boolean {
  return z
    .fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
    .safeParse(value).success;
}

function firstRequiredKey(schema: JsonSchema, value: unknown): string | undefined {
  if (schema.required?.[0] !== undefined) return schema.required[0];
  return schema.oneOf
    ?.find((branch) => validates(branch, value))
    ?.required?.[0];
}

function withoutProperty(value: unknown, key: string): unknown {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  const { [key]: _removed, ...remaining } = value as Record<string, unknown>;
  return remaining;
}

function withProperty(value: unknown, key: string, entry: unknown): unknown {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return { ...value, [key]: entry };
}

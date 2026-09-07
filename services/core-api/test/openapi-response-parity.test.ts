import assert from "node:assert/strict";
import test from "node:test";
import {
  consequentialCommandOperationIds,
  customGptCommandStatusOutputSchema,
  customGptCreateCommandOutputSchema,
  customGptFactCommandOutputSchema,
  customGptFetchOutputSchema,
  customGptSetDisplayImageCommandOutputSchema,
  customGptUploadImagesCommandOutputSchema,
} from "@beautio/contracts";
import { z } from "zod";
import { beautioActionsOpenApiV1 } from "../src/openapi.ts";

interface JsonSchema {
  readonly oneOf?: readonly JsonSchema[];
  readonly content?: Readonly<Record<string, { readonly schema: JsonSchema }>>;
}

interface RuntimeSchema {
  safeParse(value: unknown): { readonly success: boolean };
}

type OperationId = (typeof consequentialCommandOperationIds)[number];

interface WriteResponseCase {
  readonly operationId: OperationId;
  readonly path: string;
  readonly method: "patch" | "post" | "put";
  readonly result: Readonly<Record<string, unknown>>;
  readonly runtimeSchema: RuntimeSchema;
}

const commandId = "123e4567-e89b-42d3-a456-426614174000";
const createdAt = "2026-09-07T00:00:00.000Z";
const completedAt = "2026-09-07T00:00:01.000Z";
const imageId = "223e4567-e89b-42d3-a456-426614174000";
const inventoryId = "323e4567-e89b-42d3-a456-426614174000";

const responseCases: readonly WriteResponseCase[] = [
  {
    operationId: "upload_product_images",
    path: "/api/actions/upload-product-images",
    method: "post",
    result: { outcome: "uploaded", image_asset_ids: [imageId], expires_at: completedAt },
    runtimeSchema: customGptUploadImagesCommandOutputSchema,
  },
  {
    operationId: "create_inventory_batch",
    path: "/api/actions/create-inventory-batch",
    method: "post",
    result: { outcome: "created", inventory_item_ids: [inventoryId] },
    runtimeSchema: customGptCreateCommandOutputSchema,
  },
  {
    operationId: "revise_product_profile",
    path: "/api/actions/products/{product_id}/profile",
    method: "patch",
    result: { product_id: "synthetic-product", revision: 2, outcome: "updated" },
    runtimeSchema: customGptFactCommandOutputSchema,
  },
  {
    operationId: "set_product_display_image",
    path: "/api/actions/products/{product_id}/display-image",
    method: "put",
    result: { product_id: "synthetic-product", revision: 2, outcome: "updated" },
    runtimeSchema: customGptSetDisplayImageCommandOutputSchema,
  },
  {
    operationId: "correct_inventory_item_facts",
    path: "/api/actions/inventory-items/{inventory_item_id}/facts",
    method: "patch",
    result: { inventory_item_id: "synthetic-bottle", revision: 2, outcome: "updated" },
    runtimeSchema: customGptFactCommandOutputSchema,
  },
  {
    operationId: "set_inventory_item_custom_notes",
    path: "/api/actions/inventory-items/{inventory_item_id}/custom-notes",
    method: "put",
    result: { inventory_item_id: "synthetic-bottle", revision: 2, outcome: "updated" },
    runtimeSchema: customGptFactCommandOutputSchema,
  },
  {
    operationId: "record_product_opened",
    path: "/api/actions/inventory-items/{inventory_item_id}/open",
    method: "post",
    result: { inventory_item_id: "synthetic-bottle", revision: 2, outcome: "opened" },
    runtimeSchema: customGptFactCommandOutputSchema,
  },
  {
    operationId: "end_inventory_item_use",
    path: "/api/actions/inventory-items/{inventory_item_id}/end-use",
    method: "post",
    result: { inventory_item_id: "synthetic-bottle", revision: 2, outcome: "finished" },
    runtimeSchema: customGptFactCommandOutputSchema,
  },
];

test("all eight direct write response schemas accept each strict status branch", () => {
  assert.equal(responseCases.length, 8);
  for (const sample of responseCases) {
    const schema = directResponseSchema(sample);
    const values = [
      commandOutput(sample.operationId, "in_progress", null),
      commandOutput(sample.operationId, "failed", null),
      commandOutput(sample.operationId, "succeeded", sample.result),
    ];
    for (const value of values) {
      assert.equal(validate(schema, value), true, `${sample.operationId} OpenAPI ${value.status}`);
      assert.equal(sample.runtimeSchema.safeParse(value).success, true, `${sample.operationId} runtime ${value.status}`);
    }
  }
});

test("command-status schemas allow historical null success and reject cross-operation or expanded receipts", () => {
  const schema = commandStatusResponseSchema();
  for (const [index, sample] of responseCases.entries()) {
    const historical = commandOutput(sample.operationId, "succeeded", null);
    const current = commandOutput(sample.operationId, "succeeded", sample.result);
    assert.equal(validate(schema, historical), true, `${sample.operationId} historical OpenAPI`);
    assert.equal(customGptCommandStatusOutputSchema.safeParse(historical).success, true, `${sample.operationId} historical runtime`);
    assert.equal(validate(schema, current), true, `${sample.operationId} current OpenAPI`);
    assert.equal(customGptCommandStatusOutputSchema.safeParse(current).success, true, `${sample.operationId} current runtime`);

    const incompatible = responseCases[(index + 1) % responseCases.length];
    assert.ok(incompatible);
    const crossOperation = commandOutput(
      sample.operationId,
      "succeeded",
      incompatibleResult(sample.operationId, incompatible.result),
    );
    assert.equal(validate(schema, crossOperation), false, `${sample.operationId} cross-operation OpenAPI`);
    assert.equal(customGptCommandStatusOutputSchema.safeParse(crossOperation).success, false, `${sample.operationId} cross-operation runtime`);

    const expanded = commandOutput(sample.operationId, "succeeded", {
      ...sample.result,
      unexpected: "not public",
    });
    assert.equal(validate(schema, expanded), false, `${sample.operationId} expanded OpenAPI`);
    assert.equal(customGptCommandStatusOutputSchema.safeParse(expanded).success, false, `${sample.operationId} expanded runtime`);
  }
});

test("fetch response persisted text rejects unsupported C0 controls in OpenAPI and runtime schemas", () => {
  const schema = fetchResponseSchema();
  const valid = fetchOutput("Recorded text");
  const invalid = fetchOutput("unsafe\u0000text");
  assert.equal(validate(schema, valid), true);
  assert.equal(customGptFetchOutputSchema.safeParse(valid).success, true);
  assert.equal(validate(schema, invalid), false);
  assert.equal(customGptFetchOutputSchema.safeParse(invalid).success, false);
});

function commandOutput(
  operationId: OperationId,
  status: "failed" | "in_progress" | "succeeded",
  result: Readonly<Record<string, unknown>> | null,
) {
  if (status === "in_progress") {
    return { operation_id: operationId, command_id: commandId, status, created_at: createdAt, completed_at: null, failure_code: null, result: null } as const;
  }
  if (status === "failed") {
    return { operation_id: operationId, command_id: commandId, status, created_at: createdAt, completed_at: completedAt, failure_code: "INVALID_INPUT", result: null } as const;
  }
  return { operation_id: operationId, command_id: commandId, status, created_at: createdAt, completed_at: completedAt, failure_code: null, result } as const;
}

function incompatibleResult(
  operationId: OperationId,
  candidate: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (operationId === "create_inventory_batch") {
    return responseCases[0]?.result ?? candidate;
  }
  if (operationId === "upload_product_images") {
    return responseCases[1]?.result ?? candidate;
  }
  return responseCases[1]?.result ?? candidate;
}

function directResponseSchema(sample: WriteResponseCase): JsonSchema {
  const paths = beautioActionsOpenApiV1.paths as unknown as Readonly<Record<string, Readonly<Record<string, {
    readonly responses: { readonly "200": { readonly content: { readonly "application/json": { readonly schema: JsonSchema } } } };
  }>>>>;
  const operation = paths[sample.path]?.[sample.method];
  assert.ok(operation, `missing ${sample.method} ${sample.path}`);
  return operation.responses["200"].content["application/json"].schema;
}

function commandStatusResponseSchema(): JsonSchema {
  const paths = beautioActionsOpenApiV1.paths as unknown as Readonly<Record<string, {
    readonly post: { readonly responses: { readonly "200": { readonly content: { readonly "application/json": { readonly schema: JsonSchema } } } } };
  }>>;
  return paths["/api/actions/commands/status"]?.post.responses["200"].content["application/json"].schema ?? {};
}

function fetchResponseSchema(): JsonSchema {
  const paths = beautioActionsOpenApiV1.paths as unknown as Readonly<Record<string, {
    readonly post: { readonly responses: { readonly "200": { readonly content: { readonly "application/json": { readonly schema: JsonSchema } } } } };
  }>>;
  return paths["/api/actions/inventory/fetch"]?.post.responses["200"].content["application/json"].schema ?? {};
}

function fetchOutput(text: string) {
  return {
    inventory_item: {
      inventory_item_id: "synthetic-bottle",
      product_id: "synthetic-product",
      product: {
        product_id: "synthetic-product",
        name: "Synthetic Product",
        alias: null,
        brand: null,
        category: null,
        size_label: null,
        pao_duration_months: null,
        ingredient_list_text: text,
        shared_notes: text,
        has_image: false,
        revision: 1,
      },
      lifecycle_status: "unopened",
      opened_on: null,
      opened_on_accuracy: null,
      expires_on: null,
      pao_duration_months: null,
      pao_deadline: null,
      pao_deadline_accuracy: null,
      usable_until: null,
      remaining_percent_estimate: null,
      custom_notes: text,
      derived_status: null,
      revision: 1,
    },
    display_image_matches_expected: null,
  } as const;
}

function validate(schema: JsonSchema, value: unknown): boolean {
  return z
    .fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
    .safeParse(value).success;
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  beautioActionsOpenApiV1,
  createBeautioActionsOpenApiV1,
} from "../src/openapi.ts";

interface JsonSchemaView {
  readonly type?: string;
  readonly additionalProperties?: boolean;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaView>>;
  readonly items?: JsonSchemaView;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly anyOf?: readonly JsonSchemaView[];
  readonly oneOf?: readonly JsonSchemaView[];
  readonly enum?: readonly string[];
  readonly const?: string | number | boolean | null;
  readonly pattern?: string;
  readonly description?: string;
}

interface JsonResponseView {
  readonly content: {
    readonly "application/json": {
      readonly schema: JsonSchemaView;
    };
  };
}

interface ParameterView {
  readonly name: string;
  readonly in: string;
  readonly required: boolean;
  readonly description: string;
  readonly schema: JsonSchemaView;
}

interface OperationView {
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly "x-openai-isConsequential": boolean;
  readonly security: readonly unknown[];
  readonly parameters?: readonly ParameterView[];
  readonly requestBody: {
    readonly required: boolean;
    readonly content: {
      readonly "application/json": {
        readonly schema: JsonSchemaView;
      };
    };
  };
  readonly responses: Readonly<Record<string, JsonResponseView>>;
}

const expectedActions = [
  {
    method: "post",
    path: "/api/actions/inventory/search",
    operationId: "search_inventory",
    consequential: false,
  },
  {
    method: "post",
    path: "/api/actions/inventory/fetch",
    operationId: "fetch_inventory_item",
    consequential: false,
  },
  {
    method: "post",
    path: "/api/actions/commands/status",
    operationId: "get_command_status",
    consequential: false,
  },
  {
    method: "patch",
    path: "/api/actions/products/{product_id}/profile",
    operationId: "revise_product_profile",
    consequential: true,
  },
  {
    method: "patch",
    path: "/api/actions/inventory-items/{inventory_item_id}/facts",
    operationId: "correct_inventory_item_facts",
    consequential: true,
  },
  {
    method: "put",
    path: "/api/actions/inventory-items/{inventory_item_id}/custom-notes",
    operationId: "set_inventory_item_custom_notes",
    consequential: true,
  },
  {
    method: "post",
    path: "/api/actions/inventory-items/{inventory_item_id}/open",
    operationId: "record_product_opened",
    consequential: true,
  },
  {
    method: "post",
    path: "/api/actions/inventory-items/{inventory_item_id}/end-use",
    operationId: "end_inventory_item_use",
    consequential: true,
  },
  {
    method: "post",
    path: "/api/actions/create-inventory-batch",
    operationId: "create_inventory_batch",
    consequential: true,
  },
  {
    method: "post",
    path: "/api/actions/upload-product-images",
    operationId: "upload_product_images",
    consequential: true,
  },
  {
    method: "put",
    path: "/api/actions/products/{product_id}/display-image",
    operationId: "set_product_display_image",
    consequential: true,
  },
] as const;

const commandStatusFields = [
  "operation_id",
  "command_id",
  "status",
  "created_at",
  "completed_at",
  "failure_code",
  "result",
] as const;

const paths = beautioActionsOpenApiV1.paths as unknown as Readonly<
  Record<string, Readonly<Record<string, OperationView>>>
>;

function operationAt(path: string, method: string): OperationView {
  const pathItem = paths[path];
  assert.ok(pathItem, `missing OpenAPI path ${path}`);
  const operation = pathItem[method];
  assert.ok(operation, `missing OpenAPI operation ${method} ${path}`);
  return operation;
}

function requestSchemaOf(operation: OperationView): JsonSchemaView {
  assert.equal(operation.requestBody.required, true);
  return operation.requestBody.content["application/json"].schema;
}

function responseSchemaOf(
  operation: OperationView,
  status: string,
): JsonSchemaView {
  const response = operation.responses[status];
  assert.ok(response, `missing ${status} response for ${operation.operationId}`);
  return response.content["application/json"].schema;
}

function propertiesOf(
  schema: JsonSchemaView,
): Readonly<Record<string, JsonSchemaView>> {
  assert.ok(schema.properties, "expected object schema properties");
  return schema.properties;
}

function branchesOf(
  schema: JsonSchemaView,
  keyword: "anyOf" | "oneOf",
): readonly JsonSchemaView[] {
  const branches = schema[keyword];
  assert.ok(branches, `expected ${keyword} schema branches`);
  return branches;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function directSuccessResultSchema(operation: OperationView): JsonSchemaView {
  const responseSchema = responseSchemaOf(operation, "200");
  const succeeded = branchesOf(responseSchema, "oneOf").find(
    (branch) => propertiesOf(branch).status?.const === "succeeded",
  );
  assert.ok(succeeded, `missing succeeded response for ${operation.operationId}`);
  const result = propertiesOf(succeeded).result;
  assert.ok(result, `missing succeeded result for ${operation.operationId}`);
  return result;
}

test("Action OpenAPI exposes the exact three-read and eight-write surface", () => {
  assert.equal(beautioActionsOpenApiV1.openapi, "3.1.0");
  assert.equal(beautioActionsOpenApiV1.info.version, "2.0.0");
  assert.match(beautioActionsOpenApiV1.info.description, /three read operations/i);
  assert.match(
    beautioActionsOpenApiV1.info.description,
    /eight consequential writes/i,
  );
  assert.match(
    beautioActionsOpenApiV1.info.description,
    /explicit user confirmation/i,
  );
  assert.match(beautioActionsOpenApiV1.info.description, /replay-safe/i);
  assert.doesNotMatch(
    beautioActionsOpenApiV1.info.description,
    /Builder|production|deployed|live/i,
  );

  const actualMapping = Object.entries(paths)
    .flatMap(([path, pathItem]) =>
      Object.entries(pathItem).map(
        ([method, operation]) =>
          `${method} ${path} ${operation.operationId}`,
      ),
    )
    .sort();
  const expectedMapping = expectedActions
    .map(
      ({ method, path, operationId }) =>
        `${method} ${path} ${operationId}`,
    )
    .sort();

  assert.equal(Object.keys(paths).length, 11);
  assert.deepEqual(actualMapping, expectedMapping);

  const operationIds = new Set<string>();
  let readCount = 0;
  let writeCount = 0;
  for (const expected of expectedActions) {
    const operation = operationAt(expected.path, expected.method);
    assert.equal(operation.operationId, expected.operationId);
    assert.equal(
      operation["x-openai-isConsequential"],
      expected.consequential,
    );
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    operationIds.add(operation.operationId);
    if (operation["x-openai-isConsequential"]) {
      writeCount += 1;
    } else {
      readCount += 1;
    }
  }

  assert.equal(operationIds.size, 11);
  assert.equal(readCount, 3);
  assert.equal(writeCount, 8);
  assert.deepEqual(beautioActionsOpenApiV1.components.schemas, {});
  assert.deepEqual(
    beautioActionsOpenApiV1.components.securitySchemes.bearerAuth,
    {
      type: "http",
      scheme: "bearer",
      description: "Use the private Beautio Custom GPT key.",
    },
  );
});

test("Action OpenAPI excludes management, Codex, MCP, and other routes", () => {
  const routeList = Object.keys(paths).join("\n");

  assert.ok(Object.keys(paths).every((path) => path.startsWith("/api/actions/")));
  assert.doesNotMatch(routeList, /\/api\/admin/u);
  assert.doesNotMatch(routeList, /\/api\/actions\/codex/u);
  assert.doesNotMatch(routeList, /\/mcp(?:\/|$)/u);
  assert.doesNotMatch(routeList, /image-assets\/.*content/u);
  assert.doesNotMatch(routeList, /backup|restore|delete/u);
});

test("upload and create keep command UUID inputs and compact receipts", () => {
  const upload = operationAt(
    "/api/actions/upload-product-images",
    "post",
  );
  const uploadInput = requestSchemaOf(upload);
  const uploadInputProperties = propertiesOf(uploadInput);
  const fileRefs = uploadInputProperties.openaiFileIdRefs;
  assert.ok(fileRefs);

  assert.equal(uploadInput.additionalProperties, false);
  assert.deepEqual(sorted(uploadInput.required ?? []), [
    "command_id",
    "openaiFileIdRefs",
  ]);
  assert.match(uploadInputProperties.command_id?.pattern ?? "", /^\^\[0-9a-f\]/u);
  assert.equal(fileRefs.items?.type, "string");
  assert.equal(fileRefs.minItems, 1);
  assert.equal(fileRefs.maxItems, 10);
  assert.equal(fileRefs.uniqueItems, true);
  assert.match(fileRefs.description ?? "", /platform.*runtime.*file-reference object/i);

  const uploadResult = directSuccessResultSchema(upload);
  assert.deepEqual(sorted(uploadResult.required ?? []), [
    "expires_at",
    "image_asset_ids",
    "outcome",
  ]);
  assert.deepEqual(sorted(Object.keys(propertiesOf(uploadResult))), [
    "expires_at",
    "image_asset_ids",
    "outcome",
  ]);
  assert.doesNotMatch(
    JSON.stringify(uploadResult),
    /source_ref|download_link|"assets"/u,
  );

  const create = operationAt(
    "/api/actions/create-inventory-batch",
    "post",
  );
  const createInput = requestSchemaOf(create);
  const createInputProperties = propertiesOf(createInput);
  assert.deepEqual(sorted(createInput.required ?? []), [
    "as_of",
    "command_id",
    "inventory_items",
    "products",
  ]);
  assert.match(createInputProperties.command_id?.pattern ?? "", /^\^\[0-9a-f\]/u);

  const createResult = directSuccessResultSchema(create);
  assert.deepEqual(sorted(createResult.required ?? []), [
    "inventory_item_ids",
    "outcome",
  ]);
  assert.deepEqual(sorted(Object.keys(propertiesOf(createResult))), [
    "inventory_item_ids",
    "outcome",
  ]);
  assert.doesNotMatch(
    JSON.stringify(createResult),
    /"products"|"inventory_items"|"batch_ref"/u,
  );
});

test("fact writes keep targets in paths and encode revision and branch rules", () => {
  const targetedWrites = [
    {
      method: "patch",
      path: "/api/actions/products/{product_id}/profile",
      parameter: "product_id",
    },
    {
      method: "put",
      path: "/api/actions/products/{product_id}/display-image",
      parameter: "product_id",
    },
    {
      method: "patch",
      path: "/api/actions/inventory-items/{inventory_item_id}/facts",
      parameter: "inventory_item_id",
    },
    {
      method: "put",
      path: "/api/actions/inventory-items/{inventory_item_id}/custom-notes",
      parameter: "inventory_item_id",
    },
    {
      method: "post",
      path: "/api/actions/inventory-items/{inventory_item_id}/open",
      parameter: "inventory_item_id",
    },
    {
      method: "post",
      path: "/api/actions/inventory-items/{inventory_item_id}/end-use",
      parameter: "inventory_item_id",
    },
  ] as const;

  for (const target of targetedWrites) {
    const operation = operationAt(target.path, target.method);
    assert.equal(operation.parameters?.length, 1);
    assert.equal(operation.parameters[0]?.name, target.parameter);
    assert.equal(operation.parameters[0]?.in, "path");
    assert.equal(operation.parameters[0]?.required, true);
    assert.doesNotMatch(
      JSON.stringify(requestSchemaOf(operation)),
      new RegExp(`"${target.parameter}"`, "u"),
    );
  }

  const operationsWithRevision = expectedActions
    .filter(({ path, method }) =>
      JSON.stringify(requestSchemaOf(operationAt(path, method))).includes(
        '"expected_revision"',
      ),
    )
    .map(({ operationId }) => operationId)
    .sort();
  assert.deepEqual(operationsWithRevision, [
    "correct_inventory_item_facts",
    "revise_product_profile",
    "set_product_display_image",
  ]);

  const profilePatch = requestSchemaOf(
    operationAt("/api/actions/products/{product_id}/profile", "patch"),
  );
  assert.deepEqual(
    branchesOf(profilePatch, "anyOf").map((branch) =>
      branch.required?.find(
        (field) => field !== "command_id" && field !== "expected_revision",
      ),
    ),
    [
      "name",
      "alias",
      "brand",
      "category",
      "size_label",
      "pao_duration_months",
      "ingredient_list_text",
      "shared_notes",
    ],
  );

  const factPatch = requestSchemaOf(
    operationAt(
      "/api/actions/inventory-items/{inventory_item_id}/facts",
      "patch",
    ),
  );
  assert.deepEqual(
    branchesOf(factPatch, "anyOf").map((branch) =>
      branch.required?.find(
        (field) => field !== "command_id" && field !== "expected_revision",
      ),
    ),
    ["opened_on", "opened_on_accuracy", "expires_on", "pao_duration_months"],
  );

  const endUse = requestSchemaOf(
    operationAt(
      "/api/actions/inventory-items/{inventory_item_id}/end-use",
      "post",
    ),
  );
  const endBranches = branchesOf(endUse, "oneOf");
  assert.equal(endBranches.length, 2);
  const finished = endBranches.find(
    (branch) => propertiesOf(branch).lifecycle_status?.const === "finished",
  );
  const discarded = endBranches.find(
    (branch) => propertiesOf(branch).lifecycle_status?.const === "discarded",
  );
  assert.ok(finished);
  assert.ok(discarded);
  assert.deepEqual(sorted(finished.required ?? []), [
    "as_of",
    "command_id",
    "lifecycle_status",
  ]);
  assert.equal(propertiesOf(finished).remaining_percent_estimate, undefined);
  assert.deepEqual(sorted(discarded.required ?? []), [
    "as_of",
    "command_id",
    "lifecycle_status",
    "remaining_percent_estimate",
  ]);
  const remaining = propertiesOf(discarded).remaining_percent_estimate;
  assert.ok(remaining);
  assert.deepEqual(
    branchesOf(remaining, "anyOf").map((branch) => branch.type),
    ["integer", "null"],
  );
});

test("direct write responses have seven strict fields and non-null success receipts", () => {
  const writeActions = expectedActions.filter(
    ({ consequential }) => consequential,
  );

  for (const expected of writeActions) {
    const operation = operationAt(expected.path, expected.method);
    const response = responseSchemaOf(operation, "200");
    const branches = branchesOf(response, "oneOf");
    assert.equal(branches.length, 3, expected.operationId);
    assert.deepEqual(
      branches.map((branch) => propertiesOf(branch).status?.const).sort(),
      ["failed", "in_progress", "succeeded"],
      expected.operationId,
    );

    for (const branch of branches) {
      assert.equal(branch.additionalProperties, false, expected.operationId);
      assert.deepEqual(
        sorted(branch.required ?? []),
        sorted(commandStatusFields),
        expected.operationId,
      );
      assert.deepEqual(
        sorted(Object.keys(propertiesOf(branch))),
        sorted(commandStatusFields),
        expected.operationId,
      );
      assert.equal(
        propertiesOf(branch).operation_id?.const,
        expected.operationId,
      );
    }

    const successResult = directSuccessResultSchema(operation);
    assert.equal(successResult.type, "object", expected.operationId);
    assert.equal(successResult.anyOf, undefined, expected.operationId);
  }
});

test("command status permits historical null results and whitelists each receipt", () => {
  const writeActions = expectedActions.filter(
    ({ consequential }) => consequential,
  );
  const operationWhitelist = writeActions
    .map(({ operationId }) => operationId)
    .sort();
  const statusOperation = operationAt("/api/actions/commands/status", "post");
  const statusInput = requestSchemaOf(statusOperation);
  assert.deepEqual(
    sorted(propertiesOf(statusInput).operation_id?.enum ?? []),
    operationWhitelist,
  );

  const statusBranches = branchesOf(
    responseSchemaOf(statusOperation, "200"),
    "oneOf",
  );
  assert.equal(statusBranches.length, 11);
  for (const branch of statusBranches) {
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual(sorted(branch.required ?? []), sorted(commandStatusFields));
    assert.deepEqual(
      sorted(Object.keys(propertiesOf(branch))),
      sorted(commandStatusFields),
    );
  }

  const genericStatuses = ["not_found", "in_progress", "failed"] as const;
  for (const status of genericStatuses) {
    const branch = statusBranches.find(
      (candidate) => propertiesOf(candidate).status?.const === status,
    );
    assert.ok(branch, `missing ${status} command-status branch`);
    assert.deepEqual(
      sorted(propertiesOf(branch).operation_id?.enum ?? []),
      operationWhitelist,
    );
    assert.equal(propertiesOf(branch).result?.type, "null");
  }

  const succeededBranches = statusBranches.filter(
    (branch) => propertiesOf(branch).status?.const === "succeeded",
  );
  assert.equal(succeededBranches.length, 8);
  const succeededOperationIds: string[] = [];
  for (const branch of succeededBranches) {
    const operationId = propertiesOf(branch).operation_id?.const;
    assert.ok(typeof operationId === "string");
    succeededOperationIds.push(operationId);

    const expected = writeActions.find(
      (candidate) => candidate.operationId === operationId,
    );
    assert.ok(expected, `unexpected command-status operation ${operationId}`);
    const result = propertiesOf(branch).result;
    assert.ok(result);
    const resultBranches = branchesOf(result, "anyOf");
    assert.equal(resultBranches.length, 2);
    const historicalResult = resultBranches.find(
      (candidate) => candidate.type !== "null",
    );
    assert.ok(historicalResult);
    assert.ok(resultBranches.some((candidate) => candidate.type === "null"));
    assert.deepEqual(
      historicalResult,
      directSuccessResultSchema(operationAt(expected.path, expected.method)),
    );
  }
  assert.deepEqual(succeededOperationIds.sort(), operationWhitelist);
});

test("all errors omit internal refs and descriptions stay within limits", () => {
  for (const expected of expectedActions) {
    const operation = operationAt(expected.path, expected.method);
    assert.ok(operation.summary.length > 0);
    assert.ok(operation.summary.length <= 300, expected.operationId);
    assert.ok(operation.description.length > 0);
    assert.ok(operation.description.length <= 300, expected.operationId);
    for (const parameter of operation.parameters ?? []) {
      assert.ok(parameter.description.length > 0);
      assert.ok(parameter.description.length <= 700, expected.operationId);
    }

    const error = responseSchemaOf(operation, "default");
    assert.deepEqual(Object.keys(propertiesOf(error)), ["error"]);
    const errorBody = propertiesOf(error).error;
    assert.ok(errorBody);
    assert.deepEqual(sorted(errorBody.required ?? []), ["code", "message"]);
    assert.deepEqual(sorted(Object.keys(propertiesOf(errorBody))), [
      "code",
      "message",
    ]);
    assert.equal(propertiesOf(errorBody).ref, undefined);
  }
});

test("public Action OpenAPI wrapper adds exactly one origin without mutation", () => {
  assert.equal(createBeautioActionsOpenApiV1(undefined), beautioActionsOpenApiV1);
  assert.equal("servers" in beautioActionsOpenApiV1, false);

  const publicDocument = createBeautioActionsOpenApiV1(
    "https://beautio.example.test",
  );
  assert.notEqual(publicDocument, beautioActionsOpenApiV1);
  assert.deepEqual(publicDocument.servers, [
    { url: "https://beautio.example.test" },
  ]);
  assert.equal("servers" in beautioActionsOpenApiV1, false);
});

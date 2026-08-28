import assert from "node:assert/strict";
import test from "node:test";
import {
  beautioActionsOpenApiV1,
  createBeautioActionsOpenApiV1,
} from "../src/openapi.ts";

test("Action OpenAPI exposes only the two consequential business writes", () => {
  assert.equal(beautioActionsOpenApiV1.info.version, "1.3.0");
  assert.deepEqual(Object.keys(beautioActionsOpenApiV1.paths), [
    "/api/actions/upload-product-images",
    "/api/actions/create-inventory-batch",
  ]);
  const upload =
    beautioActionsOpenApiV1.paths["/api/actions/upload-product-images"].post;
  const create =
    beautioActionsOpenApiV1.paths["/api/actions/create-inventory-batch"].post;

  assert.equal(upload.operationId, "upload_product_images");
  assert.equal(create.operationId, "create_inventory_batch");
  assert.equal(upload["x-openai-isConsequential"], true);
  assert.equal(create["x-openai-isConsequential"], true);
  assert.deepEqual(upload.security, [{ bearerAuth: [] }]);
  assert.deepEqual(create.security, [{ bearerAuth: [] }]);
  assert.match(create.description, /Atomically creates/i);
  assert.match(create.description, /shared Product/i);
  assert.match(create.description, /one bottle/i);
  assert.match(create.description, /ask before calling/i);
  assert.match(create.description, /result is unknown/i);
  assert.ok(create.description.length <= 300);
  assert.deepEqual(beautioActionsOpenApiV1.components.schemas, {});
});

test("Action batch schema distinguishes shared Product text from per-bottle notes", () => {
  const create =
    beautioActionsOpenApiV1.paths["/api/actions/create-inventory-batch"].post;
  const input = create.requestBody.content["application/json"].schema as unknown as BatchInputSchemaView;
  const product = input.properties.products.items;
  const inventoryItem = input.properties.inventory_items.items;

  assert.equal(product.additionalProperties, false);
  assert.equal(product.properties.alias.anyOf[0]?.maxLength, 10);
  assert.match(product.properties.alias.description, /confirmed/i);
  assert.match(product.properties.alias.description, /never guess/i);
  assert.equal(product.properties.brand.anyOf[0]?.maxLength, 100);
  assert.match(product.properties.brand.description, /null.*uncertain/i);
  assert.equal(
    product.properties.ingredient_list_text.anyOf[0]?.maxLength,
    5000,
  );
  assert.equal(product.properties.shared_notes.anyOf[0]?.maxLength, 1000);
  assert.match(
    product.properties.ingredient_list_text.description,
    /shared Product/i,
  );
  assert.match(product.properties.shared_notes.description, /ask the user/i);
  assert.equal(inventoryItem.additionalProperties, false);
  assert.equal(inventoryItem.properties.custom_notes.anyOf[0]?.maxLength, 1000);
  assert.match(
    inventoryItem.properties.custom_notes.description,
    /only this physical inventory bottle/i,
  );

  const output = create.responses["200"].content["application/json"]
    .schema as unknown as BatchOutputSchemaView;
  const outputProduct = output.properties.products.items;
  const outputInventoryItem = output.properties.inventory_items.items;
  assert.ok(outputProduct.required.includes("ingredient_list_text"));
  assert.ok(outputProduct.required.includes("alias"));
  assert.ok(outputProduct.required.includes("brand"));
  assert.ok(outputProduct.required.includes("shared_notes"));
  assert.ok(outputInventoryItem.required.includes("custom_notes"));
});

interface TextPropertySchemaView {
  readonly description: string;
  readonly anyOf: readonly [{ readonly maxLength: number }, unknown];
}

interface BatchInputSchemaView {
  readonly properties: {
    readonly products: {
      readonly items: {
        readonly additionalProperties: false;
        readonly properties: {
          readonly alias: {
            readonly description: string;
            readonly anyOf: readonly [{ readonly maxLength: number }, unknown];
          };
          readonly brand: {
            readonly description: string;
            readonly anyOf: readonly [{ readonly maxLength: number }, unknown];
          };
          readonly ingredient_list_text: TextPropertySchemaView;
          readonly shared_notes: TextPropertySchemaView;
        };
      };
    };
    readonly inventory_items: {
      readonly items: {
        readonly additionalProperties: false;
        readonly properties: {
          readonly custom_notes: TextPropertySchemaView;
        };
      };
    };
  };
}

interface BatchOutputSchemaView {
  readonly properties: {
    readonly products: {
      readonly items: { readonly required: readonly string[] };
    };
    readonly inventory_items: {
      readonly items: { readonly required: readonly string[] };
    };
  };
}

test("Action file wire schema keeps openaiFileIdRefs items as strings", () => {
  const upload =
    beautioActionsOpenApiV1.paths["/api/actions/upload-product-images"].post;
  const schema = upload.requestBody.content["application/json"].schema;
  const fileRefs = schema.properties.openaiFileIdRefs;

  assert.equal(fileRefs.items.type, "string");
  assert.equal(fileRefs.minItems, 1);
  assert.equal(fileRefs.maxItems, 10);
  assert.match(fileRefs.description, /already confirmed/i);
  assert.match(fileRefs.description, /Do not attach receipts/i);
});

test("Action OpenAPI contains no management routes or secret value", () => {
  const serialized = JSON.stringify(beautioActionsOpenApiV1);
  assert.doesNotMatch(serialized, /\/api\/admin|\/api\/inventory|image-assets\/.*content/);
  assert.doesNotMatch(serialized, /token-value|secret-value|Bearer\s+[A-Za-z0-9]/i);
});

test("public Action OpenAPI names exactly one normalized deployment origin", () => {
  const publicDocument = createBeautioActionsOpenApiV1(
    "https://beautio.example.test",
  );

  assert.deepEqual(publicDocument.servers, [
    { url: "https://beautio.example.test" },
  ]);
  assert.equal("servers" in beautioActionsOpenApiV1, false);
});

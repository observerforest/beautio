import assert from "node:assert/strict";
import test from "node:test";
import { beautioActionsOpenApiV1 } from "../src/openapi.ts";
import { entityRevisionSchema, pathIdSchema } from "../src/openapi/common.ts";

interface SchemaView {
  readonly description?: string;
  readonly properties?: Readonly<Record<string, SchemaView>>;
  readonly anyOf?: readonly SchemaView[];
}

const profile = beautioActionsOpenApiV1.paths[
  "/api/actions/products/{product_id}/profile"
].patch;
const input: SchemaView = profile.requestBody.content["application/json"].schema;
const productId = profile.parameters[0];

test("profile guidance binds the target and revision to the same verified fetch", () => {
  assert.match(productId.description, /most recent fetch_inventory_item response/);
  assert.match(productId.description, /verifying the target bottle/);
  assert.match(productId.description, /Copy inventory_item\.product\.product_id verbatim/);
  assert.match(productId.description, /Do not use inventory_item\.inventory_item_id or command_id/);
  assert.match(productId.description, /never generate or rewrite an entity ID/);
  assert.match(profile.description, /Bind Product ID and revision to the same verified fetch/);
  assert.match(profile.description, /stop without writing if values are missing or linkage is inconsistent/);

  for (const schema of [input, ...(input.anyOf ?? [])]) {
    const revision = schema.properties?.expected_revision;
    assert.ok(revision?.description);
    assert.match(revision.description, /Copy inventory_item\.product\.revision from the same most recent fetch_inventory_item response used for product_id/);
    assert.match(revision.description, /Do not use inventory_item\.revision/);
    for (const description of [productId.description, revision.description]) {
      assert.match(description, /Product ID or revision is missing/);
      assert.match(description, /inventory_item\.product_id differs from inventory_item\.product\.product_id/);
      assert.match(description, /stop without writing and fetch the target bottle again/);
    }
    const { description: _description, ...validation } = revision;
    assert.deepEqual(validation, entityRevisionSchema);
  }
  assert.deepEqual(productId.schema, pathIdSchema);
});

test("profile guidance contains no concrete identities or local acceptance context", () => {
  const descriptions = [
    profile.description,
    productId.description,
    input.properties?.expected_revision?.description,
    ...(input.anyOf ?? []).map((branch) => branch.properties?.expected_revision?.description),
  ].join("\n");
  assert.doesNotMatch(descriptions, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  assert.doesNotMatch(descriptions, /https?:\/\/|\/Users\/|\.local\/|localhost|127\.0\.0\.1|acceptance|synthetic|preview|internal/i);
});

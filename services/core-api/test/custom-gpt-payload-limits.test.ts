import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { customGptCommandStatusOutputSchema, customGptCreateActionErrorSchema, customGptCreateCommandOutputSchema, customGptFetchOutputSchema, customGptImageActionErrorSchema, customGptSearchOutputSchema, customGptUploadImagesCommandOutputSchema } from "@beautio/contracts";
import { JSON_BODY_LIMIT } from "../src/body.ts";
import { beautioActionsOpenApiV1 } from "../src/openapi.ts";
import { customGptMaximumPayloadBytes } from "../src/custom-gpt-payload-limits.ts";
import { createActionFixture, createAdminToken, createCodexToken, createCommandId, createCustomGptToken } from "./custom-gpt-create-action-fixture.ts";
import { bindImageCommands, imageActionFixture, imageUploadBody } from "./custom-gpt-image-commands-fixture.ts";
import { readFixture } from "./custom-gpt-read-fixture.ts";

const maximum = 99_999;
const createPath = "/api/actions/create-inventory-batch";
const uploadPath = "/api/actions/upload-product-images";
const tables = ["products", "inventory_items", "image_assets", "revision_clock", "entity_revisions", "command_executions"];

function batch(index: number) {
  return { command_id: createCommandId(index), as_of: "2026-09-01",
    products: [{ batch_ref: "cream", name: "合成面霜", ingredient_list_text: "Aqua,\nGlycerin" }],
    inventory_items: [{ batch_ref: "bottle", product_ref: { kind: "new", batch_ref: "cream" }, lifecycle_status: "unopened" }] };
}

function paddedJson(value: unknown, bytes: number, escapeCjk = false): string {
  const json = JSON.stringify(value).replace(/[\u4e00-\u9fff]/gu, (character) =>
    escapeCjk ? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}` : character);
  return json + " ".repeat(bytes - Buffer.byteLength(json));
}

test("create accepts exactly 99999 raw UTF-8 bytes; oversized whitespace, CJK and escapes never reach preparation", { timeout: 15000 }, async (context) => {
  let prepares = 0;
  const fixture = await createActionFixture(context, { createCustomGptCreates: ({ service }) => ({
    prepare(input) { prepares++; return service.prepare(input); },
    executePrepared: service.executePrepared.bind(service),
  }) });
  const before = fixture.snapshot();
  for (const escaped of [false, true]) {
    const raw = paddedJson(batch(1), 100_000, escaped);
    assert.equal(Buffer.byteLength(raw), 100_000);
    assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(raw))) < maximum);
    const response = await fixture.request("POST", createPath, raw);
    assert.equal(response.status, 413);
    assert.equal(customGptCreateActionErrorSchema.parse(await response.json()).error.code, "UPLOAD_TOO_LARGE");
    assert.deepEqual(fixture.snapshot(), before);
    assert.equal(prepares, 0);
  }
  const raw = paddedJson(batch(1), maximum, true);
  assert.equal(Buffer.byteLength(raw), maximum);
  const response = await fixture.request("POST", createPath, raw);
  assert.equal(response.status, 200);
  assert.equal(customGptCreateCommandOutputSchema.parse(await response.json()).status, "succeeded");
  assert.equal(prepares, 1);
});

test("chunked create counts received bytes without trusting Content-Length", { timeout: 15000 }, async (context) => {
  const fixture = await createActionFixture(context);
  const before = fixture.snapshot();
  const payload = paddedJson(batch(2), 100_000);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(fixture.origin + createPath, { method: "POST", headers: {
      authorization: `Bearer ${createCustomGptToken}`, "content-type": "application/json", "transfer-encoding": "chunked",
    } }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); response.once("error", reject); });
    request.once("error", reject);
    request.write(payload.slice(0, 1000));
    request.end(payload.slice(1000));
  });
  assert.equal(status, 413);
  assert.deepEqual(fixture.snapshot(), before);
});

test("upload rejects raw runtime-reference overflow before prepare, claim or download, and accepts 99999 bytes", { timeout: 15000 }, async (context) => {
  let prepares = 0;
  let claims = 0;
  const fixture = await imageActionFixture(context, { createCommands: (service) => bindImageCommands(service, {
    prepareUpload(input) { prepares++; return service.prepareUpload(input); },
    claimPreparedUpload(input) { claims++; return service.claimPreparedUpload(input); },
  }) });
  const snapshot = () => tables.map((table) => fixture.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = snapshot();
  const oversizedName = imageUploadBody(1);
  oversizedName.openaiFileIdRefs[0]!.name = "界".repeat(34_000) + ".png";
  assert.ok(JSON.stringify(oversizedName).length < maximum);
  for (const raw of [paddedJson(imageUploadBody(1), 100_000), JSON.stringify(oversizedName)]) {
    const response = await fixture.request("POST", uploadPath, raw);
    assert.equal(response.status, 413);
    assert.equal(customGptImageActionErrorSchema.parse(await response.json()).error.code, "UPLOAD_TOO_LARGE");
    assert.equal(prepares, 0);
    assert.equal(claims, 0);
    assert.equal(fixture.downloads(), 0);
    assert.deepEqual(snapshot(), before);
  }
  const response = await fixture.request("POST", uploadPath, paddedJson(imageUploadBody(1), maximum));
  assert.equal(response.status, 200);
  assert.equal(customGptUploadImagesCommandOutputSchema.parse(await response.json()).status, "succeeded");
  assert.equal(prepares, 1);
  assert.equal(claims, 1);
  assert.equal(fixture.downloads(), 1);
});

test("Admin and Codex create retain their existing larger JSON allowance", { timeout: 15000 }, async (context) => {
  const fixture = await createActionFixture(context);
  assert.equal(JSON_BODY_LIMIT, 1024 * 1024);
  for (const [path, token, index] of [
    ["/api/admin/create-inventory-batch", createAdminToken, 3],
    ["/api/actions/codex/create-inventory-batch", createCodexToken, 4],
  ] as const) {
    const { command_id: _commandId, ...body } = batch(index);
    const response = await fixture.request("POST", path, paddedJson(body, 100_000), token);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
});

for (const kind of ["search", "fetch", "status"] as const) {
  test(`${kind} returns complete 99999-byte JSON but rejects 100000 bytes without data or DB changes`, { timeout: 15000 }, async (context) => {
    const fixture = await readFixture(context);
    const before = fixture.snapshot();
    const fetched = await fixture.reads.fetchInventoryItem({ inventory_item_id: "a-active" });
    assert.ok(fetched.inventory_item.product);
    const product = fetched.inventory_item.product;
    const searched = await fixture.reads.searchInventory({ limit: 1 });
    const first = searched.items[0];
    assert.ok(first);
    const build = (text: string) => kind === "fetch"
      ? { ...fetched, inventory_item: { ...fetched.inventory_item, product: { ...product, name: text } } }
      : kind === "search" ? { ...searched, items: [{ ...first, product_name: text }] }
      : { operation_id: "revise_product_profile", command_id: createCommandId(5), status: "succeeded",
        created_at: "2026-09-01T00:00:00.000Z", completed_at: "2026-09-01T00:00:00.000Z", failure_code: null,
        result: { product_id: text, revision: 1, outcome: "updated" } };
    const path = kind === "status" ? "/api/actions/commands/status" : `/api/actions/inventory/${kind}`;
    const input = kind === "fetch" ? { inventory_item_id: "a-active" } : kind === "status"
      ? { operation_id: "revise_product_profile", command_id: createCommandId(5) } : { limit: 1 };
    // Include multi-byte text and escaped quotes/newlines in the complete serialized size.
    const prefix = kind === "status" ? "界合成" : '界合成"\n';
    const baseBytes = Buffer.byteLength(JSON.stringify(build(prefix)));
    for (const bytes of [maximum, 100_000]) {
      const output = build(prefix + "x".repeat(bytes - baseBytes));
      assert.equal(Buffer.byteLength(JSON.stringify(output)), bytes);
      if (kind === "fetch") fixture.reads.fetchInventoryItem = async () => customGptFetchOutputSchema.parse(output);
      else if (kind === "search") fixture.reads.searchInventory = async () => customGptSearchOutputSchema.parse(output);
      else fixture.reads.getCommandStatus = async () => customGptCommandStatusOutputSchema.parse(output);
      const response = await fixture.post(path, input);
      const text = await response.text();
      if (bytes === maximum) {
        assert.equal(response.status, 200);
        assert.equal(Buffer.byteLength(text), maximum);
        assert.deepEqual(JSON.parse(text), output);
      } else {
        assert.equal(response.status, 422);
        assert.deepEqual(JSON.parse(text), { error: { code: "RESPONSE_TOO_LARGE", message:
          "The complete read response exceeds the 99999-byte UTF-8 JSON limit. No result was returned or truncated. This does not establish the outcome of any earlier write. Do not automatically retry the same request or write." } });
        assert.doesNotMatch(text, /界|succeeded|product_id|inventory_item|xxx/);
      }
      assert.deepEqual(fixture.snapshot(), before);
    }
  });
}

test("OpenAPI documents complete wire-byte limits and a read-only capacity error code", () => {
  assert.equal(customGptMaximumPayloadBytes, maximum);
  const paths = beautioActionsOpenApiV1.paths;
  for (const path of [createPath, uploadPath] as const) {
    assert.match(paths[path].post.requestBody.description, /99999 UTF-8 bytes/);
    assert.match(paths[path].post.requestBody.description, /before command registration/);
  }
  for (const operation of [paths["/api/actions/inventory/search"].post, paths["/api/actions/inventory/fetch"].post, paths["/api/actions/commands/status"].post]) {
    assert.match(JSON.stringify(operation.responses["200"]), /99999 UTF-8 JSON bytes/);
    assert.match(JSON.stringify(operation.responses.default), /RESPONSE_TOO_LARGE/);
  }
  assert.doesNotMatch(JSON.stringify(paths[createPath].post.responses.default), /RESPONSE_TOO_LARGE/);
});

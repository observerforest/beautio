import assert from "node:assert/strict";
import test from "node:test";
import { customGptCommandStatusOutputSchema, customGptFetchOutputSchema, customGptImageActionErrorSchema, customGptSetDisplayImageCommandOutputSchema, customGptUploadImagesCommandOutputSchema } from "@beautio/contracts";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ExclusiveOperationGate } from "../src/exclusive-operation-gate.ts";
import { abortableImageRequest, bindImageCommands, imageActionFixture, imageAdminToken, imageCodexToken, imageCommandId, imageUploadBody } from "./custom-gpt-image-commands-fixture.ts";

const uploadPath = "/api/actions/upload-product-images";
const displayPath = "/api/actions/products/product/display-image";

test("image routes enforce identity, mandatory command/version, strict input and unavailable dependencies", async (context) => {
  const f = await imageActionFixture(context);
  const disabled = await imageActionFixture(context, { enabled: false });
  const set = { command_id: imageCommandId(2), expected_revision: 1, image_asset_id: imageCommandId(100) };
  for (const [method, path, body] of [["POST", uploadPath, imageUploadBody()], ["PUT", displayPath, set]] as const) {
    for (const token of [null, imageCodexToken, imageAdminToken]) assert.equal((await f.request(method, path, body, token)).status, 401);
    assert.equal((await disabled.request(method, path, body)).status, 404);
    const { command_id: _id, ...withoutCommand } = body;
    assert.equal((await f.request(method, path, withoutCommand)).status, 400);
    assert.equal((await f.request(method, path + "?extra=true", body)).status, 400);
    assert.equal((await f.request(method, path, { ...body, unexpected: true })).status, 400);
    assert.equal((await f.request(method, path, body, undefined, "text/plain")).status, 400);
  }
  assert.equal((await f.request("PUT", displayPath, { command_id: imageCommandId(2), image_asset_id: imageCommandId(100) })).status, 400);
  assert.equal((await f.request("PUT", displayPath, { ...set, product_id: "product" })).status, 400);
  assert.equal((await f.request("POST", uploadPath, imageUploadBody(1, 11))).status, 400);
  assert.equal((await f.request("POST", uploadPath, { ...imageUploadBody(), padding: "x".repeat(1024 * 1024) })).status, 413);
  assert.equal((await f.request("PUT", displayPath, { ...set, padding: "x".repeat(64 * 1024) })).status, 413);
  assert.equal(f.downloads(), 0); assert.equal(disabled.downloads(), 0);
  assert.equal(f.database.prepare("SELECT count(*) n FROM command_executions").get()!.n, 0);
});

test("ten-image receipt supports URL refresh replay, stable payload conflict, status and expected-image fetch", async (context) => {
  const f = await imageActionFixture(context);
  const response = await f.request("POST", uploadPath, imageUploadBody(1, 10)); assert.equal(response.status, 200);
  const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 8192);
  assert.doesNotMatch(text, /synthetic|signature|source_ref|storage_key|download_link/u);
  const uploaded = customGptUploadImagesCommandOutputSchema.parse(JSON.parse(text)); assert.equal(uploaded.status, "succeeded");
  assert.equal(uploaded.result.image_asset_ids.length, 10);
  const refreshed = imageUploadBody(1, 10); for (const ref of refreshed.openaiFileIdRefs) ref.download_link = "https://files.example.test/refreshed";
  const replay = await f.request("POST", uploadPath, refreshed); assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), uploaded); assert.equal(f.downloads(), 1);
  refreshed.openaiFileIdRefs[0]!.name = "changed.png";
  const conflict = await f.request("POST", uploadPath, refreshed); assert.equal(conflict.status, 409);
  assert.equal(customGptImageActionErrorSchema.parse(await conflict.json()).error.code, "COMMAND_PAYLOAD_CONFLICT");
  const statusResponse = await f.request("POST", "/api/actions/commands/status", { operation_id: "upload_product_images", command_id: imageCommandId(1) });
  assert.deepEqual(customGptCommandStatusOutputSchema.parse(await statusResponse.json()).result, uploaded.result);
  const current = await f.repository.findVersionedInventoryItem("bottle"); assert.ok(current?.product);
  const setBody = { command_id: imageCommandId(2), expected_revision: current.product.revision, image_asset_id: uploaded.result.image_asset_ids[0] };
  const setResponse = await f.request("PUT", displayPath, setBody); assert.equal(setResponse.status, 200);
  const set = customGptSetDisplayImageCommandOutputSchema.parse(await setResponse.json()); assert.equal(set.status, "succeeded");
  const fetchedResponse = await f.request("POST", "/api/actions/inventory/fetch", { inventory_item_id: "bottle", expected_image_asset_id: uploaded.result.image_asset_ids[0] });
  const fetched = customGptFetchOutputSchema.parse(await fetchedResponse.json());
  assert.equal(fetched.display_image_matches_expected, true); assert.equal(fetched.inventory_item.product?.revision, set.result.revision);
  assert.deepEqual(await (await f.request("PUT", displayPath, setBody)).json(), set);
  const stale = customGptSetDisplayImageCommandOutputSchema.parse(await (await f.request("PUT", displayPath, { ...setBody, command_id: imageCommandId(3), image_asset_id: uploaded.result.image_asset_ids[1] })).json());
  assert.equal(stale.failure_code, "REVISION_CONFLICT");
});

test("strict post-commit HTTP projection hides extra fields while status retains the valid receipt", async (context) => {
  const f = await imageActionFixture(context, { createCommands: (service) => bindImageCommands(service, {
    async executePreparedUpload(prepared) { return { ...(await service.executePreparedUpload(prepared)), private_transport: "synthetic hidden value" }; },
  }) });
  const response = await f.request("POST", uploadPath, imageUploadBody()); assert.equal(response.status, 500);
  const text = await response.text(); assert.doesNotMatch(text, /private_transport|synthetic hidden/u); assert.match(text, /unknown/u);
  const status = customGptCommandStatusOutputSchema.parse(await (await f.request("POST", "/api/actions/commands/status", { operation_id: "upload_product_images", command_id: imageCommandId(1) })).json());
  assert.equal(status.status, "succeeded"); assert.equal(status.result?.outcome, "uploaded");
  assert.equal((await f.request("POST", uploadPath, imageUploadBody())).status, 200); assert.equal(f.downloads(), 1);
});

test("display-image queue saturation returns 503 before claiming or changing a Product", { timeout: 10_000 }, async (context) => {
  const gate = new ExclusiveOperationGate({ maximumQueueLength: 1 });
  const originalRun = ExclusiveOperationGate.prototype.run;
  context.mock.method(ExclusiveOperationGate.prototype, "run", function<T>(operation: () => Promise<T>, signal?: AbortSignal) { return originalRun.call(gate, operation, signal) as Promise<T>; });
  const held = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
  const holder = originalRun.call(gate, async () => { entered.resolve(); await held.promise; });
  const prepared = Promise.withResolvers<void>();
  const f = await imageActionFixture(context, { createCommands: (service) => bindImageCommands(service, {
    prepareSetDisplayImage(productId, input) { const handle = service.prepareSetDisplayImage(productId, input); prepared.resolve(); return handle; },
  }) });
  const firstBody = { command_id: imageCommandId(1), expected_revision: 1, image_asset_id: imageCommandId(100) };
  try {
    await entered.promise;
    const queued = f.request("PUT", displayPath, firstBody); await prepared.promise; await nextTurn();
    const rejected = await f.request("PUT", displayPath, { ...firstBody, command_id: imageCommandId(2) }); assert.equal(rejected.status, 503);
    assert.equal(customGptImageActionErrorSchema.parse(await rejected.json()).error.code, "COMMAND_STORE_BUSY");
    assert.equal((await f.commands.find({ operationId: "set_product_display_image", commandId: imageCommandId(2) })), null);
    assert.equal((await f.repository.findProductById("product"))?.imageAssetId, null);
    held.resolve(); await holder; assert.equal((await queued).status, 200);
  } finally { held.resolve(); await holder; }
});

test("disconnect after claim but before the final gate leaves unknown and discards prepared images", { timeout: 10_000 }, async (context) => {
  const loading = Promise.withResolvers<void>(); const loadRelease = Promise.withResolvers<void>();
  const prepared = Promise.withResolvers<void>(); let executions = 0;
  const f = await imageActionFixture(context, { createLoader: (bytes) => async (refs) => { loading.resolve(); await loadRelease.promise; return refs.map((ref) => ({ source_ref: ref.id, bytes })); }, createCommands: (service) => bindImageCommands(service, {
    async prepareOwnedUpload(...args) { const handle = await service.prepareOwnedUpload(...args); prepared.resolve(); return handle; },
    async executePreparedUpload(handle) { executions++; return service.executePreparedUpload(handle); },
  }) });
  const serverObservedClose = Promise.withResolvers<void>();
  f.server.once("request", (_request, response) => { response.once("close", () => serverObservedClose.resolve()); });
  const cancelled = abortableImageRequest(f.origin + uploadPath, imageUploadBody()); await loading.promise;
  const adminEntered = Promise.withResolvers<void>(); const adminRelease = Promise.withResolvers<void>();
  const original = f.application.createInventoryBatch.bind(f.application);
  f.application.createInventoryBatch = async (body) => { adminEntered.resolve(); await adminRelease.promise; return original(body); };
  const admin = f.request("POST", "/api/admin/create-inventory-batch", { as_of: "2026-09-05", products: [{ batch_ref: "other", name: "Synthetic other" }], inventory_items: [{ batch_ref: "b", product_ref: { kind: "new", batch_ref: "other" }, lifecycle_status: "unopened" }] }, imageAdminToken);
  try {
    await adminEntered.promise; loadRelease.resolve(); await prepared.promise; await nextTurn();
    cancelled.request.destroy(); await cancelled.closed; await serverObservedClose.promise;
    assert.equal(executions, 0);
    adminRelease.resolve(); assert.equal((await admin).status, 200); await nextTurn();
    assert.equal(executions, 0); assert.equal((await f.commands.find({ operationId: "upload_product_images", commandId: imageCommandId(1) }))?.status, "in_progress");
    assert.equal(f.database.prepare("SELECT count(*) n FROM image_assets").get()!.n, 0);
    const replay = await f.request("POST", uploadPath, imageUploadBody()); assert.equal(replay.status, 200);
    assert.equal(customGptUploadImagesCommandOutputSchema.parse(await replay.json()).status, "in_progress"); assert.equal(f.downloads(), 1);
  } finally { loadRelease.resolve(); adminRelease.resolve(); cancelled.request.destroy(); }
});

test("disconnect after final gate entry cannot cancel the single upload effect", { timeout: 10_000 }, async (context) => {
  const entered = Promise.withResolvers<void>(); const released = Promise.withResolvers<void>(); const completed = Promise.withResolvers<void>();
  const f = await imageActionFixture(context, { createCommands: (service) => bindImageCommands(service, {
    async executePreparedUpload(handle) { entered.resolve(); await released.promise; try { return await service.executePreparedUpload(handle); } finally { completed.resolve(); } },
  }) });
  const client = abortableImageRequest(f.origin + uploadPath, imageUploadBody());
  try {
    await entered.promise; client.request.destroy(); await client.closed; await nextTurn();
    assert.equal(f.database.prepare("SELECT count(*) n FROM image_assets").get()!.n, 0);
    released.resolve(); await completed.promise; await nextTurn();
    const status = await f.commands.find({ operationId: "upload_product_images", commandId: imageCommandId(1) }); assert.equal(status?.status, "succeeded");
    assert.equal(f.database.prepare("SELECT count(*) n FROM image_assets WHERE status='temporary'").get()!.n, 1);
    const replay = await f.request("POST", uploadPath, imageUploadBody()); assert.equal(replay.status, 200); assert.equal(f.downloads(), 1);
  } finally { released.resolve(); client.request.destroy(); }
});

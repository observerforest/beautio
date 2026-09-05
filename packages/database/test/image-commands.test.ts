import assert from "node:assert/strict";
import test from "node:test";
import { BeautioError } from "@beautio/domain";
import { CommandExecutionService, CustomGptImageCommandService, type ImageCommandStorage } from "@beautio/application";
import type { DatabaseSync } from "node:sqlite";
import { SqliteInventoryRepository } from "../src/index.ts";
import { finalizeImageUploadCommandRecord } from "../src/image-upload-command-records.ts";
import { executeSetDisplayImageCommandRecord } from "../src/set-display-image-command-records.ts";
import { clock, imageFixture, imageState, runUpload, uploadBody, uuid } from "./image-command-fixtures.ts";

test("upload publishes all ten exact files and complete durable IDs with independent status/reopen", async (context) => {
  const f = await imageFixture(context);
  const output = await runUpload(f.service, uploadBody(1, 10));
  assert.equal(output.status, "succeeded"); assert.ok(output.result);
  assert.equal(output.result.image_asset_ids.length, 10);
  assert.equal(Buffer.byteLength(String(f.database.prepare("SELECT result_json FROM command_executions").get()!.result_json)), 472);
  for (const [index, id] of output.result.image_asset_ids.entries()) {
    const asset = await f.repository.findImageAssetById(id); assert.ok(asset);
    assert.equal(asset.status, "temporary"); assert.equal(asset.expiresAt, output.result.expires_at);
    assert.deepEqual(await f.storage.get(asset.storageKey), Buffer.from([1, index, 3]));
  }
  assert.deepEqual((await f.reads.getCommandStatus({ operation_id: "upload_product_images", command_id: uuid(1) })).result, output.result);
  let downloads = 0;
  assert.deepEqual(await runUpload(f.service, { ...uploadBody(1, 10), openaiFileIdRefs: uploadBody(1, 10).openaiFileIdRefs.map((ref) => ({ ...ref, download_link: "https://files.example.invalid/refreshed" })) }, () => downloads++), output);
  assert.equal(downloads, 0); assert.equal(f.generated(), 20);
  const raw = String(f.database.prepare("SELECT result_json FROM command_executions").get()!.result_json);
  for (const secret of ["signature", "synthetic", "source_ref", "storage_key", "mime_type"]) assert.equal(raw.includes(secret), false);
  const reopened = new SqliteInventoryRepository(f.databasePath); context.after(() => reopened.close());
  assert.deepEqual((await new CommandExecutionService(reopened, clock).find({ operationId: "upload_product_images", commandId: uuid(1) }))?.result, output.result);
});

test("upload command identity binds stable fields and admits one winner across connections", async (context) => {
  const f = await imageFixture(context);
  const second = new SqliteInventoryRepository(f.databasePath); context.after(() => second.close());
  const service = new CustomGptImageCommandService(second, new CommandExecutionService(second, clock), f.application, f.storage, { clock, idGenerator: () => { throw new Error("loser must not generate"); } });
  const owner = await f.service.claimPreparedUpload(f.service.prepareUpload(uploadBody())); assert.equal(owner.outcome, "owned");
  const replay = await service.claimPreparedUpload(service.prepareUpload(uploadBody())); assert.equal(replay.outcome, "replayed");
  if (replay.outcome === "replayed") assert.equal(replay.output.status, "in_progress");
  for (const field of ["id", "name", "mime_type"] as const) {
    const body = uploadBody(); body.openaiFileIdRefs[0]![field] += "-changed";
    await assert.rejects(f.service.claimPreparedUpload(f.service.prepareUpload(body)), { code: "COMMAND_PAYLOAD_CONFLICT" });
  }
  await assert.rejects(f.service.claimPreparedUpload(f.service.prepareUpload({ ...uploadBody(), openaiFileIdRefs: uploadBody().openaiFileIdRefs.reverse() })), { code: "COMMAND_PAYLOAD_CONFLICT" });
  assert.equal(f.generated(), 0);
});

test("only pure image rejection settles failed; download cancellation and unknown faults stay in progress", async (context) => {
  for (const code of ["INVALID_INPUT", "UPLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "UPLOAD_FAILED", "unknown", "cancel"] as const) await context.test(code, async (t) => {
    const f = await imageFixture(t);
    const owner = await f.service.claimPreparedUpload(f.service.prepareUpload(uploadBody())); assert.equal(owner.outcome, "owned"); if (owner.outcome !== "owned") return;
    const controller = new AbortController();
    const task = f.service.prepareOwnedUpload(owner.ownership, async () => {
      if (code === "cancel") controller.abort();
      if (code === "unknown" || code === "cancel") throw new Error("synthetic fault");
      throw new BeautioError(code, "synthetic rejection");
    }, { signal: controller.signal });
    if (["INVALID_INPUT", "UPLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE"].includes(code)) {
      const output = await f.service.executePreparedUpload(await task); assert.equal(output.status, "failed");
      assert.equal((await runUpload(f.service, uploadBody())).status, "failed");
    } else {
      await assert.rejects(task, { code: "COMMAND_STORE_FAILURE" });
      assert.equal((await runUpload(f.service, uploadBody())).status, "in_progress");
    }
    assert.equal(f.generated(), 0); assert.equal(f.database.prepare("SELECT count(*) n FROM image_assets").get()!.n, 0);
  });
});

test("file failures compensate only owned files and never falsely settle failed", async (context) => {
  for (const phase of ["foreign-collision", "write", "verify", "abandon", "delete", "close", "ids"] as const) await context.test(phase, async (t) => {
    const f = await imageFixture(t);
    if (phase === "foreign-collision") await f.storage.put(uuid(101), Buffer.from([9]));
    let written = 0;
    const files: ImageCommandStorage = {
      reserve: f.storage.reserve.bind(f.storage),
      async writeReserved(handle, bytes) { if (++written === 2 && ["write", "abandon", "delete"].includes(phase)) throw new Error("synthetic write fault"); await f.storage.writeReserved(handle, bytes); },
      async verifyReserved(handle, bytes) { if (phase === "verify") throw new Error("synthetic readback fault"); await f.storage.verifyReserved(handle, bytes); },
      async discardReserved(handle) { if (phase === "delete") throw new Error("synthetic deletion fault"); await f.storage.discardReserved(handle); },
      async releaseReserved(handle) { await f.storage.releaseReserved(handle); if (phase === "close") throw new Error("synthetic close response fault"); },
    };
    const service = f.makeService(phase === "abandon" ? { async abandonImageUploadCommand() { throw new Error("synthetic marking fault"); } } : {}, files,
      phase === "ids" ? { idGenerator: () => "invalid" } : {});
    await assert.rejects(runUpload(service, uploadBody()), { code: "COMMAND_STORE_FAILURE" });
    const command = await f.commands.find({ operationId: "upload_product_images", commandId: uuid(1) });
    assert.equal(command?.status, phase === "close" ? "succeeded" : "in_progress");
    if (phase === "foreign-collision") { assert.deepEqual(await f.storage.get(uuid(101)), Buffer.from([9])); assert.equal(f.database.prepare("SELECT count(*) n FROM image_assets").get()!.n, 0); }
    if (phase === "write" || phase === "verify") assert.deepEqual(await f.storage.listKeys(), []);
    if (phase === "abandon") assert.ok(f.database.prepare("SELECT count(*) n FROM image_assets WHERE status='staging'").get()!.n);
    if (phase === "delete") assert.ok(f.database.prepare("SELECT count(*) n FROM image_assets WHERE status='pending_cleanup'").get()!.n);
    const count = f.generated(); await runUpload(service, uploadBody()); assert.equal(f.generated(), count);
  });
});

test("upload activation, success CAS and raw-readback faults never publish partial receipts", async (context) => {
  for (const fault of ["activate-abort", "activate-raw", "cas-abort", "cas-ignore", "cas-result", "cas-asset"] as const) await context.test(fault, async (t) => {
    const f = await imageFixture(t);
    const statement = fault === "activate-abort" ? "CREATE TRIGGER fault BEFORE UPDATE OF status ON image_assets WHEN NEW.status='temporary' BEGIN SELECT RAISE(ABORT, 'synthetic'); END"
      : fault === "activate-raw" ? "CREATE TRIGGER fault AFTER UPDATE OF status ON image_assets WHEN NEW.status='temporary' BEGIN UPDATE image_assets SET created_at='2000-01-01T00:00:00.000Z' WHERE id=NEW.id; END"
      : fault === "cas-abort" ? "CREATE TRIGGER fault BEFORE UPDATE OF status ON command_executions WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT, 'synthetic'); END"
      : fault === "cas-ignore" ? "CREATE TRIGGER fault BEFORE UPDATE OF status ON command_executions WHEN NEW.status='succeeded' BEGIN SELECT RAISE(IGNORE); END"
      : fault === "cas-result" ? "CREATE TRIGGER fault AFTER UPDATE OF status ON command_executions WHEN NEW.status='succeeded' BEGIN UPDATE command_executions SET result_json='{}' WHERE command_id=NEW.command_id; END"
      : "CREATE TRIGGER fault AFTER UPDATE OF status ON command_executions WHEN NEW.status='succeeded' BEGIN UPDATE image_assets SET storage_key=storage_key || 'x'; END";
    f.database.exec(statement);
    await assert.rejects(runUpload(f.service, uploadBody()), { code: "COMMAND_STORE_FAILURE" });
    assert.equal((await f.commands.find({ operationId: "upload_product_images", commandId: uuid(1) }))?.status, "in_progress");
    assert.equal(f.database.prepare("SELECT count(*) n FROM image_assets WHERE status='temporary'").get()!.n, 0);
    assert.equal(f.database.prepare("SELECT count(*) n FROM image_assets WHERE status='staging'").get()!.n, 2);
    assert.equal((await f.storage.listKeys()).length, 2, "uncertain finalization must not delete files");
  });
});

test("upload COMMIT faults keep activation and IDs together, including lost success response", async (context) => {
  for (const committed of [false, true]) await context.test(String(committed), async (t) => {
    const f = await imageFixture(t);
    const proxy = new Proxy(f.database, { get(target, property) {
      if (property === "exec") return (sql: string) => { if (sql === "COMMIT") { if (committed) target.exec(sql); throw new Error("synthetic commit response fault"); } return target.exec(sql); };
      const value: unknown = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) as DatabaseSync;
    const service = f.makeService({ async finalizeImageUploadCommand(input) { return finalizeImageUploadCommandRecord(proxy, input); } });
    await assert.rejects(runUpload(service, uploadBody()), { code: "COMMAND_STORE_FAILURE" });
    const status = await f.commands.find({ operationId: "upload_product_images", commandId: uuid(1) });
    assert.equal(status?.status, committed ? "succeeded" : "in_progress");
    assert.equal(f.database.prepare("SELECT count(*) n FROM image_assets WHERE status='temporary'").get()!.n, committed ? 2 : 0);
    assert.equal((await f.storage.listKeys()).length, 2);
    if (committed) assert.deepEqual((await runUpload(service, uploadBody())).result, status?.result);
  });
});

test("expiry and cleanup competition cannot reactivate pending assets or recreate deleted files", async (context) => {
  for (const fault of ["expired-clock", "pending", "deleted-file"] as const) await context.test(fault, async (t) => {
    const f = await imageFixture(t);
    const service = f.makeService({ async finalizeImageUploadCommand(input) {
      if (fault !== "expired-clock") await f.repository.claimExpiredImageAssets("2026-09-07T00:00:00.000Z");
      if (fault === "deleted-file") for (const asset of input.assets) await f.storage.delete(asset.storageKey);
      return f.repository.finalizeImageUploadCommand({ ...input, completionClock: fault === "expired-clock" ? () => "2026-09-07T00:00:00.000Z" as ReturnType<typeof input.completionClock> : input.completionClock });
    } });
    await assert.rejects(runUpload(service, uploadBody()), { code: "COMMAND_STORE_FAILURE" });
    assert.equal(f.database.prepare("SELECT count(*) n FROM image_assets WHERE status='temporary'").get()!.n, 0);
    assert.equal((await f.commands.find({ operationId: "upload_product_images", commandId: uuid(1) }))?.status, "in_progress");
  });
});

test("display-image commands enforce revision, preserve raw facts and provide independent match readback", async (context) => {
  const f = await imageFixture(context);
  const uploaded = await runUpload(f.service, uploadBody()); assert.ok(uploaded.result);
  const [first, second] = uploaded.result.image_asset_ids; assert.ok(first && second);
  const before = await f.repository.findVersionedInventoryItem("bottle"); assert.ok(before?.product);
  const initial = imageState(f.database);
  const execute = (command: number, image: string, revision: number) => f.service.executePreparedSetDisplayImage(f.service.prepareSetDisplayImage("product", { command_id: uuid(command), image_asset_id: image, expected_revision: revision }));
  const firstOutput = await execute(2, first, before.product.revision); assert.equal(firstOutput.status, "succeeded"); assert.ok(firstOutput.result);
  assert.equal((await f.reads.fetchInventoryItem({ inventory_item_id: "bottle", expected_image_asset_id: first })).display_image_matches_expected, true);
  assert.deepEqual(imageState(f.database).items, initial.items);
  assert.equal((await f.repository.findProductById("product"))?.imageRef, "legacy-sample.webp");
  const same = await execute(3, first, firstOutput.result.revision); assert.equal(same.result?.revision, firstOutput.result.revision);
  const stale = await execute(4, second, before.product.revision); assert.equal(stale.failure_code, "REVISION_CONFLICT");
  const changed = await execute(5, second, firstOutput.result.revision); assert.equal(changed.status, "succeeded");
  assert.equal((await f.repository.findImageAssetById(first))?.status, "temporary");
  assert.equal((await f.repository.findImageAssetById(first))?.productId, null);
  assert.equal((await f.reads.fetchInventoryItem({ inventory_item_id: "bottle", expected_image_asset_id: second })).display_image_matches_expected, true);
  assert.deepEqual(await execute(5, second, firstOutput.result.revision), changed);
});

test("display-image raw facts, ownership, receipt and COMMIT failures all roll back", async (context) => {
  for (const fault of ["raw-brand", "ownership", "cas-abort", "cas-result", "cas-image", "commit-before", "commit-after"] as const) await context.test(fault, async (t) => {
    const f = await imageFixture(t);
    const uploaded = await runUpload(f.service, uploadBody()); assert.ok(uploaded.result);
    const current = await f.repository.findVersionedInventoryItem("bottle"); assert.ok(current?.product);
    const before = imageState(f.database);
    if (fault === "raw-brand") f.database.exec("CREATE TRIGGER fault AFTER UPDATE OF image_asset_id ON products BEGIN UPDATE products SET brand=' ' || brand || ' ' WHERE id=NEW.id; END");
    if (fault === "ownership") f.database.exec("CREATE TRIGGER fault AFTER UPDATE OF image_asset_id ON products BEGIN UPDATE image_assets SET status='temporary',product_id=NULL WHERE id=NEW.image_asset_id; END");
    if (fault === "cas-abort") f.database.exec("CREATE TRIGGER fault BEFORE UPDATE OF status ON command_executions WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    if (fault === "cas-result") f.database.exec("CREATE TRIGGER fault AFTER UPDATE OF status ON command_executions WHEN NEW.status='succeeded' BEGIN UPDATE command_executions SET result_json='{}' WHERE command_id=NEW.command_id; END");
    if (fault === "cas-image") f.database.exec("CREATE TRIGGER fault AFTER UPDATE OF status ON command_executions WHEN NEW.status='succeeded' BEGIN UPDATE products SET image_asset_id=NULL; END");
    const proxy = new Proxy(f.database, { get(target, property) {
      if (property === "exec") return (sql: string) => { if (sql === "COMMIT") { if (fault === "commit-after") target.exec(sql); throw new Error("synthetic commit fault"); } return target.exec(sql); };
      const value: unknown = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) as DatabaseSync;
    const service = fault.startsWith("commit-") ? f.makeService({ async executeSetDisplayImageCommand(input) { return executeSetDisplayImageCommandRecord(proxy, input); } }) : f.service;
    await assert.rejects(service.executePreparedSetDisplayImage(service.prepareSetDisplayImage("product", { command_id: uuid(2), image_asset_id: uploaded.result.image_asset_ids[0], expected_revision: current.product.revision })), { code: "COMMAND_STORE_FAILURE" });
    const status = await f.commands.find({ operationId: "set_product_display_image", commandId: uuid(2) });
    assert.equal(status?.status, fault === "commit-after" ? "succeeded" : "in_progress");
    if (fault !== "commit-after") assert.deepEqual(imageState(f.database), before);
  });
});

test("staging failures never write image bytes and rollback leaves no active metadata", async (context) => {
  for (const fault of ["insert-abort", "raw-change", "stage-response", "clock", "duplicate-id"] as const) await context.test(fault, async (t) => {
    const f = await imageFixture(t);
    if (fault === "insert-abort") f.database.exec("CREATE TRIGGER fault BEFORE INSERT ON image_assets BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    if (fault === "raw-change") f.database.exec("CREATE TRIGGER fault AFTER INSERT ON image_assets BEGIN UPDATE image_assets SET byte_size=100 WHERE id=NEW.id; END");
    let writes = 0;
    const files: ImageCommandStorage = {
      reserve: f.storage.reserve.bind(f.storage), writeReserved: async () => { writes++; throw new Error("unexpected image bytes"); },
      verifyReserved: f.storage.verifyReserved.bind(f.storage), discardReserved: f.storage.discardReserved.bind(f.storage), releaseReserved: f.storage.releaseReserved.bind(f.storage),
    };
    const service = f.makeService(fault === "stage-response" ? { async stageImageUploadCommand(input) { await f.repository.stageImageUploadCommand(input); throw new Error("synthetic stage response failure"); } } : {}, files,
      fault === "clock" ? { clock: () => new Date(NaN) } : fault === "duplicate-id" ? { idGenerator: () => uuid(100) } : {});
    await assert.rejects(runUpload(service, uploadBody()), { code: "COMMAND_STORE_FAILURE" });
    assert.equal(writes, 0); assert.deepEqual(await f.storage.listKeys(), []);
    assert.equal(f.database.prepare("SELECT count(*) n FROM image_assets").get()!.n, 0);
    assert.equal((await f.commands.find({ operationId: "upload_product_images", commandId: uuid(1) }))?.status, "in_progress");
  });
});

test("display-image preflight rejections preserve all rows and replay without a second effect", async (context) => {
  for (const fault of ["missing-product", "missing-image", "expired", "pending", "other-owner", "bad-old-owner"] as const) await context.test(fault, async (t) => {
    const f = await imageFixture(t);
    const uploaded = await runUpload(f.service, uploadBody()); assert.ok(uploaded.result);
    const selected = uploaded.result.image_asset_ids[0]!;
    if (fault === "expired") f.database.prepare("UPDATE image_assets SET expires_at=? WHERE id=?").run(clock().toISOString(), selected);
    if (fault === "pending") f.database.prepare("UPDATE image_assets SET status='pending_cleanup' WHERE id=?").run(selected);
    if (fault === "other-owner") {
      f.database.exec("INSERT INTO products(id,name) VALUES('other','Synthetic');");
      f.database.prepare("UPDATE image_assets SET status='linked',product_id='other' WHERE id=?").run(selected);
    }
    if (fault === "bad-old-owner") f.database.prepare("UPDATE products SET image_asset_id=? WHERE id='product'").run(uploaded.result.image_asset_ids[1]!);
    const current = await f.repository.findVersionedInventoryItem("bottle"); assert.ok(current?.product);
    const before = imageState(f.database);
    let effects = 0;
    const service = f.makeService({ async executeSetDisplayImageCommand(input) { effects++; return f.repository.executeSetDisplayImageCommand(input); } });
    const run = () => service.executePreparedSetDisplayImage(service.prepareSetDisplayImage(fault === "missing-product" ? "missing" : "product", { command_id: uuid(2), expected_revision: current.product!.revision, image_asset_id: fault === "missing-image" ? "missing" : selected }));
    const output = await run(); assert.equal(output.status, "failed");
    assert.deepEqual(await run(), output); assert.equal(effects, 1);
    assert.deepEqual(imageState(f.database), before);
  });
});

test("different image commands racing on one revision have only one winner", async (context) => {
  const f = await imageFixture(context);
  const uploaded = await runUpload(f.service, uploadBody()); assert.ok(uploaded.result);
  const current = await f.repository.findVersionedInventoryItem("bottle"); assert.ok(current?.product);
  const second = new SqliteInventoryRepository(f.databasePath); context.after(() => second.close());
  const service = new CustomGptImageCommandService(second, new CommandExecutionService(second, clock), f.application, f.storage, { clock });
  const outputs = await Promise.all([f.service, service].map((candidate, index) => candidate.executePreparedSetDisplayImage(candidate.prepareSetDisplayImage("product", { command_id: uuid(index + 2), expected_revision: current.product!.revision, image_asset_id: uploaded.result!.image_asset_ids[index] }))));
  assert.equal(outputs.filter((output) => output.status === "succeeded").length, 1);
  assert.equal(outputs.filter((output) => output.failure_code === "REVISION_CONFLICT").length, 1);
});

test("image ownership handles are single-use and discarding queued work releases shared semantic capacity", async (context) => {
  const f = await imageFixture(context);
  const owner = await f.service.claimPreparedUpload(f.service.prepareUpload(uploadBody())); assert.equal(owner.outcome, "owned"); if (owner.outcome !== "owned") return;
  const second = f.makeService();
  const loader = async () => [{ source_ref: "file-0", bytes: Uint8Array.from([1]) }, { source_ref: "file-1", bytes: Uint8Array.from([2]) }];
  await assert.rejects(second.prepareOwnedUpload(owner.ownership, loader), { code: "INVALID_INPUT" });
  const prepared = await f.service.prepareOwnedUpload(owner.ownership, loader);
  await assert.rejects(f.service.prepareOwnedUpload(owner.ownership, loader), { code: "INVALID_INPUT" });
  assert.throws(() => second.discardPreparedUpload(prepared), { code: "INVALID_INPUT" });
  f.service.discardPreparedUpload(prepared); f.service.discardPreparedUpload(prepared);
  await assert.rejects(f.service.executePreparedUpload(prepared), { code: "INVALID_INPUT" });
  assert.equal((await f.commands.find({ operationId: "upload_product_images", commandId: uuid(1) }))?.status, "in_progress");
  const handles = [];
  for (let i = 0; i < 17; i++) handles.push(await f.application.prepareProductImages([{ source_ref: `capacity-${i}`, bytes: Uint8Array.from([1]) }]));
  for (const handle of handles) f.application.discardPreparedProductImages(handle);
  assert.equal(f.generated(), 0);
});

test("staging and abandonment triggers cannot independently forge a terminal upload receipt", async (context) => {
  for (const phase of ["stage", "abandon"] as const) await context.test(phase, async (t) => {
    const f = await imageFixture(t);
    const receipt = JSON.stringify({ outcome: "uploaded", image_asset_ids: [uuid(100), uuid(102)], expires_at: "2026-09-06T00:00:00.000Z" });
    const event = phase === "stage" ? "AFTER INSERT ON image_assets" : "AFTER UPDATE OF status ON image_assets WHEN NEW.status='pending_cleanup'";
    f.database.exec(`CREATE TRIGGER fault ${event} BEGIN UPDATE command_executions SET status='succeeded', completed_at='2026-09-05T00:00:00.000Z', result_json='${receipt}' WHERE operation_id='upload_product_images'; END`);
    const files: ImageCommandStorage = {
      reserve: f.storage.reserve.bind(f.storage),
      async writeReserved() { throw new Error("synthetic write fault before activation"); },
      verifyReserved: f.storage.verifyReserved.bind(f.storage), discardReserved: f.storage.discardReserved.bind(f.storage), releaseReserved: f.storage.releaseReserved.bind(f.storage),
    };
    const service = f.makeService({}, files);
    await assert.rejects(runUpload(service, uploadBody()), { code: "COMMAND_STORE_FAILURE" });
    assert.equal((await f.commands.find({ operationId: "upload_product_images", commandId: uuid(1) }))?.status, "in_progress");
    assert.equal(f.database.prepare("SELECT count(*) n FROM image_assets").get()!.n, phase === "stage" ? 0 : 2);
    assert.equal(f.database.prepare("SELECT count(*) n FROM image_assets WHERE status='pending_cleanup'").get()!.n, 0);
    assert.equal((await runUpload(service, uploadBody())).status, "in_progress");
  });
});

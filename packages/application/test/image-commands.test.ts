import assert from "node:assert/strict";
import test from "node:test";
import { commandIdSchema } from "@beautio/contracts";
import { parseNullableIsoInstant } from "@beautio/domain";
import { CustomGptImageCommandService, type ClaimCommandExecutionResult, type ImageCommandPreparation, type ImageCommandRepository, type ImageCommandStorage, type PreparedImageUploadCommand, type PreparedSetDisplayImageCommand } from "../src/index.ts";
import { prepareImageUploadCommandValue, prepareSetDisplayImageCommandValue } from "../src/image-command-preparation.ts";
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const body = () => ({ command_id: uuid(1), openaiFileIdRefs: [{ id: "file-1", name: "synthetic.png", mime_type: "image/png", download_link: "https://files.example.invalid/synthetic?signature=temporary" }] });
const unexpected = async (): Promise<never> => { throw new Error("unexpected side effect"); };
const repository: ImageCommandRepository = { stageImageUploadCommand: unexpected, finalizeImageUploadCommand: unexpected, abandonImageUploadCommand: unexpected, deleteClaimedImageAsset: unexpected, executeSetDisplayImageCommand: unexpected };
const preparation: ImageCommandPreparation = { prepareProductImages: unexpected, consumePreparedProductImages() { throw new Error("unexpected consumption"); }, discardPreparedProductImages() { throw new Error("unexpected release"); } };
const storage: ImageCommandStorage = { reserve: unexpected, writeReserved: unexpected, verifyReserved: unexpected, discardReserved: unexpected, releaseReserved: unexpected };

test("image preparation snapshots stable identity and target while excluding temporary transport URLs", () => {
  const input = body();
  const prepared = prepareImageUploadCommandValue(input);
  input.openaiFileIdRefs[0]!.name = "mutated";
  assert.equal(prepared.references[0]!.name, "synthetic.png");
  assert.ok(Object.isFrozen(prepared.references)); assert.ok(Object.isFrozen(prepared.references[0]));
  const renewed = body(); renewed.openaiFileIdRefs[0]!.download_link = "https://files.example.invalid/renewed";
  assert.equal(prepareImageUploadCommandValue(renewed).payload.sha256, prepared.payload.sha256);
  for (const key of ["name", "id", "mime_type"] as const) {
    const changed = body(); changed.openaiFileIdRefs[0]![key] += "-changed";
    assert.notEqual(prepareImageUploadCommandValue(changed).payload.sha256, prepared.payload.sha256);
  }
  const set = { command_id: uuid(2), expected_revision: 1, image_asset_id: uuid(100) };
  const original = prepareSetDisplayImageCommandValue("product", set);
  for (const changed of [{ ...set, expected_revision: 2 }, { ...set, image_asset_id: uuid(101) }]) assert.notEqual(prepareSetDisplayImageCommandValue("product", changed).payload.sha256, original.payload.sha256);
  assert.notEqual(prepareSetDisplayImageCommandValue("other", set).payload.sha256, original.payload.sha256);
  assert.throws(() => prepareSetDisplayImageCommandValue("x".repeat(5000), set), { code: "COMMAND_RESULT_TOO_LARGE" });
});

test("all image replay states avoid preparation, generation and persistence and consume only their own handles", async () => {
  const createdAt = parseNullableIsoInstant("2026-09-05T00:00:00.000Z", "timestamp"); assert.ok(createdAt);
  for (const operationId of ["upload_product_images", "set_product_display_image"] as const) {
    for (const status of ["in_progress", "succeeded", "failed"] as const) {
      let claims = 0;
      const result: ClaimCommandExecutionResult = { outcome: status, execution: {
        operationId, commandId: commandIdSchema.parse(uuid(1)), status, createdAt,
        completedAt: status === "in_progress" ? null : createdAt,
        result: status !== "succeeded" ? null : operationId === "upload_product_images" ? { outcome: "uploaded", image_asset_ids: [uuid(100)], expires_at: "2026-09-06T00:00:00.000Z" } : { outcome: "updated", product_id: "product", revision: 1 },
        failure: status === "failed" ? { code: "INVALID_INPUT", message: "Invalid." } : null,
      } };
      const commands = { async claim() { claims++; return result; }, completeKnownFailure: unexpected };
      const service = new CustomGptImageCommandService(repository, commands, preparation, storage, { clock() { throw new Error("unexpected clock"); }, idGenerator() { throw new Error("unexpected generator"); } });
      const other = new CustomGptImageCommandService(repository, commands, preparation, storage);
      if (operationId === "upload_product_images") {
        const handle = service.prepareUpload(body()); assert.equal(claims, 0); assert.deepEqual(Object.keys(handle), []);
        await assert.rejects(other.claimPreparedUpload(handle), { code: "INVALID_INPUT" });
        await assert.rejects(service.claimPreparedUpload({} as PreparedImageUploadCommand), { code: "INVALID_INPUT" });
        const replay = await service.claimPreparedUpload(handle); assert.equal(replay.outcome, "replayed");
        if (replay.outcome === "replayed") assert.equal(replay.output.status, status);
        await assert.rejects(service.claimPreparedUpload(handle), { code: "INVALID_INPUT" });
      } else {
        const handle = service.prepareSetDisplayImage("product", { command_id: uuid(1), expected_revision: 1, image_asset_id: uuid(100) });
        await assert.rejects(other.executePreparedSetDisplayImage(handle), { code: "INVALID_INPUT" });
        await assert.rejects(service.executePreparedSetDisplayImage({} as PreparedSetDisplayImageCommand), { code: "INVALID_INPUT" });
        assert.equal((await service.executePreparedSetDisplayImage(handle)).status, status);
        await assert.rejects(service.executePreparedSetDisplayImage(handle), { code: "INVALID_INPUT" });
      }
      assert.equal(claims, 1);
    }
  }
});

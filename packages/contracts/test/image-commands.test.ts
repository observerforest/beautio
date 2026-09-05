import assert from "node:assert/strict";
import test from "node:test";
import { customGptUploadImagesCommandInputSchema, customGptSetDisplayImageCommandInputSchema, customGptUploadImagesCommandOutputSchema, parseCustomGptCommandSuccessResult, uploadImagesCommandSuccessResultSchema } from "../src/index.ts";
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const reference = { name: "synthetic.png", id: "file-1", mime_type: "image/png", download_link: "https://files.example.invalid/synthetic" };
test("image command contracts require identity, version and strict bounded file references", () => {
  assert.equal(customGptUploadImagesCommandInputSchema.safeParse({ openaiFileIdRefs: [reference] }).success, false);
  assert.equal(customGptUploadImagesCommandInputSchema.safeParse({ command_id: uuid(1), openaiFileIdRefs: [reference, reference] }).success, false);
  assert.equal(customGptUploadImagesCommandInputSchema.safeParse({ command_id: uuid(1), openaiFileIdRefs: Array.from({ length: 10 }, (_, i) => ({ ...reference, id: `file-${i}` })) }).success, true);
  assert.equal(customGptUploadImagesCommandInputSchema.safeParse({ command_id: uuid(1), openaiFileIdRefs: Array.from({ length: 11 }, (_, i) => ({ ...reference, id: `file-${i}` })) }).success, false);
  assert.equal(customGptSetDisplayImageCommandInputSchema.safeParse({ command_id: uuid(1), image_asset_id: uuid(2) }).success, false);
  assert.equal(customGptSetDisplayImageCommandInputSchema.safeParse({ command_id: uuid(1), expected_revision: 1, image_asset_id: uuid(2), product_id: "unexpected" }).success, false);
});
test("all ten temporary identities fit the frozen 472-byte receipt and strict status projection", () => {
  const result = uploadImagesCommandSuccessResultSchema.parse({ outcome: "uploaded", image_asset_ids: Array.from({ length: 10 }, (_, i) => uuid(i)), expires_at: "9999-12-31T23:59:59.999Z" });
  assert.equal(Buffer.byteLength(JSON.stringify(result)), 472);
  const response = customGptUploadImagesCommandOutputSchema.parse({ operation_id: "upload_product_images", command_id: uuid(1), status: "succeeded", created_at: result.expires_at, completed_at: result.expires_at, failure_code: null, result });
  assert.equal(Buffer.byteLength(JSON.stringify(response)), 697);
  assert.deepEqual(parseCustomGptCommandSuccessResult("upload_product_images", result), result);
  assert.equal(parseCustomGptCommandSuccessResult("upload_product_images", { ...result, download_link: "private" }), null);
  assert.equal(parseCustomGptCommandSuccessResult("upload_product_images", { assets: [{ image_asset_id: uuid(1) }] }), null);
  assert.equal(parseCustomGptCommandSuccessResult("create_inventory_batch", result), null);
  assert.equal(parseCustomGptCommandSuccessResult("set_product_display_image", { product_id: "product", revision: 1, outcome: "updated", image_asset_id: uuid(1) }), null);
});

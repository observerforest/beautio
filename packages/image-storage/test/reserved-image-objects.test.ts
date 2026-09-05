import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { FileImageAssetStorage, type ReservedImageObject } from "../src/index.ts";
async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "beautio-owned-images-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, storage: new FileImageAssetStorage(directory) };
}
test("reserved images remain empty until written, preserve exact bytes and retire once", async (context) => {
  const { storage, directory } = await fixture(context);
  const handle = await storage.reserve("synthetic");
  assert.equal((await stat(join(directory, "synthetic"))).size, 0);
  const bytes = Uint8Array.from([1, 2, 3]);
  await storage.writeReserved(handle, bytes);
  await storage.verifyReserved(handle, bytes);
  await assert.rejects(storage.writeReserved(handle, bytes));
  await assert.rejects(storage.verifyReserved(handle, Uint8Array.from([1, 2, 4])));
  await storage.releaseReserved(handle);
  await storage.releaseReserved(handle);
  await assert.rejects(storage.verifyReserved(handle, bytes));
  assert.deepEqual(await storage.get("synthetic"), Buffer.from(bytes));
});
test("exclusive reservations reject existing paths and forged or other-instance capabilities", async (context) => {
  const { storage, directory } = await fixture(context);
  await storage.put("foreign", Uint8Array.from([9]));
  await assert.rejects(storage.reserve("foreign"));
  assert.deepEqual(await storage.get("foreign"), Buffer.from([9]));
  const handle = await storage.reserve("owned");
  await assert.rejects(new FileImageAssetStorage(directory).discardReserved(handle));
  await assert.rejects(storage.discardReserved({ kind: "reserved_image_object" }));
  await storage.discardReserved(handle); await storage.discardReserved(handle); await storage.releaseReserved(handle);
});
test("replacement identities cannot be written or deleted by an old reservation", async (context) => {
  const { storage, directory } = await fixture(context);
  const handle = await storage.reserve("owned");
  await rename(join(directory, "owned"), join(directory, "saved-original"));
  await writeFile(join(directory, "owned"), Uint8Array.from([7]));
  await assert.rejects(storage.writeReserved(handle, Uint8Array.from([1])));
  await assert.rejects(storage.discardReserved(handle));
  await storage.releaseReserved(handle);
  assert.deepEqual(await readFile(join(directory, "owned")), Buffer.from([7]));
});
test("the ten-descriptor bound is held until actual release", async (context) => {
  const { storage } = await fixture(context);
  const handles: ReservedImageObject[] = [];
  for (let i = 0; i < 10; i++) handles.push(await storage.reserve(`owned-${i}`));
  await assert.rejects(storage.reserve("over-capacity"));
  await storage.releaseReserved(handles[0]!);
  const next = await storage.reserve("replacement-slot");
  await Promise.all([...handles.slice(1), next].map((handle) => storage.releaseReserved(handle)));
});
test("stat failure followed by close failure conservatively retains all ten descriptor slots", async (context) => {
  const { storage, directory } = await fixture(context);
  const probe = await open(join(directory, "probe"), "wx+");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const closes: Array<() => Promise<void>> = [];
  context.mock.method(prototype, "stat", async function (this: FileHandle) {
    closes.push(this.close.bind(this));
    this.close = async () => { throw new Error("synthetic close failure"); };
    throw new Error("synthetic stat failure");
  });
  try {
    for (let i = 0; i < 11; i++) await assert.rejects(storage.reserve(`failed-${i}`));
    assert.equal(closes.length, 10, "the eleventh attempt must not open another descriptor");
  } finally {
    context.mock.restoreAll();
    await Promise.all(closes.map((close) => close()));
  }
});

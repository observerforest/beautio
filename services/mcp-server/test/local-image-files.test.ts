import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BeautioError } from "@beautio/domain";
import { readMcpImageFiles } from "../src/local-image-files.ts";

test("MCP file adapter strips an allowed absolute path after reading bytes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "beautio-mcp-root-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "confirmed.png");
  await writeFile(path, Uint8Array.from([1, 2, 3]));

  const result = await readMcpImageFiles(
    [{ client_ref: "image_1", file_path: path }],
    root,
  );

  assert.deepEqual(result.map((entry) => ({
    source_ref: entry.source_ref,
    bytes: Array.from(entry.bytes),
  })), [{ source_ref: "image_1", bytes: [1, 2, 3] }]);
  assert.equal(JSON.stringify(result).includes(path), false);
});

test("MCP file adapter rejects outside, relative, URI, directory, and symlink sources", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "beautio-mcp-boundary-"));
  const root = join(parent, "root");
  await mkdir(root);
  context.after(async () => rm(parent, { recursive: true, force: true }));
  const outside = join(parent, "outside.png");
  await writeFile(outside, Uint8Array.from([1]));
  const linked = join(root, "linked.png");
  await symlink(outside, linked);

  for (const file_path of [
    outside,
    "relative.png",
    `file://${outside}`,
    root,
    linked,
  ]) {
    await assert.rejects(
      readMcpImageFiles([{ client_ref: "image_1", file_path }], root),
      hasCode("FILE_SOURCE_REJECTED"),
    );
  }
});

test("MCP file adapter rejects a file over 20 MiB before reading it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "beautio-mcp-size-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "too-large.png");
  await writeFile(path, new Uint8Array());
  await truncate(path, 20 * 1024 * 1024 + 1);

  await assert.rejects(
    readMcpImageFiles([{ client_ref: "image_1", file_path: path }], root),
    hasCode("UPLOAD_TOO_LARGE"),
  );
});

function hasCode(code: BeautioError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof BeautioError);
    assert.equal(error.code, code);
    return true;
  };
}

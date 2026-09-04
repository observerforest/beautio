import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "../../..");

test("HTTP startup rejects equal bearer identities before opening SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-http-startup-"));
  const databasePath = join(directory, "must-not-exist.sqlite");
  const imageStorageRoot = join(directory, "managed-images");

  try {
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, "services/core-api/src/http.ts")],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          BEAUTIO_DB_PATH: databasePath,
          BEAUTIO_IMAGE_STORAGE_ROOT: imageStorageRoot,
          BEAUTIO_CUSTOM_GPT_BEARER_TOKEN: "duplicate-token",
          BEAUTIO_ACTION_BEARER_TOKEN: "duplicate-token",
          BEAUTIO_ADMIN_BEARER_TOKEN: "different-admin-token",
          BEAUTIO_ACTION_FILE_HOST_ALLOWLIST: "files.example.test",
        },
        timeout: 5_000,
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bearer tokens must be different/);
    assert.equal(existsSync(databasePath), false);
    assert.equal(existsSync(imageStorageRoot), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

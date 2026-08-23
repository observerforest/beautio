import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createInventoryBatchOutputSchema,
  getInventoryItemOutputSchema,
  recordProductOpenedOutputSchema,
  uploadProductImagesOutputSchema,
} from "@beautio/contracts";
import { InventoryApplicationService } from "@beautio/application";
import { createInventoryItem } from "@beautio/domain";
import { SqliteInventoryRepository } from "@beautio/database";
import { FileImageAssetStorage } from "@beautio/image-storage";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import {
  createBeautioMcpServer,
  createInventoryBatchDescription,
  createInventoryBatchToolName,
  getInventoryItemDescription,
  getInventoryItemToolName,
  recordProductOpenedDescription,
  recordProductOpenedToolName,
  uploadProductImagesDescription,
  uploadProductImagesToolName,
} from "../src/index.ts";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(testDirectory, "../src/stdio.ts");
const repositoryRoot = join(testDirectory, "../../..");
const VALID_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000000970485973000003e8000003e801b57b526b0000001249444154789c63b8be72e7f5953b192014003ec208e5aef475850000000049454e44ae426082",
  "hex",
);

test("stdio MCP preserves old tools and completes upload-create-read-reopen", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-mcp-"));
  const databasePath = join(directory, "inventory.sqlite");
  const uploadRoot = join(directory, "confirmed-inputs");
  const storageRoot = join(directory, "managed-images");
  await mkdir(uploadRoot);
  const imagePath = join(uploadRoot, "confirmed.png");
  await writeFile(imagePath, VALID_PNG);
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const seedRepository = new SqliteInventoryRepository(databasePath);
  await seedRepository.seedInventoryItem(
    createInventoryItem({
      id: "mcp-night-queen",
      lifecycleStatus: "unopened",
      expiresOn: "2028-01-01",
      paoDurationMonths: 12,
    }),
  );
  await seedRepository.seedInventoryItem(
    createInventoryItem({
      id: "mcp-finished-item",
      lifecycleStatus: "finished",
    }),
  );
  seedRepository.close();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: repositoryRoot,
    env: {
      ...getDefaultEnvironment(),
      BEAUTIO_DB_PATH: databasePath,
      BEAUTIO_MCP_UPLOAD_ROOT: uploadRoot,
      BEAUTIO_IMAGE_STORAGE_ROOT: storageRoot,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "beautio-e2e", version: "0.2.0" });
  let createdInventoryItemId = "";
  let createdProductId = "";
  let imageAssetId = "";

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        createInventoryBatchToolName,
        getInventoryItemToolName,
        recordProductOpenedToolName,
        uploadProductImagesToolName,
      ].sort(),
    );
    const descriptions = new Map(
      tools.map((tool) => [tool.name, tool.description]),
    );
    assert.equal(
      descriptions.get(recordProductOpenedToolName),
      recordProductOpenedDescription,
    );
    assert.equal(
      descriptions.get(getInventoryItemToolName),
      getInventoryItemDescription,
    );
    assert.equal(
      descriptions.get(uploadProductImagesToolName),
      uploadProductImagesDescription,
    );
    assert.equal(
      descriptions.get(createInventoryBatchToolName),
      createInventoryBatchDescription,
    );
    assert.match(createInventoryBatchDescription, /ingredient_list_text/);
    assert.match(createInventoryBatchDescription, /ask the user before calling/i);
    assert.match(getInventoryItemDescription, /shared Product ingredient text/i);
    for (const name of [uploadProductImagesToolName, createInventoryBatchToolName]) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool);
      assert.equal(tool.annotations?.readOnlyHint, false);
      assert.equal(tool.annotations?.idempotentHint, false);
      assert.equal(tool.annotations?.openWorldHint, false);
      assert.ok(tool.inputSchema);
      assert.ok(tool.outputSchema);
    }

    const legacyWrite = await client.callTool({
      name: recordProductOpenedToolName,
      arguments: {
        inventory_item_id: "mcp-night-queen",
        opened_on: "2026-08-18",
      },
    });
    const opened = recordProductOpenedOutputSchema.parse(
      legacyWrite.structuredContent,
    );
    assert.equal(opened.outcome, "opened");
    assert.equal(opened.opened_on_accuracy, "legacy_unknown");
    assert.equal(opened.pao_deadline_accuracy, "legacy_unknown");

    const uploadResult = await client.callTool({
      name: uploadProductImagesToolName,
      arguments: {
        images: [{ client_ref: "front_image", file_path: imagePath }],
      },
    });
    assert.equal(uploadResult.isError, undefined);
    const upload = uploadProductImagesOutputSchema.parse(
      uploadResult.structuredContent,
    );
    assert.equal(upload.assets[0]?.source_ref, "front_image");
    imageAssetId = upload.assets[0]?.image_asset_id ?? "";
    assert.ok(imageAssetId.length > 0);
    assert.equal(JSON.stringify(upload).includes(imagePath), false);

    const createResult = await client.callTool({
      name: createInventoryBatchToolName,
      arguments: {
        as_of: "2026-08-19",
        products: [
          {
            batch_ref: "product_1",
            name: "Confirmed cream",
            category: null,
            size_label: null,
            image_asset_id: imageAssetId,
            ingredient_list_text: "  Aqua,\nGlycerin  ",
            shared_notes: "  Shared Product note  ",
          },
        ],
        inventory_items: [
          {
            batch_ref: "bottle_1",
            product_ref: { kind: "new", batch_ref: "product_1" },
            lifecycle_status: "opened",
            opened_on: "2026-08-01",
            opened_on_accuracy: "estimated",
            expires_on: "2027-12-31",
            pao_duration_months: 6,
            custom_notes: "  First bottle note  ",
          },
          {
            batch_ref: "bottle_2",
            product_ref: { kind: "new", batch_ref: "product_1" },
            lifecycle_status: "unopened",
            custom_notes: "Second bottle note",
          },
        ],
      },
    });
    assert.equal(createResult.isError, undefined);
    const created = createInventoryBatchOutputSchema.parse(
      createResult.structuredContent,
    );
    assert.equal(created.products[0]?.image_asset_id, imageAssetId);
    assert.equal(created.products[0]?.ingredient_list_text, "Aqua,\nGlycerin");
    assert.equal(created.products[0]?.shared_notes, "Shared Product note");
    assert.equal(created.inventory_items.length, 2);
    assert.deepEqual(
      created.inventory_items.map((item) => item.custom_notes),
      ["First bottle note", "Second bottle note"],
    );
    assert.notEqual(
      created.inventory_items[0]?.inventory_item_id,
      created.inventory_items[1]?.inventory_item_id,
    );
    assert.equal(
      created.inventory_items[0]?.opened_on_accuracy,
      "estimated",
    );
    createdInventoryItemId = created.inventory_items[0]?.inventory_item_id ?? "";
    createdProductId = created.products[0]?.product_id ?? "";

    const readResult = await client.callTool({
      name: getInventoryItemToolName,
      arguments: {
        inventory_item_id: createdInventoryItemId,
        as_of: "2026-08-19",
      },
    });
    const readback = getInventoryItemOutputSchema.parse(
      readResult.structuredContent,
    );
    assert.equal(readback.opened_on_accuracy, "estimated");
    assert.equal(readback.pao_deadline_accuracy, "estimated");
    assert.equal(readback.custom_notes, "First bottle note");
    assert.equal(readback.product?.ingredient_list_text, "Aqua,\nGlycerin");
    assert.equal(readback.product?.shared_notes, "Shared Product note");

    const outsidePath = join(directory, "outside.png");
    await writeFile(outsidePath, VALID_PNG);
    const rejectedPath = await client.callTool({
      name: uploadProductImagesToolName,
      arguments: {
        images: [{ client_ref: "outside", file_path: outsidePath }],
      },
    });
    assert.equal(rejectedPath.isError, true);
    assert.equal(
      (rejectedPath.structuredContent as { readonly code?: string })?.code,
      "FILE_SOURCE_REJECTED",
    );
    assert.equal(extractText(rejectedPath).includes(outsidePath), false);

    const conflict = await client.callTool({
      name: createInventoryBatchToolName,
      arguments: {
        as_of: "2026-08-19",
        products: [],
        inventory_items: [
          {
            batch_ref: "missing",
            product_ref: { kind: "existing", product_id: "not-there" },
            lifecycle_status: "unopened",
          },
        ],
      },
    });
    assert.equal(conflict.isError, true);
    assert.equal(
      (conflict.structuredContent as { readonly code?: string })?.code,
      "PRODUCT_NOT_FOUND",
    );
  } finally {
    await client.close();
  }

  const reopened = new SqliteInventoryRepository(databasePath);
  assert.equal((await reopened.findById(createdInventoryItemId))?.openedOnAccuracy, "estimated");
  assert.equal((await reopened.findProductById(createdProductId))?.imageAssetId, imageAssetId);
  assert.equal(
    (await reopened.findProductById(createdProductId))?.ingredientListText,
    "Aqua,\nGlycerin",
  );
  assert.equal(
    (await reopened.findProductById(createdProductId))?.sharedNotes,
    "Shared Product note",
  );
  assert.equal(
    (await reopened.findById(createdInventoryItemId))?.customNotes,
    "First bottle note",
  );
  const asset = await reopened.findImageAssetById(imageAssetId);
  assert.equal(asset?.status, "linked");
  assert.equal(asset?.productId, createdProductId);
  assert.equal((await reopened.findAll()).length, 4);
  reopened.close();

  assert.deepEqual(
    Array.from(await new FileImageAssetStorage(storageRoot).get(asset?.storageKey ?? "")),
    Array.from(VALID_PNG),
  );
});

test("MCP converts unknown failures to safe INTERNAL_ERROR content", async () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const application = new InventoryApplicationService(repository);
  application.getInventoryItem = async () => {
    throw new Error(
      "db failed at /Users/private/db.sqlite token=SECRET",
    );
  };
  const server = createBeautioMcpServer(application, { uploadRoot: "/tmp" });
  const client = new Client({ name: "unknown-error-audit", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: getInventoryItemToolName,
      arguments: { inventory_item_id: "x", as_of: "2026-08-19" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed.",
    });
    assert.equal(JSON.stringify(result).includes("/Users/private"), false);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
  } finally {
    await client.close();
    await server.close();
    repository.close();
  }
});

function extractText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = result.content[0];
  assert.ok(first !== undefined && first.type === "text");
  return first.text;
}

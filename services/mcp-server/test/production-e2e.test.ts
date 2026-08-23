import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InventoryApplicationService } from "@beautio/application";
import {
  createInventoryBatchOutputSchema,
  getInventoryItemOutputSchema,
  setProductDisplayImageOutputSchema,
  uploadProductImagesOutputSchema,
} from "@beautio/contracts";
import { createCoreApiHandler } from "@beautio/core-api";
import { SqliteInventoryRepository } from "@beautio/database";
import {
  FileImageAssetStorage,
  sharpImageInspector,
} from "@beautio/image-storage";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createInventoryBatchToolName,
  getInventoryItemToolName,
  recordProductOpenedToolName,
  uploadProductImagesToolName,
} from "../src/index.ts";
import {
  createProductionBeautioMcpServer,
  setProductDisplayImageToolName,
} from "../src/production-server.ts";
import { createRemoteBeautioClient } from "../src/remote-client.ts";

const ACTION_TOKEN = "production-e2e-action-token";
const ADMIN_TOKEN = "production-e2e-admin-token";
const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("production MCP writes through Core API and Admin re-reads one remote state", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-production-e2e-"));
  const uploadRoot = join(directory, "confirmed-inputs");
  const storageRoot = join(directory, "remote-managed-images");
  const databasePath = join(directory, "remote.sqlite");
  const tokenPath = join(directory, "action-token");
  const imagePath = join(uploadRoot, "confirmed.png");
  await mkdir(uploadRoot);
  await writeFile(imagePath, TEST_PNG);
  await writeFile(tokenPath, `${ACTION_TOKEN}\n`, { mode: 0o600 });

  const repository = new SqliteInventoryRepository(databasePath);
  let nextId = 0;
  const application = new InventoryApplicationService(repository, {
    idGenerator: (kind) => `${kind}-production-e2e-${++nextId}`,
    clock: () => new Date("2026-08-20T00:00:00.000Z"),
    imageStorage: new FileImageAssetStorage(storageRoot),
    imageInspector: sharpImageInspector,
  });
  const httpServer = createServer(
    createCoreApiHandler(application, {
      actionBearerToken: ACTION_TOKEN,
      adminBearerToken: ADMIN_TOKEN,
      actionFileHosts: new Set(["files.example.test"]),
    }),
  );
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address() as AddressInfo;
  const fixtureOrigin = `http://127.0.0.1:${address.port}`;

  context.after(async () => {
    await closeServer(httpServer);
    repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  const remoteClient = await createRemoteBeautioClient({
    origin: "https://beautio.example",
    tokenFilePath: tokenPath,
    fetchImplementation: async (input, init) => {
      const logicalUrl = toUrl(input);
      assert.equal(logicalUrl.origin, "https://beautio.example");
      return fetch(
        `${fixtureOrigin}${logicalUrl.pathname}${logicalUrl.search}`,
        init,
      );
    },
  });
  const mcpServer = createProductionBeautioMcpServer(remoteClient, {
    uploadRoot,
  });
  const mcpClient = new Client({
    name: "beautio-production-e2e",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  context.after(async () => {
    await mcpClient.close();
    await mcpServer.close();
  });

  const uploadResult = await mcpClient.callTool({
    name: uploadProductImagesToolName,
    arguments: {
      images: [{ client_ref: "confirmed_display", file_path: imagePath }],
    },
  });
  assert.equal(uploadResult.isError, undefined);
  const uploaded = uploadProductImagesOutputSchema.parse(
    uploadResult.structuredContent,
  );
  const imageAssetId = uploaded.assets[0]?.image_asset_id;
  assert.ok(imageAssetId !== undefined);

  const createResult = await mcpClient.callTool({
    name: createInventoryBatchToolName,
    arguments: {
      as_of: "2026-08-20",
      products: [
        {
          batch_ref: "shared_product",
          name: "Remote shared Product",
          category: "serum",
          size_label: "30 ml",
          image_asset_id: null,
          ingredient_list_text: "  Aqua,\nGlycerin  ",
          shared_notes: "  Shared remote note  ",
        },
      ],
      inventory_items: [
        {
          batch_ref: "remote_bottle_1",
          product_ref: { kind: "new", batch_ref: "shared_product" },
          lifecycle_status: "unopened",
          custom_notes: "  First remote bottle  ",
        },
        {
          batch_ref: "remote_bottle_2",
          product_ref: { kind: "new", batch_ref: "shared_product" },
          lifecycle_status: "unopened",
          custom_notes: "Second remote bottle",
        },
      ],
    },
  });
  assert.equal(createResult.isError, undefined);
  const created = createInventoryBatchOutputSchema.parse(
    createResult.structuredContent,
  );
  const productId = created.products[0]?.product_id;
  const firstInventoryItemId = created.inventory_items[0]?.inventory_item_id;
  assert.ok(productId !== undefined);
  assert.ok(firstInventoryItemId !== undefined);
  assert.equal(created.products[0]?.ingredient_list_text, "Aqua,\nGlycerin");
  assert.equal(created.products[0]?.shared_notes, "Shared remote note");
  assert.deepEqual(
    created.inventory_items.map((item) => item.custom_notes),
    ["First remote bottle", "Second remote bottle"],
  );

  const setResult = await mcpClient.callTool({
    name: setProductDisplayImageToolName,
    arguments: { product_id: productId, image_asset_id: imageAssetId },
  });
  assert.equal(setResult.isError, undefined);
  assert.equal(
    setProductDisplayImageOutputSchema.parse(setResult.structuredContent)
      .product.image_asset_id,
    imageAssetId,
  );

  const readResult = await mcpClient.callTool({
    name: getInventoryItemToolName,
    arguments: {
      inventory_item_id: firstInventoryItemId,
      as_of: "2026-08-20",
    },
  });
  assert.equal(readResult.isError, undefined);
  assert.equal(
    getInventoryItemOutputSchema.parse(readResult.structuredContent)
      .lifecycle_status,
    "unopened",
  );
  const readback = getInventoryItemOutputSchema.parse(
    readResult.structuredContent,
  );
  assert.equal(readback.custom_notes, "First remote bottle");
  assert.equal(readback.product?.ingredient_list_text, "Aqua,\nGlycerin");
  assert.equal(readback.product?.shared_notes, "Shared remote note");

  const openedResult = await mcpClient.callTool({
    name: recordProductOpenedToolName,
    arguments: {
      inventory_item_id: firstInventoryItemId,
      opened_on: "2026-08-20",
    },
  });
  assert.equal(openedResult.isError, undefined);

  const inventoryResponse = await fetch(
    `${fixtureOrigin}/api/inventory?as_of=2026-08-20`,
    { headers: authorization(ADMIN_TOKEN) },
  );
  assert.equal(inventoryResponse.status, 200);
  const inventory = (await inventoryResponse.json()) as {
    readonly items: ReadonlyArray<{
      readonly inventory_item_id: string;
      readonly lifecycle_status: string;
      readonly custom_notes: string | null;
      readonly product: {
        readonly product_id: string;
        readonly name: string;
        readonly image_asset_id: string | null;
        readonly ingredient_list_text: string | null;
        readonly shared_notes: string | null;
      } | null;
    }>;
  };
  assert.equal(inventory.items.length, 2);
  assert.deepEqual(
    inventory.items.map((item) => item.product?.image_asset_id),
    [imageAssetId, imageAssetId],
  );
  assert.deepEqual(
    inventory.items.map((item) => item.product?.name),
    ["Remote shared Product", "Remote shared Product"],
  );
  assert.deepEqual(
    inventory.items.map((item) => item.product?.ingredient_list_text),
    ["Aqua,\nGlycerin", "Aqua,\nGlycerin"],
  );
  assert.deepEqual(
    inventory.items.map((item) => item.product?.shared_notes),
    ["Shared remote note", "Shared remote note"],
  );
  assert.deepEqual(
    inventory.items.map((item) => item.custom_notes),
    ["First remote bottle", "Second remote bottle"],
  );
  assert.equal(
    inventory.items.find(
      (item) => item.inventory_item_id === firstInventoryItemId,
    )?.lifecycle_status,
    "opened",
  );

  const privateImage = await fetch(
    `${fixtureOrigin}/api/image-assets/${encodeURIComponent(imageAssetId)}/content`,
    { headers: authorization(ADMIN_TOKEN) },
  );
  assert.equal(privateImage.status, 200);
  assert.deepEqual(
    Buffer.from(await privateImage.arrayBuffer()),
    TEST_PNG,
  );
  assert.deepEqual(await readdir(uploadRoot), ["confirmed.png"]);
});

function toUrl(input: string | URL | Request): URL {
  return input instanceof Request ? new URL(input.url) : new URL(input);
}

function authorization(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

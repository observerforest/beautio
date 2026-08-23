import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createInventoryBatchOutputSchema,
  getInventoryItemOutputSchema,
  inventoryStateOutputSchema,
  recordProductOpenedOutputSchema,
  setProductDisplayImageOutputSchema,
  uploadProductImagesOutputSchema,
} from "@beautio/contracts";
import { BeautioError } from "@beautio/domain";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createInventoryBatchDescription,
  createInventoryBatchToolName,
  getInventoryItemDescription,
  getInventoryItemToolName,
  recordProductOpenedDescription,
  recordProductOpenedToolName,
  uploadProductImagesDescription,
  uploadProductImagesToolName,
} from "../src/index.ts";
import {
  createProductionBeautioMcpServer,
  setProductDisplayImageDescription,
  setProductDisplayImageToolName,
  type ProductionBeautioOperations,
} from "../src/production-server.ts";
import type { McpImageBytes } from "../src/local-image-files.ts";

const INVENTORY_OUTPUT = inventoryStateOutputSchema.parse({
  inventory_item_id: "inventory-1",
  lifecycle_status: "unopened",
  opened_on: null,
  opened_on_accuracy: null,
  expires_on: null,
  pao_duration_months: null,
  pao_deadline: null,
  pao_deadline_accuracy: null,
  usable_until: null,
  usability_status: "unknown",
  warnings: ["pao_unknown"],
  custom_notes: null,
});

const GET_INVENTORY_OUTPUT = getInventoryItemOutputSchema.parse({
  ...INVENTORY_OUTPUT,
  product_id: null,
  product: null,
});

const OPENED_OUTPUT = recordProductOpenedOutputSchema.parse({
  ...INVENTORY_OUTPUT,
  outcome: "opened",
  lifecycle_status: "opened",
  opened_on: "2026-08-20",
  opened_on_accuracy: "exact",
});

const UPLOAD_OUTPUT = uploadProductImagesOutputSchema.parse({
  assets: [
    {
      source_ref: "front_image",
      image_asset_id: "asset-1",
      media_type: "image/jpeg",
      byte_size: 3,
      expires_at: "2026-08-21T00:00:00.000Z",
    },
  ],
});

const CREATE_OUTPUT = createInventoryBatchOutputSchema.parse({
  outcome: "created",
  as_of: "2026-08-20",
  products: [],
  inventory_items: [
    {
      ...INVENTORY_OUTPUT,
      inventory_item_id: "created-inventory-1",
      batch_ref: "bottle_1",
      product_id: "product-1",
    },
  ],
});

const SET_IMAGE_OUTPUT = setProductDisplayImageOutputSchema.parse({
  product: {
    product_id: "product-1",
    name: "Confirmed product",
    category: null,
    size_label: null,
    image_asset_id: "asset-1",
    image_ref: null,
    ingredient_list_text: null,
    shared_notes: null,
  },
});

test("production MCP exposes five remote-backed tools and strips local paths before upload", async (context) => {
  const uploadRoot = await mkdtemp(join(tmpdir(), "beautio-production-mcp-"));
  context.after(async () => rm(uploadRoot, { recursive: true, force: true }));
  const imagePath = join(uploadRoot, "confirmed.jpg");
  await writeFile(imagePath, Uint8Array.from([1, 2, 3]));

  let uploadedImages: readonly McpImageBytes[] = [];
  const operations: ProductionBeautioOperations = {
    recordProductOpened: async () => OPENED_OUTPUT,
    getInventoryItem: async () => GET_INVENTORY_OUTPUT,
    uploadProductImages: async (images) => {
      uploadedImages = images;
      return UPLOAD_OUTPUT;
    },
    createInventoryBatch: async () => CREATE_OUTPUT,
    setProductDisplayImage: async () => SET_IMAGE_OUTPUT,
  };
  const server = createProductionBeautioMcpServer(operations, { uploadRoot });
  const client = new Client({ name: "production-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        createInventoryBatchToolName,
        getInventoryItemToolName,
        recordProductOpenedToolName,
        setProductDisplayImageToolName,
        uploadProductImagesToolName,
      ].sort(),
    );
    assert.equal(
      tools.find((tool) => tool.name === setProductDisplayImageToolName)
        ?.description,
      setProductDisplayImageDescription,
    );
    assert.match(setProductDisplayImageDescription, /same Product changes together/);
    assert.match(createInventoryBatchDescription, /ingredient_list_text/);
    assert.match(createInventoryBatchDescription, /ask the user before calling/i);
    assert.match(getInventoryItemDescription, /shared Product ingredient text/i);
    const expectedMetadata = new Map([
      [
        recordProductOpenedToolName,
        {
          description: recordProductOpenedDescription,
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      ],
      [
        getInventoryItemToolName,
        {
          description: getInventoryItemDescription,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      ],
      [
        uploadProductImagesToolName,
        {
          description: uploadProductImagesDescription,
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      ],
      [
        createInventoryBatchToolName,
        {
          description: createInventoryBatchDescription,
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      ],
      [
        setProductDisplayImageToolName,
        {
          description: setProductDisplayImageDescription,
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        },
      ],
    ]);
    for (const tool of tools) {
      const expected = expectedMetadata.get(tool.name);
      assert.ok(expected);
      assert.equal(tool.description, expected.description);
      assert.equal(tool.annotations?.readOnlyHint, expected.readOnlyHint);
      assert.equal(tool.annotations?.destructiveHint, expected.destructiveHint);
      assert.equal(tool.annotations?.idempotentHint, expected.idempotentHint);
      assert.equal(tool.annotations?.openWorldHint, false);
      assert.ok(tool.inputSchema);
      assert.ok(tool.outputSchema);
    }

    const upload = await client.callTool({
      name: uploadProductImagesToolName,
      arguments: {
        images: [{ client_ref: "front_image", file_path: imagePath }],
      },
    });
    assert.equal(upload.isError, undefined);
    uploadProductImagesOutputSchema.parse(upload.structuredContent);
    assert.deepEqual(
      uploadedImages.map((image) => ({
        source_ref: image.source_ref,
        bytes: Array.from(image.bytes),
      })),
      [{ source_ref: "front_image", bytes: [1, 2, 3] }],
    );
    assert.equal(JSON.stringify(uploadedImages).includes(imagePath), false);

    const read = await client.callTool({
      name: getInventoryItemToolName,
      arguments: {
        inventory_item_id: "inventory-1",
        as_of: "2026-08-20",
      },
    });
    assert.equal(read.isError, undefined);
    assert.deepEqual(
      getInventoryItemOutputSchema.parse(read.structuredContent),
      GET_INVENTORY_OUTPUT,
    );

    const setImage = await client.callTool({
      name: setProductDisplayImageToolName,
      arguments: { product_id: "product-1", image_asset_id: "asset-1" },
    });
    assert.equal(setImage.isError, undefined);
    assert.equal(
      setProductDisplayImageOutputSchema.parse(setImage.structuredContent)
        .product.image_asset_id,
      "asset-1",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("production MCP hides unknown remote implementation details", async () => {
  const operations: ProductionBeautioOperations = {
    recordProductOpened: async () => {
      throw new BeautioError(
        "INVENTORY_ITEM_NOT_FOUND",
        "Inventory item was not found",
        "inventory-1",
      );
    },
    getInventoryItem: async () => {
      throw new Error("remote failed with token=SECRET at /private/data");
    },
    uploadProductImages: async () => UPLOAD_OUTPUT,
    createInventoryBatch: async () => CREATE_OUTPUT,
    setProductDisplayImage: async () => SET_IMAGE_OUTPUT,
  };
  const server = createProductionBeautioMcpServer(operations, {
    uploadRoot: "/tmp",
  });
  const client = new Client({ name: "production-mcp-error", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const businessError = await client.callTool({
      name: recordProductOpenedToolName,
      arguments: {
        inventory_item_id: "inventory-1",
        opened_on: "2026-08-20",
      },
    });
    assert.equal(businessError.isError, true);
    assert.deepEqual(businessError.structuredContent, {
      code: "INVENTORY_ITEM_NOT_FOUND",
      message: "Inventory item was not found",
      ref: "inventory-1",
    });

    const result = await client.callTool({
      name: getInventoryItemToolName,
      arguments: { inventory_item_id: "inventory-1", as_of: "2026-08-20" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed.",
    });
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.equal(JSON.stringify(result).includes("/private"), false);
  } finally {
    await client.close();
    await server.close();
  }
});

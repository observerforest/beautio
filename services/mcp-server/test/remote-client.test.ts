import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createInventoryBatchOutputSchema,
  type CreateInventoryBatchOutput,
} from "@beautio/contracts";
import { BeautioError } from "@beautio/domain";
import { createRemoteBeautioClient } from "../src/remote-client.ts";

const INVENTORY_STATE_OUTPUT = {
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
} as const;

const GET_INVENTORY_OUTPUT = {
  ...INVENTORY_STATE_OUTPUT,
  product_id: null,
  product: null,
} as const;

test("remote client requires a bare HTTPS origin and a 0600 non-symlink token file", async (context) => {
  const fixture = await tokenFixture(context);

  for (const origin of [
    "http://beautio.example",
    "https://user:password@beautio.example",
    "https://beautio.example/path",
    "https://beautio.example/?query=yes",
    "https://beautio.example/#fragment",
    "https://beautio.example:8443",
  ]) {
    await assert.rejects(
      createRemoteBeautioClient({ origin, tokenFilePath: fixture.tokenPath }),
      /bare HTTPS origin/,
    );
  }

  await createRemoteBeautioClient({
    origin: "https://beautio.example/",
    tokenFilePath: fixture.tokenPath,
  });

  await chmod(fixture.tokenPath, 0o644);
  await assert.rejects(
    createRemoteBeautioClient({
      origin: "https://beautio.example",
      tokenFilePath: fixture.tokenPath,
    }),
    /secure regular file/,
  );

  await chmod(fixture.tokenPath, 0o600);
  const symlinkPath = join(fixture.directory, "linked-token");
  await symlink(fixture.tokenPath, symlinkPath);
  await assert.rejects(
    createRemoteBeautioClient({
      origin: "https://beautio.example",
      tokenFilePath: symlinkPath,
    }),
    /secure regular file/,
  );
});

test("remote client calls each fixed Action route once with strict response validation", async (context) => {
  const fixture = await tokenFixture(context);
  const requests: Array<{ readonly path: string; readonly init: RequestInit }> = [];
  const client = await createRemoteBeautioClient({
    origin: "https://beautio.example",
    tokenFilePath: fixture.tokenPath,
    fetchImplementation: async (input, init = {}) => {
      const url = requestUrl(input);
      requests.push({ path: url.pathname, init });
      assert.equal(url.origin, "https://beautio.example");
      assert.equal(init.redirect, "error");
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer action-token-for-test",
      );
      switch (url.pathname) {
        case "/api/actions/codex/record-product-opened":
          return jsonResponse({
            ...INVENTORY_STATE_OUTPUT,
            outcome: "opened",
            lifecycle_status: "opened",
            opened_on: "2026-08-20",
            opened_on_accuracy: "exact",
          });
        case "/api/actions/codex/get-inventory-item":
          return jsonResponse(GET_INVENTORY_OUTPUT);
        case "/api/actions/codex/upload-product-images": {
          assert.ok(init.body instanceof FormData);
          assert.ok(init.body.get("front_image") instanceof Blob);
          return jsonResponse({
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
        }
        case "/api/actions/create-inventory-batch":
          return jsonResponse({
            outcome: "created",
            as_of: "2026-08-20",
            products: [],
            inventory_items: [
              {
                ...INVENTORY_STATE_OUTPUT,
                inventory_item_id: "created-inventory-1",
                batch_ref: "bottle_1",
                product_id: "product-1",
              },
            ],
          });
        case "/api/actions/codex/set-product-display-image":
          return jsonResponse({
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
        default:
          return jsonResponse(
            { error: { code: "INVALID_INPUT", message: "unexpected route" } },
            404,
          );
      }
    },
  });

  await client.recordProductOpened({
    inventory_item_id: "inventory-1",
    opened_on: "2026-08-20",
  });
  await client.getInventoryItem({
    inventory_item_id: "inventory-1",
    as_of: "2026-08-20",
  });
  await client.uploadProductImages([
    { source_ref: "front_image", bytes: Uint8Array.from([1, 2, 3]) },
  ]);
  await client.createInventoryBatch({
    as_of: "2026-08-20",
    products: [],
    inventory_items: [
      {
        batch_ref: "bottle_1",
        product_ref: { kind: "existing", product_id: "product-1" },
        lifecycle_status: "unopened",
      },
    ],
  });
  await client.setProductDisplayImage({
    product_id: "product-1",
    image_asset_id: "asset-1",
  });

  assert.deepEqual(
    requests.map((request) => request.path),
    [
      "/api/actions/codex/record-product-opened",
      "/api/actions/codex/get-inventory-item",
      "/api/actions/codex/upload-product-images",
      "/api/actions/create-inventory-batch",
      "/api/actions/codex/set-product-display-image",
    ],
  );
});

test("remote client rejects inventory responses that do not match the requested identity or opening date", async (context) => {
  const fixture = await tokenFixture(context);
  let getCalls = 0;
  const getClient = await createRemoteBeautioClient({
    origin: "https://beautio.example",
    tokenFilePath: fixture.tokenPath,
    fetchImplementation: async () => {
      getCalls += 1;
      return jsonResponse({
        ...GET_INVENTORY_OUTPUT,
        inventory_item_id: "different-inventory",
      });
    },
  });
  await assert.rejects(
    getClient.getInventoryItem({
      inventory_item_id: "inventory-1",
      as_of: "2026-08-20",
    }),
    hasBeautioError("INTERNAL_ERROR", "invalid response"),
  );
  assert.equal(getCalls, 1);

  for (const response of [
    openedOutput({ inventory_item_id: "different-inventory" }),
    openedOutput({ opened_on: "2026-08-19" }),
  ]) {
    let recordCalls = 0;
    const recordClient = await createRemoteBeautioClient({
      origin: "https://beautio.example",
      tokenFilePath: fixture.tokenPath,
      fetchImplementation: async () => {
        recordCalls += 1;
        return jsonResponse(response);
      },
    });
    await assert.rejects(
      recordClient.recordProductOpened({
        inventory_item_id: "inventory-1",
        opened_on: "2026-08-20",
      }),
      hasBeautioError("INTERNAL_ERROR", "invalid response"),
    );
    assert.equal(recordCalls, 1);
  }
});

test("remote client rejects upload responses with wrong count, references, order, or byte sizes", async (context) => {
  const fixture = await tokenFixture(context);
  const images = [
    { source_ref: "front_image", bytes: Uint8Array.from([1, 2, 3]) },
    { source_ref: "back_image", bytes: Uint8Array.from([4, 5]) },
  ];
  const front = imageAsset("front_image", "asset-front", 3);
  const back = imageAsset("back_image", "asset-back", 2);
  const cases: readonly { readonly name: string; readonly assets: unknown[] }[] = [
    { name: "count", assets: [front] },
    {
      name: "duplicate source_ref",
      assets: [front, imageAsset("front_image", "asset-back", 2)],
    },
    { name: "source_ref order", assets: [back, front] },
    {
      name: "byte_size",
      assets: [imageAsset("front_image", "asset-front", 4), back],
    },
    {
      name: "empty image_asset_id",
      assets: [imageAsset("front_image", " ", 3), back],
    },
    {
      name: "duplicate image_asset_id",
      assets: [
        imageAsset("front_image", "asset-shared", 3),
        imageAsset("back_image", "asset-shared", 2),
      ],
    },
  ];

  for (const testCase of cases) {
    let calls = 0;
    const client = await createRemoteBeautioClient({
      origin: "https://beautio.example",
      tokenFilePath: fixture.tokenPath,
      fetchImplementation: async () => {
        calls += 1;
        return jsonResponse({ assets: testCase.assets });
      },
    });
    await assert.rejects(
      client.uploadProductImages(images),
      hasBeautioError("INTERNAL_ERROR", "invalid response"),
      testCase.name,
    );
    assert.equal(calls, 1, testCase.name);
  }
});

test("remote client rejects create responses that are not correlated to batch order and Product mapping", async (context) => {
  const fixture = await tokenFixture(context);
  const input = {
    as_of: "2026-08-20",
    products: [
      {
        batch_ref: "new_a",
        name: "New A",
        ingredient_list_text: "  Aqua,\nGlycerin  ",
        shared_notes: "  shared A  ",
      },
      { batch_ref: "new_b", name: "New B" },
    ],
    inventory_items: [
      {
        batch_ref: "existing_bottle",
        product_ref: { kind: "existing", product_id: "existing-product" },
        lifecycle_status: "unopened",
        custom_notes: "  existing bottle note  ",
      },
      {
        batch_ref: "new_a_bottle",
        product_ref: { kind: "new", batch_ref: "new_a" },
        lifecycle_status: "unopened",
        custom_notes: "  new A bottle note  ",
      },
      {
        batch_ref: "new_b_bottle",
        product_ref: { kind: "new", batch_ref: "new_b" },
        lifecycle_status: "unopened",
      },
    ],
  } as const;
  const valid = validCreateOutput();
  const cases: readonly { readonly name: string; readonly response: unknown }[] = [
    { name: "as_of", response: { ...valid, as_of: "2026-08-19" } },
    {
      name: "product count",
      response: { ...valid, products: valid.products.slice(0, 1) },
    },
    {
      name: "inventory count",
      response: {
        ...valid,
        inventory_items: valid.inventory_items.slice(0, 2),
      },
    },
    {
      name: "product batch_ref order",
      response: { ...valid, products: [...valid.products].reverse() },
    },
    {
      name: "inventory batch_ref order",
      response: {
        ...valid,
        inventory_items: [
          valid.inventory_items[1],
          valid.inventory_items[0],
          valid.inventory_items[2],
        ],
      },
    },
    {
      name: "existing Product mapping",
      response: {
        ...valid,
        inventory_items: valid.inventory_items.map((item, index) =>
          index === 0 ? { ...item, product_id: "different-existing" } : item,
        ),
      },
    },
    {
      name: "new Product mapping",
      response: {
        ...valid,
        inventory_items: valid.inventory_items.map((item, index) =>
          index === 1 ? { ...item, product_id: "generated-product-b" } : item,
        ),
      },
    },
    {
      name: "new Product ID conflicts with referenced existing Product",
      response: {
        ...valid,
        products: valid.products.map((product, index) =>
          index === 0
            ? { ...product, product_id: "existing-product" }
            : product,
        ),
        inventory_items: valid.inventory_items.map((item, index) =>
          index === 1 ? { ...item, product_id: "existing-product" } : item,
        ),
      },
    },
    {
      name: "Product ingredient text",
      response: {
        ...valid,
        products: valid.products.map((product, index) =>
          index === 0
            ? { ...product, ingredient_list_text: "different" }
            : product,
        ),
      },
    },
    {
      name: "Product shared notes",
      response: {
        ...valid,
        products: valid.products.map((product, index) =>
          index === 0 ? { ...product, shared_notes: "different" } : product,
        ),
      },
    },
    {
      name: "inventory custom notes",
      response: {
        ...valid,
        inventory_items: valid.inventory_items.map((item, index) =>
          index === 1 ? { ...item, custom_notes: "different" } : item,
        ),
      },
    },
  ];

  for (const testCase of cases) {
    let calls = 0;
    const client = await createRemoteBeautioClient({
      origin: "https://beautio.example",
      tokenFilePath: fixture.tokenPath,
      fetchImplementation: async () => {
        calls += 1;
        return jsonResponse(testCase.response);
      },
    });
    await assert.rejects(
      client.createInventoryBatch(input),
      hasBeautioError("INTERNAL_ERROR", "invalid response"),
      testCase.name,
    );
    assert.equal(calls, 1, testCase.name);
  }
});

test("remote client preserves known business errors but hides unknown transport details", async (context) => {
  const fixture = await tokenFixture(context);
  const businessClient = await createRemoteBeautioClient({
    origin: "https://beautio.example",
    tokenFilePath: fixture.tokenPath,
    fetchImplementation: async () =>
      jsonResponse(
        {
          error: {
            code: "PRODUCT_NOT_FOUND",
            message: "Product was not found",
            ref: "product-1",
          },
        },
        404,
      ),
  });
  await assert.rejects(
    businessClient.setProductDisplayImage({
      product_id: "missing",
      image_asset_id: "asset-1",
    }),
    (error: unknown) => {
      assert.equal(
        hasBeautioError("PRODUCT_NOT_FOUND", "Product was not found")(error),
        true,
      );
      assert.ok(error instanceof BeautioError);
      assert.equal(error.ref, "product-1");
      return true;
    },
  );

  let callCount = 0;
  const transportClient = await createRemoteBeautioClient({
    origin: "https://beautio.example",
    tokenFilePath: fixture.tokenPath,
    fetchImplementation: async () => {
      callCount += 1;
      throw new Error("action-token-for-test /private/secret-path");
    },
  });
  await assert.rejects(
    transportClient.getInventoryItem({
      inventory_item_id: "inventory-1",
      as_of: "2026-08-20",
    }),
    (error: unknown) => {
      assert.ok(error instanceof BeautioError);
      assert.equal(error.code, "INTERNAL_ERROR");
      assert.equal(error.message.includes("action-token-for-test"), false);
      assert.equal(error.message.includes("/private"), false);
      return true;
    },
  );
  assert.equal(callCount, 1);
});

test("remote client rejects mismatched set results and non-JSON media types without retrying writes", async (context) => {
  const fixture = await tokenFixture(context);
  const mismatchedClient = await createRemoteBeautioClient({
    origin: "https://beautio.example",
    tokenFilePath: fixture.tokenPath,
    fetchImplementation: async () =>
      jsonResponse({
        product: {
          product_id: "different-product",
          name: "Unexpected Product",
          category: null,
          size_label: null,
          image_asset_id: "different-asset",
          image_ref: null,
          ingredient_list_text: null,
          shared_notes: null,
        },
      }),
  });
  await assert.rejects(
    mismatchedClient.setProductDisplayImage({
      product_id: "product-1",
      image_asset_id: "asset-1",
    }),
    hasBeautioError("INTERNAL_ERROR", "invalid response"),
  );

  const jsonpClient = await createRemoteBeautioClient({
    origin: "https://beautio.example",
    tokenFilePath: fixture.tokenPath,
    fetchImplementation: async () =>
      new Response(JSON.stringify(GET_INVENTORY_OUTPUT), {
        headers: { "content-type": "application/jsonp" },
      }),
  });
  await assert.rejects(
    jsonpClient.getInventoryItem({
      inventory_item_id: "inventory-1",
      as_of: "2026-08-20",
    }),
    hasBeautioError("INTERNAL_ERROR", "invalid response"),
  );

  let writeCalls = 0;
  const unknownWriteClient = await createRemoteBeautioClient({
    origin: "https://beautio.example",
    tokenFilePath: fixture.tokenPath,
    fetchImplementation: async () => {
      writeCalls += 1;
      throw new Error("unknown write result with private detail");
    },
  });
  await assert.rejects(
    unknownWriteClient.setProductDisplayImage({
      product_id: "product-1",
      image_asset_id: "asset-1",
    }),
    hasBeautioError("INTERNAL_ERROR", "could not be completed"),
  );
  assert.equal(writeCalls, 1);
});

test("remote client bounds timeout and decoded response size", async (context) => {
  const fixture = await tokenFixture(context);
  const timeoutClient = await createRemoteBeautioClient({
    origin: "https://beautio.example",
    tokenFilePath: fixture.tokenPath,
    requestTimeoutMs: 10,
    fetchImplementation: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted with private detail", "AbortError"));
        });
      }),
  });
  await assert.rejects(
    timeoutClient.getInventoryItem({
      inventory_item_id: "inventory-1",
      as_of: "2026-08-20",
    }),
    hasBeautioError("INTERNAL_ERROR", "timed out"),
  );

  const oversizedClient = await createRemoteBeautioClient({
    origin: "https://beautio.example",
    tokenFilePath: fixture.tokenPath,
    maxResponseBytes: 32,
    fetchImplementation: async () =>
      jsonResponse({ ...GET_INVENTORY_OUTPUT, padding: "x".repeat(100) }),
  });
  await assert.rejects(
    oversizedClient.getInventoryItem({
      inventory_item_id: "inventory-1",
      as_of: "2026-08-20",
    }),
    hasBeautioError("INTERNAL_ERROR", "invalid response"),
  );

  const defaultLimitClient = await createRemoteBeautioClient({
    origin: "https://beautio.example",
    tokenFilePath: fixture.tokenPath,
    fetchImplementation: async () =>
      jsonResponse({ padding: "x".repeat(1024 * 1024) }),
  });
  await assert.rejects(
    defaultLimitClient.getInventoryItem({
      inventory_item_id: "inventory-1",
      as_of: "2026-08-20",
    }),
    hasBeautioError("INTERNAL_ERROR", "invalid response"),
  );
});

test("remote client accepts a maximum legal confirmed-text batch inside the one MiB response limit", async (context) => {
  const fixture = await tokenFixture(context);
  const products = Array.from({ length: 25 }, (_, index) => ({
    batch_ref: `product_${index}`,
    name: `Product ${index}`,
    ingredient_list_text: "成".repeat(5000),
    shared_notes: "共".repeat(1000),
  }));
  const inventoryItems = Array.from({ length: 100 }, (_, index) => ({
    batch_ref: `bottle_${index}`,
    product_ref: {
      kind: "new" as const,
      batch_ref: `product_${Math.floor(index / 4)}`,
    },
    lifecycle_status: "unopened" as const,
    custom_notes: "瓶".repeat(1000),
  }));
  const responseBody = {
    outcome: "created" as const,
    as_of: "2026-08-20",
    products: products.map((product, index) => ({
      ...product,
      product_id: `generated-product-${index}`,
      category: null,
      size_label: null,
      image_asset_id: null,
      image_ref: null,
    })),
    inventory_items: inventoryItems.map((item, index) => ({
      ...INVENTORY_STATE_OUTPUT,
      batch_ref: item.batch_ref,
      inventory_item_id: `generated-inventory-${index}`,
      product_id: `generated-product-${Math.floor(index / 4)}`,
      custom_notes: item.custom_notes,
    })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(responseBody)) < 1024 * 1024);

  const client = await createRemoteBeautioClient({
    origin: "https://beautio.example",
    tokenFilePath: fixture.tokenPath,
    fetchImplementation: async (_input, init) => {
      const requestBody = init?.body;
      assert.ok(typeof requestBody === "string");
      assert.ok(Buffer.byteLength(requestBody) < 1024 * 1024);
      return jsonResponse(responseBody);
    },
  });
  const output = await client.createInventoryBatch({
    as_of: "2026-08-20",
    products,
    inventory_items: inventoryItems,
  });
  assert.equal(output.products.length, 25);
  assert.equal(output.inventory_items.length, 100);
  assert.equal(output.products[24]?.ingredient_list_text?.length, 5000);
  assert.equal(output.inventory_items[99]?.custom_notes?.length, 1000);
});

async function tokenFixture(
  context: { after(callback: () => Promise<void>): void },
): Promise<{ readonly directory: string; readonly tokenPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "beautio-remote-token-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, "action-token");
  await writeFile(tokenPath, "action-token-for-test\n", { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  return { directory, tokenPath };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function requestUrl(input: string | URL | Request): URL {
  return input instanceof Request ? new URL(input.url) : new URL(input);
}

function openedOutput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ...INVENTORY_STATE_OUTPUT,
    outcome: "opened",
    lifecycle_status: "opened",
    opened_on: "2026-08-20",
    opened_on_accuracy: "exact",
    ...overrides,
  };
}

function imageAsset(
  sourceRef: string,
  imageAssetId: string,
  byteSize: number,
): Record<string, unknown> {
  return {
    source_ref: sourceRef,
    image_asset_id: imageAssetId,
    media_type: "image/jpeg",
    byte_size: byteSize,
    expires_at: "2026-08-21T00:00:00.000Z",
  };
}

function validCreateOutput(): CreateInventoryBatchOutput {
  return createInventoryBatchOutputSchema.parse({
    outcome: "created",
    as_of: "2026-08-20",
    products: [
      {
        batch_ref: "new_a",
        product_id: "generated-product-a",
        name: "New A",
        category: null,
        size_label: null,
        image_asset_id: null,
        image_ref: null,
        ingredient_list_text: "Aqua,\nGlycerin",
        shared_notes: "shared A",
      },
      {
        batch_ref: "new_b",
        product_id: "generated-product-b",
        name: "New B",
        category: null,
        size_label: null,
        image_asset_id: null,
        image_ref: null,
        ingredient_list_text: null,
        shared_notes: null,
      },
    ],
    inventory_items: [
      createdInventoryItem(
        "existing_bottle",
        "created-existing-bottle",
        "existing-product",
        "existing bottle note",
      ),
      createdInventoryItem(
        "new_a_bottle",
        "created-new-a-bottle",
        "generated-product-a",
        "new A bottle note",
      ),
      createdInventoryItem(
        "new_b_bottle",
        "created-new-b-bottle",
        "generated-product-b",
      ),
    ],
  });
}

function createdInventoryItem(
  batchRef: string,
  inventoryItemId: string,
  productId: string,
  customNotes: string | null = null,
): Record<string, unknown> {
  return {
    ...INVENTORY_STATE_OUTPUT,
    batch_ref: batchRef,
    inventory_item_id: inventoryItemId,
    product_id: productId,
    custom_notes: customNotes,
  };
}

function hasBeautioError(
  code: BeautioError["code"],
  messageFragment: string,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof BeautioError);
    assert.equal(error.code, code);
    assert.ok(error.message.includes(messageFragment));
    return true;
  };
}

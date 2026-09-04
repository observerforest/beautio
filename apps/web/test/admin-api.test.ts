import assert from "node:assert/strict";
import test from "node:test";
import {
  createInventoryBatchInputSchema,
  createInventoryBatchOutputSchema,
  endInventoryItemInputSchema,
  type BeautioBackup,
} from "@beautio/contracts";
import {
  AdminApiClient,
  AdminApiError,
  prepareBeautioBackupFile,
  type EndUseInput,
  type FetchLike,
  type ObjectUrlApi,
} from "../src/admin-api.ts";

const emptyBackup: BeautioBackup = {
  format: "beautio-backup",
  version: 1,
  created_at: "2026-08-30T00:00:00.000Z",
  products: [],
  inventory_items: [],
  images: [],
};

const inventoryBody = {
  as_of: "2026-08-19",
  items: [
    {
      inventory_item_id: "inventory-one",
      created_at: "2026-08-19T00:00:00.000Z",
      product_id: "product-one",
      product: {
        product_id: "product-one",
        name: "Example serum",
        alias: "Cloud Drop",
        brand: "Example Brand",
        category: null,
        size_label: "30 ml",
        image_asset_id: "asset-one",
        image_ref: "/legacy/example.webp",
        ingredient_list_text: "Water, Glycerin",
        shared_notes: "Product-level note",
      },
      product_inventory_position: 1,
      product_inventory_count: 1,
      lifecycle_status: "opened",
      opened_on: "2026-08-01",
      opened_on_accuracy: "estimated",
      expires_on: null,
      pao_duration_months: 6,
      pao_deadline: "2027-02-01",
      pao_deadline_accuracy: "estimated",
      usable_until: "2027-02-01",
      remaining_percent_estimate: null,
      usability_status: "usable",
      warnings: [],
      custom_notes: "Bottle-level note",
    },
  ],
} as const;

const creationInput = createInventoryBatchInputSchema.parse({
  as_of: "2026-08-19",
  products: [{ batch_ref: "new-product", name: "  Example serum  ", alias: " Cloud Drop " }],
  inventory_items: [{
    batch_ref: "bottle-1",
    product_ref: { kind: "new", batch_ref: "new-product" },
    lifecycle_status: "unopened",
  }],
});

const creationBody = createInventoryBatchOutputSchema.parse({
  outcome: "created",
  as_of: "2026-08-19",
  products: [{
    ...inventoryBody.items[0].product,
    batch_ref: "new-product",
    image_ref: null,
  }],
  inventory_items: [{
    batch_ref: "bottle-1",
    inventory_item_id: "inventory-new",
    product_id: "product-one",
    lifecycle_status: "unopened",
    opened_on: null,
    opened_on_accuracy: null,
    expires_on: null,
    pao_duration_months: null,
    pao_deadline: null,
    pao_deadline_accuracy: null,
    usable_until: null,
    usability_status: "unknown",
    warnings: [],
    custom_notes: null,
  }],
});

const endedInventoryBody = {
  as_of: "2026-09-01",
  inventory_item_id: "inventory one",
  product_id: "product-one",
  lifecycle_status: "discarded",
  opened_on: "2026-08-01",
  opened_on_accuracy: "estimated",
  expires_on: null,
  pao_duration_months: 6,
  pao_deadline: "2027-02-01",
  pao_deadline_accuracy: "estimated",
  usable_until: "2027-02-01",
  remaining_percent_estimate: 25,
  usability_status: "usable",
  warnings: [],
  custom_notes: "Existing bottle note",
} as const;

test("manual creation uses Admin POST, normalizes input, and accepts matching returned identifiers", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const client = new AdminApiClient("admin-secret", async (input, init = {}) => {
    calls.push({ path: String(input), init });
    return jsonResponse(creationBody);
  });
  const result = await client.createInventoryBatch(creationInput);
  assert.deepEqual(result, creationBody);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, "/api/admin/create-inventory-batch");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), "Bearer admin-secret");
  assert.equal(new Headers(calls[0]?.init.headers).get("content-type"), "application/json");
  const request = JSON.parse(String(calls[0]?.init.body));
  assert.equal(request.products[0].name, "Example serum");
  assert.equal(request.products[0].alias, "Cloud Drop");
  assert.doesNotMatch(String(calls[0]?.init.body), /admin-secret/);
  client.destroy();
});

test("Product PAO is sent once and mismatching create/update responses are not accepted", async () => {
  const input = createInventoryBatchInputSchema.parse({
    ...creationInput,
    products: creationInput.products.map((product) => ({ ...product, pao_duration_months: 12 })),
  });
  let calls = 0;
  const client = new AdminApiClient("admin-secret", async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    if (init?.method === "POST") {
      assert.equal(body.products[0].pao_duration_months, 12);
      assert.equal(body.inventory_items[0].pao_duration_months, undefined);
      return jsonResponse(creationBody);
    }
    assert.equal(body.pao_duration_months, 12);
    return jsonResponse({ product: { ...inventoryBody.items[0].product, pao_duration_months: 6 } });
  });
  await assert.rejects(client.createInventoryBatch(input), (error: unknown) =>
    error instanceof AdminApiError && error.status === 0);
  const product = creationBody.products[0];
  assert.ok(product);
  await assert.rejects(client.updateProduct(product.product_id, {
    name: product.name, category: null, size_label: null,
    image_asset_id: null, ingredient_list_text: null, shared_notes: null,
    pao_duration_months: 12,
  }), (error: unknown) => error instanceof AdminApiError && error.status === 0);
  assert.equal(calls, 2);
  client.destroy();
});

test("manual creation can reference an existing Product without sending shared facts", async () => {
  const resultBody = { ...creationBody, products: [] };
  const client = new AdminApiClient("admin-secret", async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.products, []);
    assert.deepEqual(request.inventory_items[0].product_ref, { kind: "existing", product_id: "product-one" });
    return jsonResponse(resultBody);
  });
  assert.deepEqual(await client.createInventoryBatch({
    as_of: creationInput.as_of,
    products: [],
    inventory_items: [{
      batch_ref: "bottle-1",
      product_ref: { kind: "existing", product_id: "product-one" },
      lifecycle_status: "unopened",
    }],
  }), resultBody);
  client.destroy();
});

test("manual creation rejects invalid input before making a request", async () => {
  let calls = 0;
  const client = new AdminApiClient("admin-secret", async () => {
    calls += 1;
    return jsonResponse(creationBody);
  });
  await assert.rejects(client.createInventoryBatch({ ...creationInput, inventory_items: [] }));
  await assert.rejects(client.createInventoryBatch({
    ...creationInput,
    products: [{ batch_ref: "new-product", name: "Example", alias: "12345678901" }],
  }));
  assert.equal(calls, 0);
  client.destroy();
});

test("manual creation rejects malformed or mismatched success responses without retrying", async () => {
  const mismatchedBodies = [
    {},
    { ...creationBody, as_of: "2026-08-20" },
    { ...creationBody, inventory_items: [] },
    { ...creationBody, products: [] },
    { ...creationBody, products: [{ ...creationBody.products[0], batch_ref: "other-product" }] },
    { ...creationBody, inventory_items: [{ ...creationBody.inventory_items[0], batch_ref: "other-bottle" }] },
    { ...creationBody, inventory_items: [{ ...creationBody.inventory_items[0], product_id: "other-product" }] },
  ];
  for (const body of mismatchedBodies) {
    let calls = 0;
    const client = new AdminApiClient("admin-secret", async () => {
      calls += 1;
      return jsonResponse(body);
    });
    await assert.rejects(client.createInventoryBatch(creationInput),
      (error: unknown) => error instanceof AdminApiError && error.code === "INVALID_RESPONSE");
    assert.equal(calls, 1);
    client.destroy();
  }
});

test("manual creation preserves uncertain network and server failures without automatic retries", async () => {
  for (const serverFailure of [false, true]) {
    let calls = 0;
    const client = new AdminApiClient("admin-secret", async () => {
      calls += 1;
      if (serverFailure) return jsonResponse({ error: { code: "INTERNAL_ERROR", message: "Unknown result" } }, 500);
      throw new TypeError("Connection lost after sending");
    });
    await assert.rejects(client.createInventoryBatch(creationInput));
    assert.equal(calls, 1);
    client.destroy();
  }
});

test("end use sends one strict Admin POST and correlates terminal readback", async () => {
  const cases = [
    {
      input: endInventoryItemInputSchema.parse({
        as_of: "2026-09-01",
        lifecycle_status: "finished",
      }),
      response: {
        ...endedInventoryBody,
        lifecycle_status: "finished" as const,
        remaining_percent_estimate: 0,
      },
    },
    {
      input: endInventoryItemInputSchema.parse({
        as_of: "2026-09-01",
        lifecycle_status: "discarded",
        remaining_percent_estimate: 25,
      }),
      response: endedInventoryBody,
    },
    {
      input: endInventoryItemInputSchema.parse({
        as_of: "2026-09-01",
        lifecycle_status: "discarded",
        remaining_percent_estimate: null,
      }),
      response: {
        ...endedInventoryBody,
        remaining_percent_estimate: null,
      },
    },
  ];

  for (const { input, response } of cases) {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const client = new AdminApiClient("admin-secret", async (url, init = {}) => {
      calls.push({ path: String(url), init });
      return jsonResponse(response);
    });

    assert.deepEqual(await client.endInventoryItem(" inventory one ", input), response);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.path,
      "/api/admin/inventory-items/inventory%20one/end-use",
    );
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal(
      new Headers(calls[0]?.init.headers).get("authorization"),
      "Bearer admin-secret",
    );
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), input);
    client.destroy();
  }
});

test("end use rejects invalid drafts before HTTP and never retries uncertain writes", async () => {
  let calls = 0;
  const invalidClient = new AdminApiClient("admin-secret", async () => {
    calls += 1;
    return jsonResponse(endedInventoryBody);
  });
  const invalidInputs: readonly unknown[] = [
    {
      as_of: "2026-09-01",
      lifecycle_status: "discarded",
      remaining_percent_estimate: 1.5,
    },
    {
      as_of: "2026-09-01",
      lifecycle_status: "discarded",
      remaining_percent_estimate: 101,
    },
    { as_of: "2026-09-01", lifecycle_status: "discarded" },
    {
      as_of: "2026-09-01",
      lifecycle_status: "finished",
      remaining_percent_estimate: 0,
    },
  ];
  for (const input of invalidInputs) {
    await assert.rejects(
      invalidClient.endInventoryItem("inventory-one", input as EndUseInput),
    );
  }
  assert.equal(calls, 0);
  invalidClient.destroy();

  const uncertainClient = new AdminApiClient("admin-secret", async () => {
    calls += 1;
    throw new TypeError("Connection lost after sending");
  });
  await assert.rejects(
    uncertainClient.endInventoryItem("inventory-one", endInventoryItemInputSchema.parse({
      as_of: "2026-09-01",
      lifecycle_status: "finished",
    })),
  );
  assert.equal(calls, 1);
  uncertainClient.destroy();
});

test("end use rejects mismatched terminal responses after one request", async () => {
  const mismatches = [
    { ...endedInventoryBody, inventory_item_id: "other" },
    { ...endedInventoryBody, as_of: "2026-09-02" },
    { ...endedInventoryBody, lifecycle_status: "finished" },
    { ...endedInventoryBody, remaining_percent_estimate: 50 },
  ];
  for (const response of mismatches) {
    let calls = 0;
    const client = new AdminApiClient("admin-secret", async () => {
      calls += 1;
      return jsonResponse(response);
    });
    await assert.rejects(
      client.endInventoryItem("inventory one", endInventoryItemInputSchema.parse({
        as_of: "2026-09-01",
        lifecycle_status: "discarded",
        remaining_percent_estimate: 25,
      })),
      (error: unknown) =>
        error instanceof AdminApiError && error.code === "INVALID_RESPONSE",
    );
    assert.equal(calls, 1);
    client.destroy();
  }
});

test(
  "default browser fetch preserves the global receiver",
  { concurrency: false },
  async () => {
    const originalFetch = globalThis.fetch;
    let observedReceiver: unknown;
    globalThis.fetch = async function (
      this: typeof globalThis,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      observedReceiver = this;
      return jsonResponse(inventoryBody);
    };

    try {
      const client = new AdminApiClient("admin-secret");

      const result = await client.readInventory("2026-08-19");

      assert.equal(observedReceiver, globalThis);
      assert.equal(result.items.length, 1);
      client.destroy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

test("inventory reads use the in-memory Admin Bearer token", async () => {
  const calls: Array<{ readonly path: string; readonly init: RequestInit }> = [];
  const fetchImplementation: FetchLike = async (input, init = {}) => {
    calls.push({ path: String(input), init });
    return jsonResponse(inventoryBody);
  };
  const client = new AdminApiClient("admin-secret", fetchImplementation);

  const result = await client.readInventory("2026-08-19");

  assert.equal(result.items[0]?.opened_on_accuracy, "estimated");
  assert.equal(result.items[0]?.created_at, "2026-08-19T00:00:00.000Z");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, "/api/inventory?as_of=2026-08-19");
  assert.equal(
    new Headers(calls[0]?.init.headers).get("authorization"),
    "Bearer admin-secret",
  );
  assert.doesNotMatch(calls[0]?.path ?? "", /admin-secret/);
  client.destroy();
});

test("backup download avoids reserialization and restore reuses the bounded original file", async () => {
  const calls: Array<{ readonly path: string; readonly init: RequestInit }> = [];
  const client = new AdminApiClient("admin-secret", async (input, init = {}) => {
    calls.push({ path: String(input), init });
    return String(input) === "/api/admin/backup" && init.method === "PUT"
      ? jsonResponse({ restored: true, products: 0, inventory_items: 0, images: 0 })
      : new Response(JSON.stringify(emptyBackup), {
          headers: {
            "content-disposition":
              'attachment; filename="beautio-backup-2026-08-30.beautio-backup"',
            "content-type": "application/json",
          },
        });
  });

  const download = await client.downloadBackup();
  assert.equal(download.filename, "beautio-backup-2026-08-30.beautio-backup");
  assert.deepEqual(JSON.parse(await download.blob.text()), emptyBackup);
  const backupFile = new File(
    [JSON.stringify(emptyBackup)],
    "backup.beautio-backup",
    { type: "application/json" },
  );
  assert.deepEqual(await client.restoreBackupFile(backupFile), {
    restored: true,
    products: 0,
    inventory_items: 0,
    images: 0,
  });
  assert.equal(calls[0]?.path, "/api/admin/backup");
  assert.equal(calls[0]?.init.method, undefined);
  assert.equal(calls[1]?.path, "/api/admin/backup");
  assert.equal(calls[1]?.init.method, "PUT");
  assert.equal(calls[1]?.init.body, backupFile);
  assert.deepEqual(
    prepareBeautioBackupFile(backupFile),
    {
      file: backupFile,
      byteSize: backupFile.size,
    },
  );
  assert.throws(
    () => prepareBeautioBackupFile(new File([], "empty.beautio-backup")),
    (error: unknown) =>
      error instanceof AdminApiError && error.code === "EMPTY_BACKUP",
  );
  client.destroy();
});

test("Product, InventoryItem facts, and custom notes use isolated frozen bodies", async () => {
  const calls: Array<{ readonly path: string; readonly init: RequestInit }> = [];
  const fetchImplementation: FetchLike = async (input, init = {}) => {
    calls.push({ path: String(input), init });
    if (String(input).includes("/products/")) {
      return jsonResponse({
        product: {
          product_id: "product/one",
          name: "Updated",
          alias: "Cloud Jar",
          brand: "Beautio",
          category: null,
          size_label: "50 ml",
          image_asset_id: null,
          image_ref: "/legacy/kept.webp",
          ingredient_list_text: "Water\nGlycerin",
          shared_notes: null,
        },
      });
    }
    if (String(input).endsWith("/custom-notes")) {
      return jsonResponse({
        inventory_item: {
          inventory_item_id: "inventory one",
          custom_notes: "Only this bottle",
        },
      });
    }
    return jsonResponse({
      as_of: "2026-08-19",
      inventory_item_id: "inventory one",
      product_id: "product-one",
      lifecycle_status: "opened",
      opened_on: "2026-08-01",
      opened_on_accuracy: "estimated",
      expires_on: null,
      pao_duration_months: 6,
      pao_deadline: "2027-02-01",
      pao_deadline_accuracy: "estimated",
      usable_until: "2027-02-01",
      usability_status: "usable",
      warnings: [],
      custom_notes: "Existing bottle note",
    });
  };
  const client = new AdminApiClient("admin-secret", fetchImplementation);

  await client.updateProduct("product/one", {
    name: "Updated",
    alias: "  Cloud Jar  ",
    brand: "  Beautio  ",
    category: null,
    size_label: "50 ml",
    image_asset_id: null,
    ingredient_list_text: "  Water\nGlycerin  ",
    shared_notes: null,
  });
  await client.updateInventoryItemFacts("inventory one", {
    as_of: "2026-08-19",
    lifecycle_status: "opened",
    opened_on: "2026-08-01",
    opened_on_accuracy: "estimated",
    expires_on: null,
    pao_duration_months: 6,
  });
  const updatedNotes = await client.updateInventoryItemCustomNotes(
    "inventory one",
    { custom_notes: "  Only this bottle  " },
  );

  assert.equal(calls[0]?.path, "/api/admin/products/product%2Fone");
  assert.equal(calls[0]?.init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    name: "Updated",
    alias: "Cloud Jar",
    brand: "Beautio",
    category: null,
    size_label: "50 ml",
    image_asset_id: null,
    ingredient_list_text: "Water\nGlycerin",
    shared_notes: null,
  });
  assert.equal(
    calls[1]?.path,
    "/api/admin/inventory-items/inventory%20one/facts",
  );
  assert.equal(calls[1]?.init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
    as_of: "2026-08-19",
    lifecycle_status: "opened",
    opened_on: "2026-08-01",
    opened_on_accuracy: "estimated",
    expires_on: null,
    pao_duration_months: 6,
  });
  assert.equal(
    calls[2]?.path,
    "/api/admin/inventory-items/inventory%20one/custom-notes",
  );
  assert.equal(calls[2]?.init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), {
    custom_notes: "Only this bottle",
  });
  assert.deepEqual(updatedNotes, {
    inventory_item_id: "inventory one",
    custom_notes: "Only this bottle",
  });
  assert.ok(
    calls.every((call) => !call.path.includes("Only%20this%20bottle")),
  );
  assert.ok(
    calls.every(
      (call) =>
        new Headers(call.init.headers).get("authorization") ===
        "Bearer admin-secret",
    ),
  );
  client.destroy();
});

test("an oversized Product alias is rejected before any browser request", async () => {
  const calls: Array<{ readonly path: string; readonly init: RequestInit }> = [];
  const client = new AdminApiClient("admin-secret", async (input, init = {}) => {
    calls.push({ path: String(input), init });
    return jsonResponse({});
  });

  await assert.rejects(
    client.updateProduct("product-one", {
      name: "Serum",
      alias: "紫".repeat(11),
      category: null,
      size_label: null,
      image_asset_id: null,
      ingredient_list_text: null,
      shared_notes: null,
    }),
    /INVALID_INPUT: alias must be at most 10 characters/,
  );
  assert.equal(calls.length, 0);
  client.destroy();
});

test("custom notes whitespace clears to null before the narrow request", async () => {
  const calls: Array<{ readonly path: string; readonly init: RequestInit }> = [];
  const client = new AdminApiClient("admin-secret", async (input, init = {}) => {
    calls.push({ path: String(input), init });
    return jsonResponse({
      inventory_item: {
        inventory_item_id: "terminal-item",
        custom_notes: null,
      },
    });
  });

  await client.updateInventoryItemCustomNotes("  terminal-item  ", {
    custom_notes: "  \n  ",
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.path,
    "/api/admin/inventory-items/terminal-item/custom-notes",
  );
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    custom_notes: null,
  });
  client.destroy();
});

test("over-limit custom notes are rejected before any request", async () => {
  let requestCount = 0;
  const client = new AdminApiClient("admin-secret", async () => {
    requestCount += 1;
    return jsonResponse({});
  });

  await assert.rejects(
    client.updateInventoryItemCustomNotes("inventory-item", {
      custom_notes: "x".repeat(1_001),
    }),
  );

  assert.equal(requestCount, 0);
  client.destroy();
});

test("custom notes response must match the requested bottle and normalized text", async () => {
  const wrongBottle = new AdminApiClient("admin-secret", async () =>
    jsonResponse({
      inventory_item: {
        inventory_item_id: "another-item",
        custom_notes: "Expected note",
      },
    }),
  );
  await assert.rejects(
    wrongBottle.updateInventoryItemCustomNotes("inventory-item", {
      custom_notes: "Expected note",
    }),
  );
  wrongBottle.destroy();

  const wrongText = new AdminApiClient("admin-secret", async () =>
    jsonResponse({
      inventory_item: {
        inventory_item_id: "inventory-item",
        custom_notes: "Different note",
      },
    }),
  );
  await assert.rejects(
    wrongText.updateInventoryItemCustomNotes("inventory-item", {
      custom_notes: "Expected note",
    }),
  );
  wrongText.destroy();
});

test("image upload uses one multipart image field and returns an opaque asset id", async () => {
  let capturedBody: BodyInit | null | undefined;
  let capturedPath = "";
  let capturedHeaders = new Headers();
  const fetchImplementation: FetchLike = async (input, init = {}) => {
    capturedPath = String(input);
    capturedBody = init.body;
    capturedHeaders = new Headers(init.headers);
    return jsonResponse({
      asset: {
        image_asset_id: "asset-one",
        media_type: "image/png",
        byte_size: 3,
        expires_at: "2026-08-20T00:00:00.000Z",
      },
    });
  };
  const client = new AdminApiClient("admin-secret", fetchImplementation);
  const image = new File([new Uint8Array([1, 2, 3])], "product.png", {
    type: "image/png",
  });

  const asset = await client.uploadProductImage(image);

  assert.equal(asset.image_asset_id, "asset-one");
  assert.equal(capturedPath, "/api/admin/image-assets");
  assert.equal(capturedHeaders.get("authorization"), "Bearer admin-secret");
  assert.equal(capturedHeaders.has("content-type"), false);
  assert.ok(capturedBody instanceof FormData);
  const uploaded = capturedBody.get("image");
  assert.ok(uploaded instanceof File);
  assert.equal(uploaded.name, "product.png");
  assert.deepEqual([...capturedBody.keys()], ["image"]);
  client.destroy();
});

test("private images use tracked Blob URLs that are revoked explicitly and on client destroy", async () => {
  const revoked: string[] = [];
  const calls: Array<{ readonly path: string; readonly init: RequestInit }> = [];
  let nextObjectUrl = 0;
  const objectUrlApi: ObjectUrlApi = {
    createObjectURL: () => `blob:test-${++nextObjectUrl}`,
    revokeObjectURL: (url) => revoked.push(url),
  };
  const fetchImplementation: FetchLike = async (input, init = {}) => {
    calls.push({ path: String(input), init });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  };
  const client = new AdminApiClient(
    "admin-secret",
    fetchImplementation,
    objectUrlApi,
  );

  const first = await client.loadPrivateImage("asset-one", "card");
  const second = await client.loadPrivateImage("asset-two");
  client.revokeObjectUrl(first);
  client.destroy();

  assert.equal(
    calls[0]?.path,
    "/api/image-assets/asset-one/content?variant=card",
  );
  assert.equal(calls[1]?.path, "/api/image-assets/asset-two/content");
  assert.equal(
    new Headers(calls[0]?.init.headers).get("authorization"),
    "Bearer admin-secret",
  );
  assert.deepEqual(revoked, [first, second]);
  await assert.rejects(
    client.readInventory("2026-08-19"),
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
});

test("HTTP failures preserve the stable error but never add the token", async () => {
  const client = new AdminApiClient("never-print-this", async () =>
    jsonResponse(
      { error: { code: "UNAUTHORIZED", message: "Admin token is invalid." } },
      401,
    ),
  );

  await assert.rejects(
    client.readInventory("2026-08-19"),
    (error: unknown) => {
      assert.ok(error instanceof AdminApiError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "UNAUTHORIZED");
      assert.doesNotMatch(error.message, /never-print-this/);
      return true;
    },
  );
  client.destroy();
});

test("non-JSON HTTP failures retain their status for user-visible diagnostics", async () => {
  const client = new AdminApiClient("admin-secret", async () =>
    new Response("Bad gateway", { status: 502 }),
  );

  await assert.rejects(
    client.readInventory("2026-08-19"),
    (error: unknown) => {
      assert.ok(error instanceof AdminApiError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "HTTP_ERROR");
      assert.match(error.message, /HTTP 502/u);
      return true;
    },
  );
  client.destroy();
});

test("invalid browser date drafts are rejected before any HTTP write", async () => {
  let calls = 0;
  const client = new AdminApiClient("admin-secret", async () => {
    calls += 1;
    return jsonResponse({});
  });

  await assert.rejects(
    client.updateInventoryItemFacts("inventory-one", {
      as_of: "2026-02-30",
      lifecycle_status: "opened",
      opened_on: "2026-08-01",
      opened_on_accuracy: "exact",
      expires_on: null,
      pao_duration_months: null,
    }),
  );
  assert.equal(calls, 0);
  client.destroy();
});

test("locking aborts an in-flight authenticated request", async () => {
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const client = new AdminApiClient("admin-secret", async (_input, init) => {
    requestStarted();
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  });

  const read = client.readInventory("2026-08-19");
  await started;
  client.destroy();

  await assert.rejects(
    read,
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

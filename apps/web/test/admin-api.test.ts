import assert from "node:assert/strict";
import test from "node:test";
import {
  AdminApiClient,
  AdminApiError,
  type FetchLike,
  type ObjectUrlApi,
} from "../src/admin-api.ts";

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
      usability_status: "usable",
      warnings: [],
      custom_notes: "Bottle-level note",
    },
  ],
} as const;

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

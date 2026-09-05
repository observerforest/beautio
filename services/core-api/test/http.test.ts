import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import {
  createServer,
  request as makeHttpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  InventoryApplicationService,
  type ImageAssetStorage,
  type ImageInspector,
} from "@beautio/application";
import {
  createInventoryBatchInputSchema,
  createInventoryBatchOutputSchema,
  endInventoryItemOutputSchema,
  inventoryListOutputSchema,
  type BeautioBackup,
} from "@beautio/contracts";
import { SqliteInventoryRepository } from "@beautio/database";
import {
  BeautioError,
  createInventoryItem,
  type LifecycleStatus,
} from "@beautio/domain";
import {
  FileImageAssetStorage,
  FileImageRenditionProvider,
  sharpImageInspector,
} from "@beautio/image-storage";
import sharp from "sharp";
import {
  createCoreApiHandler,
  type CoreApiHandlerOptions,
} from "../src/index.ts";
import { sendError } from "../src/responses.ts";
import {
  routeRequest,
  type RouteRequestDependencies,
  type ValidatedOptions,
} from "../src/routes.ts";

const ACTION_TOKEN = "test-action-token-not-a-secret";
const CUSTOM_GPT_TOKEN = "test-custom-gpt-token-not-a-secret";
const ADMIN_TOKEN = "test-admin-token-not-a-secret";
const STATIC_SCRIPT = "console.log('beautio production web');\n";

test("HTTP adapter requires three pairwise-distinct bearer tokens", () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const application = new InventoryApplicationService(repository);
  const options = {
    customGptBearerToken: CUSTOM_GPT_TOKEN,
    actionBearerToken: ACTION_TOKEN,
    adminBearerToken: ADMIN_TOKEN,
    actionFileHosts: new Set(["files.example.test"]),
  };

  assert.throws(
    () =>
      createCoreApiHandler(application, {
        ...options,
        customGptBearerToken: " ",
      }),
    /all Beautio HTTP bearer tokens are required/,
  );
  assert.throws(
    () => createCoreApiHandler(application, { ...options, actionBearerToken: "" }),
    /all Beautio HTTP bearer tokens are required/,
  );
  assert.throws(
    () => createCoreApiHandler(application, { ...options, adminBearerToken: " " }),
    /all Beautio HTTP bearer tokens are required/,
  );
  assert.throws(
    () =>
      createCoreApiHandler(application, {
        ...options,
        customGptBearerToken: ` ${ACTION_TOKEN} `,
      }),
    /must be different/,
  );
  assert.throws(
    () =>
      createCoreApiHandler(application, {
        ...options,
        customGptBearerToken: ` ${ADMIN_TOKEN} `,
      }),
    /must be different/,
  );
  assert.throws(
    () =>
      createCoreApiHandler(application, {
        ...options,
        adminBearerToken: ACTION_TOKEN,
      }),
    /must be different/,
  );
  assert.throws(
    () =>
      createCoreApiHandler(application, {
        ...options,
        publicOrigin: "http://beautio.example.test",
      }),
    /must be an HTTPS origin/,
  );
  assert.throws(
    () =>
      createCoreApiHandler(application, {
        ...options,
        publicOrigin: "https://beautio.example.test/not-an-origin",
      }),
    /must be an HTTPS origin/,
  );
  assert.throws(
    () => createCoreApiHandler(application, { ...options, webRoot: "dist" }),
    /must be an absolute directory path/,
  );
  repository.close();
});

test("health is public while Custom GPT, Codex, and Admin scopes are isolated", async (context) => {
  const fixture = await startFixture(context);

  assert.equal((await fetch(`${fixture.origin}/api/health`)).status, 200);

  const customGptRequests = [
    (token?: string) =>
      fetch(`${fixture.origin}/openapi/beautio-actions-v1.json`, {
        ...(token === undefined ? {} : { headers: authorization(token) }),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/actions/upload-product-images`, {
        method: "POST",
        headers:
          token === undefined
            ? { "content-type": "application/json" }
            : { ...authorization(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/actions/create-inventory-batch`, {
        method: "POST",
        headers:
          token === undefined
            ? { "content-type": "application/json" }
            : { ...authorization(token), "content-type": "application/json" },
        body: JSON.stringify(emptyBatch()),
      }),
  ];
  const codexRequests = [
    (token?: string) =>
      fetch(`${fixture.origin}/api/actions/codex/create-inventory-batch`, {
        method: "POST",
        headers:
          token === undefined
            ? { "content-type": "application/json" }
            : { ...authorization(token), "content-type": "application/json" },
        body: JSON.stringify(emptyBatch()),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/actions/codex/upload-product-images`, {
        method: "POST",
        ...(token === undefined ? {} : { headers: authorization(token) }),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/actions/codex/get-inventory-item`, {
        method: "POST",
        headers:
          token === undefined
            ? { "content-type": "application/json" }
            : { ...authorization(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/actions/codex/record-product-opened`, {
        method: "POST",
        headers:
          token === undefined
            ? { "content-type": "application/json" }
            : { ...authorization(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/actions/codex/set-product-display-image`, {
        method: "POST",
        headers:
          token === undefined
            ? { "content-type": "application/json" }
            : { ...authorization(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
  ];
  const adminRequests = [
    (token?: string) =>
      fetch(`${fixture.origin}/api/inventory?as_of=2026-08-19`, {
        ...(token === undefined ? {} : { headers: authorization(token) }),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/admin/create-inventory-batch`, {
        method: "POST",
        headers:
          token === undefined
            ? { "content-type": "application/json" }
            : { ...authorization(token), "content-type": "application/json" },
        body: JSON.stringify(emptyBatch()),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/admin/image-assets`, {
        method: "POST",
        ...(token === undefined ? {} : { headers: authorization(token) }),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/admin/backup`, {
        ...(token === undefined ? {} : { headers: authorization(token) }),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/admin/backup`, {
        method: "PUT",
        headers:
          token === undefined
            ? { "content-type": "application/json" }
            : { ...authorization(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/admin/products/missing`, {
        method: "PUT",
        headers:
          token === undefined
            ? { "content-type": "application/json" }
            : { ...authorization(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/admin/inventory-items/missing/facts`, {
        method: "PUT",
        headers:
          token === undefined
            ? { "content-type": "application/json" }
            : { ...authorization(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/admin/inventory-items/missing/end-use`, {
        method: "POST",
        headers:
          token === undefined
            ? { "content-type": "application/json" }
            : { ...authorization(token), "content-type": "application/json" },
        body: JSON.stringify({
          as_of: "2026-09-01",
          lifecycle_status: "finished",
        }),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/admin/inventory-items/missing/custom-notes`, {
        method: "PUT",
        headers:
          token === undefined
            ? { "content-type": "application/json" }
            : { ...authorization(token), "content-type": "application/json" },
        body: JSON.stringify({ custom_notes: "must not be accepted" }),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/image-assets/missing/content`, {
        ...(token === undefined ? {} : { headers: authorization(token) }),
      }),
    (token?: string) =>
      fetch(`${fixture.origin}/api/image-assets/missing/content?variant=card`, {
        ...(token === undefined ? {} : { headers: authorization(token) }),
      }),
  ];

  for (const request of customGptRequests) {
    assert.equal((await request()).status, 401);
    assert.equal((await request(ACTION_TOKEN)).status, 401);
    assert.equal((await request(ADMIN_TOKEN)).status, 401);
    assert.equal((await request("wrong-token")).status, 401);
    assert.notEqual((await request(CUSTOM_GPT_TOKEN)).status, 401);
  }
  for (const request of codexRequests) {
    assert.equal((await request()).status, 401);
    assert.equal((await request(CUSTOM_GPT_TOKEN)).status, 401);
    assert.equal((await request(ADMIN_TOKEN)).status, 401);
    assert.equal((await request("wrong-token")).status, 401);
    assert.notEqual((await request(ACTION_TOKEN)).status, 401);
  }
  for (const request of adminRequests) {
    assert.equal((await request()).status, 401);
    assert.equal((await request(CUSTOM_GPT_TOKEN)).status, 401);
    assert.equal((await request(ACTION_TOKEN)).status, 401);
    assert.equal((await request("wrong-token")).status, 401);
    assert.notEqual((await request(ADMIN_TOKEN)).status, 401);
  }

  const codexUnknown = `${fixture.origin}/api/actions/codex/unknown`;
  assert.equal(
    (await fetch(codexUnknown, { headers: authorization(CUSTOM_GPT_TOKEN) })).status,
    401,
  );
  assert.notEqual(
    (await fetch(codexUnknown, { headers: authorization(ACTION_TOKEN) })).status,
    401,
  );
  const codexical = `${fixture.origin}/api/actions/codexical`;
  assert.equal(
    (await fetch(codexical, { headers: authorization(ACTION_TOKEN) })).status,
    401,
  );
  assert.notEqual(
    (await fetch(codexical, { headers: authorization(CUSTOM_GPT_TOKEN) })).status,
    401,
  );
  const encodedCodex = `${fixture.origin}/api/actions/%63odex/unknown`;
  assert.equal(
    (await fetch(encodedCodex, { headers: authorization(ACTION_TOKEN) })).status,
    401,
  );
  assert.deepEqual(
    await fixture.application.listInventory({ as_of: "2026-08-19" }),
    { as_of: "2026-08-19", items: [] },
  );
});

test("encoded dynamic path hazards are rejected after authentication without reaching the application", async (context) => {
  const fixture = await startFixture(context);
  let updateProductCalls = 0;
  let endInventoryItemCalls = 0;
  let readImageAssetCalls = 0;
  const originalUpdateProduct = fixture.application.updateProduct;
  const originalEndInventoryItem = fixture.application.endInventoryItem;
  const originalReadImageAsset = fixture.application.readImageAsset;
  fixture.application.updateProduct = async (...args) => {
    updateProductCalls += 1;
    return originalUpdateProduct.apply(fixture.application, args);
  };
  fixture.application.endInventoryItem = async (...args) => {
    endInventoryItemCalls += 1;
    return originalEndInventoryItem.apply(fixture.application, args);
  };
  fixture.application.readImageAsset = async (...args) => {
    readImageAssetCalls += 1;
    return originalReadImageAsset.apply(fixture.application, args);
  };

  const invalidDynamicRequests = [
    fetch(`${fixture.origin}/api/admin/products/%2F`, {
      method: "PUT",
      headers: { ...authorization(ADMIN_TOKEN), "content-type": "application/json" },
      body: "{}",
    }),
    fetch(`${fixture.origin}/api/admin/inventory-items/%252F/end-use`, {
      method: "POST",
      headers: { ...authorization(ADMIN_TOKEN), "content-type": "application/json" },
      body: "{}",
    }),
    fetch(`${fixture.origin}/api/image-assets/%5C/content`, {
      headers: authorization(ADMIN_TOKEN),
    }),
  ];
  for (const response of await Promise.all(invalidDynamicRequests)) {
    assert.equal(response.status, 400);
  }

  for (const dotPath of ["%2e", "%2e%2e"]) {
    const withoutToken = await fetch(
      `${fixture.origin}/api/admin/products/${dotPath}`,
      { method: "PUT" },
    );
    assert.equal(withoutToken.status, 401);

    const authenticated = await fetch(
      `${fixture.origin}/api/admin/products/${dotPath}`,
      {
        method: "PUT",
        headers: {
          ...authorization(ADMIN_TOKEN),
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    assert.equal(authenticated.status, 400);
  }

  assert.equal(updateProductCalls, 0);
  assert.equal(endInventoryItemCalls, 0);
  assert.equal(readImageAssetCalls, 0);
});

test("Admin creates new products and bottles with or without an uploaded image", async (context) => {
  const fixture = await startFixture(context);
  const form = new FormData();
  form.set("image", new Blob([fixture.imageBytes], { type: "image/png" }), "sample.png");
  const uploadResponse = await fetch(`${fixture.origin}/api/admin/image-assets`, {
    method: "POST",
    headers: authorization(ADMIN_TOKEN),
    body: form,
  });
  assert.equal(uploadResponse.status, 200);
  const uploaded = (await uploadResponse.json()) as {
    readonly asset: { readonly image_asset_id: string };
  };

  for (const imageAssetId of [null, uploaded.asset.image_asset_id]) {
    const response = await postJson(
      `${fixture.origin}/api/admin/create-inventory-batch`,
      {
        as_of: "2026-08-19",
        products: [
          {
            batch_ref: "sample_product",
            name: "Sample serum",
            alias: "Sample",
            brand: "Example Lab",
            category: "Serum",
            size_label: "30 ml",
            image_asset_id: imageAssetId,
            ingredient_list_text: "Aqua, Glycerin",
            shared_notes: "Sample shared note",
          },
        ],
        inventory_items: [
          {
            batch_ref: "opened_bottle",
            product_ref: { kind: "new", batch_ref: "sample_product" },
            lifecycle_status: "opened",
            opened_on: "2026-08-01",
            opened_on_accuracy: "estimated",
            expires_on: "2027-08-01",
            pao_duration_months: 6,
            custom_notes: "Opened bottle note",
          },
          {
            batch_ref: "unopened_bottle",
            product_ref: { kind: "new", batch_ref: "sample_product" },
            lifecycle_status: "unopened",
            custom_notes: "Spare bottle note",
          },
        ],
      },
      ADMIN_TOKEN,
    );
    assert.equal(response.status, 200);
    const created = createInventoryBatchOutputSchema.parse(await response.json());
    assert.equal(created.outcome, "created");
    assert.equal(created.products.length, 1);
    const product = created.products[0];
    assert.ok(product);
    assert.equal(product.name, "Sample serum");
    assert.equal(product.alias, "Sample");
    assert.equal(product.brand, "Example Lab");
    assert.equal(product.image_asset_id, imageAssetId);
    assert.equal(product.ingredient_list_text, "Aqua, Glycerin");
    assert.equal(product.shared_notes, "Sample shared note");
    assert.equal(created.inventory_items.length, 2);
    assert.equal(new Set(created.inventory_items.map((item) => item.inventory_item_id)).size, 2);
    assert.ok(created.inventory_items.every((item) => item.product_id === product.product_id));
    assert.equal(created.inventory_items[0]?.opened_on, "2026-08-01");
    assert.equal(created.inventory_items[0]?.pao_deadline_accuracy, "estimated");
    assert.equal(created.inventory_items[0]?.custom_notes, "Opened bottle note");
    assert.equal(created.inventory_items[1]?.opened_on, null);
    assert.equal(created.inventory_items[1]?.custom_notes, "Spare bottle note");
  }

  const inventoryResponse = await fetch(`${fixture.origin}/api/inventory?as_of=2026-08-19`, {
    headers: authorization(ADMIN_TOKEN),
  });
  assert.equal(inventoryResponse.status, 200);
  const inventory = (await inventoryResponse.json()) as {
    readonly items: readonly {
      readonly product: { readonly image_asset_id: string | null };
    }[];
  };
  assert.equal(inventory.items.length, 4);
  assert.equal(inventory.items.filter((item) => item.product.image_asset_id === null).length, 2);
  assert.equal(
    inventory.items.filter((item) => item.product.image_asset_id === uploaded.asset.image_asset_id).length,
    2,
  );
  const imageResponse = await fetch(
    `${fixture.origin}/api/image-assets/${encodeURIComponent(uploaded.asset.image_asset_id)}/content`,
    { headers: authorization(ADMIN_TOKEN) },
  );
  assert.equal(imageResponse.status, 200);
  assert.deepEqual(
    new Uint8Array(await imageResponse.arrayBuffer()),
    new Uint8Array(fixture.imageBytes),
  );
});

test("Admin adds bottles to an existing product without changing its shared facts or other bottles", async (context) => {
  const fixture = await startFixture(context);
  const original = await fixture.application.createInventoryBatch({
    as_of: "2026-08-19",
    products: [
      {
        batch_ref: "sample_product",
        name: "Sample cream",
        alias: "Sample",
        brand: "Example Lab",
        category: "Cream",
        size_label: "50 ml",
        ingredient_list_text: "Aqua, Glycerin",
        shared_notes: "Keep shared note",
      },
    ],
    inventory_items: [
      {
        batch_ref: "original_bottle",
        product_ref: { kind: "new", batch_ref: "sample_product" },
        lifecycle_status: "unopened",
        custom_notes: "Keep original bottle note",
      },
    ],
  });
  const productId = original.products[0]?.product_id;
  assert.ok(productId);
  const before = await fixture.repository.readBackupSnapshot();

  const response = await postJson(
    `${fixture.origin}/api/admin/create-inventory-batch`,
    {
      as_of: "2026-08-19",
      products: [],
      inventory_items: [
        {
          batch_ref: "additional_bottle",
          product_ref: { kind: "existing", product_id: productId },
          lifecycle_status: "unopened",
          expires_on: "2028-08-01",
          custom_notes: "Additional bottle note",
        },
      ],
    },
    ADMIN_TOKEN,
  );
  assert.equal(response.status, 200);
  const created = createInventoryBatchOutputSchema.parse(await response.json());
  assert.deepEqual(created.products, []);
  assert.equal(created.inventory_items.length, 1);
  assert.equal(created.inventory_items[0]?.product_id, productId);
  assert.equal(created.inventory_items[0]?.custom_notes, "Additional bottle note");
  const after = await fixture.repository.readBackupSnapshot();
  assert.deepEqual(after.products, before.products);
  assert.equal(after.inventoryItems.length, 2);
  assert.deepEqual(
    after.inventoryItems.filter((item) => item.id === original.inventory_items[0]?.inventory_item_id),
    before.inventoryItems,
  );
});

test("Admin rejects invalid creation batches without persisting partial products or bottles", async (context) => {
  const fixture = await startFixture(context);
  const valid = createInventoryBatchInputSchema.parse({
    as_of: "2026-08-19",
    products: [{ batch_ref: "sample_product", name: "Sample serum" }],
    inventory_items: [
      {
        batch_ref: "sample_bottle",
        product_ref: { kind: "new", batch_ref: "sample_product" },
        lifecycle_status: "unopened",
      },
    ],
  });
  const before = await fixture.repository.readBackupSnapshot();
  const invalidRequests = [
    { body: { ...valid, unexpected: true }, status: 400, code: "INVALID_INPUT" },
    {
      body: { ...valid, products: [{ ...valid.products[0], unexpected: true }] },
      status: 400,
      code: "INVALID_INPUT",
    },
    {
      body: {
        ...valid,
        inventory_items: [
          ...valid.inventory_items,
          {
            batch_ref: "invalid_bottle",
            product_ref: { kind: "existing", product_id: "missing-product", name: "Must not update shared facts" },
            lifecycle_status: "unopened",
          },
        ],
      },
      status: 400,
      code: "INVALID_INPUT",
    },
    {
      body: { ...valid, inventory_items: [{ ...valid.inventory_items[0], opened_on: "2026-08-01" }] },
      status: 400,
      code: "INVALID_INPUT",
    },
    {
      body: {
        ...valid,
        inventory_items: [
          ...valid.inventory_items,
          {
            batch_ref: "missing_product_bottle",
            product_ref: { kind: "existing", product_id: "missing-product" },
            lifecycle_status: "unopened",
          },
        ],
      },
      status: 404,
      code: "PRODUCT_NOT_FOUND",
    },
    {
      body: { ...valid, products: [{ ...valid.products[0], image_asset_id: "missing-image" }] },
      status: 404,
      code: "IMAGE_ASSET_NOT_FOUND",
    },
  ];
  for (const invalid of invalidRequests) {
    const response = await postJson(
      `${fixture.origin}/api/admin/create-inventory-batch`,
      invalid.body,
      ADMIN_TOKEN,
    );
    assert.equal(response.status, invalid.status);
    const body = (await response.json()) as { readonly error: { readonly code: string } };
    assert.equal(body.error.code, invalid.code);
    assert.deepEqual(await fixture.repository.readBackupSnapshot(), before);
  }
});

test("Admin backup round-trip restores products, bottles, notes, and original images", async (context) => {
  const fixture = await startFixture(context);
  const uploaded = await fixture.application.uploadProductImages([
    { source_ref: "backup_image", bytes: fixture.imageBytes },
  ]);
  const imageAssetId = uploaded.assets[0]?.image_asset_id;
  assert.ok(imageAssetId);
  const created = await fixture.application.createInventoryBatch({
    as_of: "2026-08-19",
    products: [
      {
        batch_ref: "backup_product",
        name: "Original backup serum",
        alias: "紫瓶",
        brand: "Beautio",
        category: "精华",
        size_label: "30 ml",
        image_asset_id: imageAssetId,
        ingredient_list_text: "Aqua, Glycerin",
        shared_notes: "Shared original note",
      },
    ],
    inventory_items: [
      {
        batch_ref: "backup_bottle",
        product_ref: { kind: "new", batch_ref: "backup_product" },
        lifecycle_status: "opened",
        opened_on: "2026-08-01",
        opened_on_accuracy: "exact",
        expires_on: "2027-08-01",
        pao_duration_months: 6,
        custom_notes: "Private bottle note",
      },
    ],
  });

  const exportResponse = await fetch(`${fixture.origin}/api/admin/backup`, {
    headers: authorization(ADMIN_TOKEN),
  });
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.headers.get("cache-control"), "no-store");
  assert.match(
    exportResponse.headers.get("content-disposition") ?? "",
    /^attachment; filename="beautio-backup-\d{4}-\d{2}-\d{2}\.beautio-backup"$/u,
  );
  const backup = (await exportResponse.json()) as BeautioBackup;
  assert.equal(backup.products[0]?.name, "Original backup serum");
  assert.equal(backup.inventory_items[0]?.custom_notes, "Private bottle note");
  assert.equal(backup.images[0]?.image_asset_id, imageAssetId);
  assert.deepEqual(
    Array.from(Buffer.from(backup.images[0]?.bytes_base64 ?? "", "base64")),
    Array.from(fixture.imageBytes),
  );

  const rejectedRestore = await putJson(
    `${fixture.origin}/api/admin/backup`,
    {
      ...backup,
      images: backup.images.map((image, index) =>
        index === 0 ? { ...image, sha256: "0".repeat(64) } : image,
      ),
    },
    ADMIN_TOKEN,
  );
  assert.equal(rejectedRestore.status, 400);
  assert.equal(
    (
      (await rejectedRestore.json()) as {
        readonly error: { readonly code: string };
      }
    ).error.code,
    "INVALID_INPUT",
  );
  assert.equal(
    (await fixture.application.listInventory({ as_of: "2026-08-19" })).items[0]
      ?.product?.name,
    "Original backup serum",
  );

  const productId = created.products[0]?.product_id;
  assert.ok(productId);
  const changed = await putJson(
    `${fixture.origin}/api/admin/products/${encodeURIComponent(productId)}`,
    {
      name: "Changed after export",
      alias: null,
      brand: null,
      category: null,
      size_label: null,
      image_asset_id: null,
      ingredient_list_text: null,
      shared_notes: null,
    },
    ADMIN_TOKEN,
  );
  assert.equal(changed.status, 200);

  const restoreResponse = await putJson(
    `${fixture.origin}/api/admin/backup`,
    backup,
    ADMIN_TOKEN,
  );
  assert.equal(restoreResponse.status, 200);
  assert.deepEqual(await restoreResponse.json(), {
    restored: true,
    products: 1,
    inventory_items: 1,
    images: 1,
  });

  const inventoryResponse = await fetch(
    `${fixture.origin}/api/inventory?as_of=2026-08-19`,
    { headers: authorization(ADMIN_TOKEN) },
  );
  const inventory = (await inventoryResponse.json()) as {
    readonly items: ReadonlyArray<{
      readonly custom_notes: string | null;
      readonly product: {
        readonly name: string;
        readonly image_asset_id: string | null;
        readonly ingredient_list_text: string | null;
        readonly shared_notes: string | null;
      };
    }>;
  };
  assert.equal(inventory.items[0]?.product.name, "Original backup serum");
  assert.equal(inventory.items[0]?.product.image_asset_id, imageAssetId);
  assert.equal(inventory.items[0]?.product.ingredient_list_text, "Aqua, Glycerin");
  assert.equal(inventory.items[0]?.product.shared_notes, "Shared original note");
  assert.equal(inventory.items[0]?.custom_notes, "Private bottle note");

  const restoredImage = await fetch(
    `${fixture.origin}/api/image-assets/${encodeURIComponent(imageAssetId)}/content`,
    { headers: authorization(ADMIN_TOKEN) },
  );
  assert.equal(restoredImage.status, 200);
  assert.deepEqual(
    Array.from(new Uint8Array(await restoredImage.arrayBuffer())),
    Array.from(fixture.imageBytes),
  );
});

test("restore excludes concurrent Admin, Custom GPT, and Codex writes until replacement completes", async (context) => {
  let blockInspection = false;
  let releaseInspection!: () => void;
  let markInspectionStarted!: () => void;
  const inspectionStarted = new Promise<void>((resolve) => {
    markInspectionStarted = resolve;
  });
  const inspectionRelease = new Promise<void>((resolve) => {
    releaseInspection = resolve;
  });
  const fixture = await startFixture(context, {
    imageInspector: {
      async inspect(bytes) {
        if (blockInspection) {
          markInspectionStarted();
          await inspectionRelease;
        }
        return sharpImageInspector.inspect(bytes);
      },
    },
  });
  const uploaded = await fixture.application.uploadProductImages([
    { source_ref: "restore_lock", bytes: fixture.imageBytes },
  ]);
  const created = await fixture.application.createInventoryBatch({
    as_of: "2026-08-19",
    products: [
      {
        batch_ref: "locked_product",
        name: "Before restore",
        image_asset_id: uploaded.assets[0]?.image_asset_id,
      },
    ],
    inventory_items: [
      {
        batch_ref: "locked_bottle",
        product_ref: { kind: "new", batch_ref: "locked_product" },
        lifecycle_status: "unopened",
      },
    ],
  });
  const productId = created.products[0]?.product_id;
  assert.ok(productId);
  const backupResponse = await fetch(`${fixture.origin}/api/admin/backup`, {
    headers: authorization(ADMIN_TOKEN),
  });
  const backup = (await backupResponse.json()) as BeautioBackup;

  blockInspection = true;
  const restore = putJson(
    `${fixture.origin}/api/admin/backup`,
    backup,
    ADMIN_TOKEN,
  );
  await inspectionStarted;
  let adminSettled = false;
  let adminCreateSettled = false;
  let customGptWriteSettled = false;
  let codexWriteSettled = false;
  const adminWrite = putJson(
    `${fixture.origin}/api/admin/products/${encodeURIComponent(productId)}`,
    {
      name: "Admin write after restore",
      alias: null,
      brand: null,
      category: null,
      size_label: null,
      image_asset_id: backup.products[0]?.image_asset_id ?? null,
      ingredient_list_text: null,
      shared_notes: null,
    },
    ADMIN_TOKEN,
  ).finally(() => {
    adminSettled = true;
  });
  const adminCreate = postJson(
    `${fixture.origin}/api/admin/create-inventory-batch`,
    {
      as_of: "2026-08-19",
      products: [{ batch_ref: "queued_admin_product", name: "Queued Admin product" }],
      inventory_items: [
        {
          batch_ref: "queued_admin_bottle",
          product_ref: { kind: "new", batch_ref: "queued_admin_product" },
          lifecycle_status: "unopened",
        },
      ],
    },
    ADMIN_TOKEN,
  ).finally(() => {
    adminCreateSettled = true;
  });
  const customGptWrite = postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    {
      as_of: "2026-08-19",
      products: [{ batch_ref: "queued_product", name: "Queued GPT product" }],
      inventory_items: [
        {
          batch_ref: "queued_bottle",
          product_ref: { kind: "new", batch_ref: "queued_product" },
          lifecycle_status: "unopened",
        },
      ],
    },
    CUSTOM_GPT_TOKEN,
  ).finally(() => {
    customGptWriteSettled = true;
  });
  const codexWrite = postJson(
    `${fixture.origin}/api/actions/codex/create-inventory-batch`,
    {
      as_of: "2026-08-19",
      products: [{ batch_ref: "queued_codex_product", name: "Queued Codex product" }],
      inventory_items: [
        {
          batch_ref: "queued_codex_bottle",
          product_ref: { kind: "new", batch_ref: "queued_codex_product" },
          lifecycle_status: "unopened",
        },
      ],
    },
    ACTION_TOKEN,
  ).finally(() => {
    codexWriteSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(adminSettled, false);
  assert.equal(adminCreateSettled, false);
  assert.equal(customGptWriteSettled, false);
  assert.equal(codexWriteSettled, false);

  releaseInspection();
  assert.equal((await restore).status, 200);
  assert.equal((await adminWrite).status, 200);
  assert.equal((await adminCreate).status, 200);
  assert.equal((await customGptWrite).status, 200);
  assert.equal((await codexWrite).status, 200);
  const inventory = (await (
    await fetch(`${fixture.origin}/api/inventory?as_of=2026-08-19`, {
      headers: authorization(ADMIN_TOKEN),
    })
  ).json()) as {
    readonly items: readonly {
      readonly product: { readonly name: string } | null;
    }[];
  };
  assert.deepEqual(
    inventory.items.map((item) => item.product?.name).sort(),
    [
      "Admin write after restore",
      "Queued Admin product",
      "Queued Codex product",
      "Queued GPT product",
    ],
  );
});

test("Action upload and batch creation share persisted state with Admin read and edits", async (context) => {
  const fixture = await startFixture(context);
  const uploadResponse = await postJson(
    `${fixture.origin}/api/actions/upload-product-images`,
    {
      openaiFileIdRefs: [
        {
          name: "confirmed-product.png",
          id: "file_confirmed_1",
          mime_type: "image/png",
          download_link: "https://files.example.test/short-lived",
        },
      ],
    },
    CUSTOM_GPT_TOKEN,
  );
  assert.equal(uploadResponse.status, 200);
  const uploadBody = (await uploadResponse.json()) as {
    readonly assets: readonly [{ readonly image_asset_id: string }];
  };
  const imageAssetId = uploadBody.assets[0].image_asset_id;

  const temporaryCard = await fetch(
    `${fixture.origin}/api/image-assets/${encodeURIComponent(imageAssetId)}/content?variant=card`,
    { headers: authorization(ADMIN_TOKEN) },
  );
  assert.equal(temporaryCard.status, 200);
  assert.equal(temporaryCard.headers.get("content-type"), "image/png");
  assert.deepEqual(
    Array.from(new Uint8Array(await temporaryCard.arrayBuffer())),
    Array.from(fixture.imageBytes),
  );

  const batchResponse = await postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    {
      as_of: "2026-08-19",
      products: [
        {
          batch_ref: "product_1",
          name: "Confirmed serum",
          alias: "Purple Jar",
          brand: "Beautio Lab",
          category: null,
          size_label: null,
          image_asset_id: imageAssetId,
          ingredient_list_text: "Aqua,\nGlycerin",
          shared_notes: "Shared Product note",
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
          custom_notes: "First bottle note",
        },
        {
          batch_ref: "bottle_2",
          product_ref: { kind: "new", batch_ref: "product_1" },
          lifecycle_status: "unopened",
          opened_on: null,
          opened_on_accuracy: null,
          expires_on: null,
          pao_duration_months: null,
          custom_notes: "Second bottle note",
        },
      ],
    },
    CUSTOM_GPT_TOKEN,
  );
  assert.equal(batchResponse.status, 200);
  const batch = (await batchResponse.json()) as {
    readonly products: readonly [{
      readonly product_id: string;
      readonly alias: string | null;
      readonly brand: string | null;
      readonly ingredient_list_text: string | null;
      readonly shared_notes: string | null;
    }];
    readonly inventory_items: readonly [
      {
        readonly inventory_item_id: string;
        readonly pao_deadline_accuracy: string;
        readonly custom_notes: string | null;
      },
      { readonly inventory_item_id: string; readonly custom_notes: string | null },
    ];
  };
  assert.equal(batch.products[0].ingredient_list_text, "Aqua,\nGlycerin");
  assert.equal(batch.products[0].alias, "Purple Jar");
  assert.equal(batch.products[0].brand, "Beautio Lab");
  assert.equal(batch.products[0].shared_notes, "Shared Product note");
  assert.equal(batch.inventory_items[0].custom_notes, "First bottle note");
  assert.equal(batch.inventory_items[1].custom_notes, "Second bottle note");
  assert.equal(batch.inventory_items[0].pao_deadline_accuracy, "estimated");
  assert.notEqual(
    batch.inventory_items[0].inventory_item_id,
    batch.inventory_items[1].inventory_item_id,
  );

  const inventoryResponse = await fetch(
    `${fixture.origin}/api/inventory?as_of=2026-08-19`,
    { headers: authorization(ADMIN_TOKEN) },
  );
  assert.equal(inventoryResponse.status, 200);
  const inventory = (await inventoryResponse.json()) as {
    readonly items: ReadonlyArray<{
      readonly custom_notes: string | null;
      readonly product: {
        readonly image_asset_id: string;
        readonly name: string;
        readonly ingredient_list_text: string | null;
        readonly shared_notes: string | null;
      };
    }>;
  };
  assert.equal(inventory.items.length, 2);
  assert.equal(inventory.items[0]?.product.image_asset_id, imageAssetId);
  assert.equal(inventory.items[0]?.product.ingredient_list_text, "Aqua,\nGlycerin");
  assert.equal(inventory.items[0]?.product.shared_notes, "Shared Product note");
  assert.deepEqual(
    inventory.items.map((item) => item.custom_notes),
    ["First bottle note", "Second bottle note"],
  );

  const privateImage = await fetch(
    `${fixture.origin}/api/image-assets/${encodeURIComponent(imageAssetId)}/content`,
    { headers: authorization(ADMIN_TOKEN) },
  );
  assert.equal(privateImage.status, 200);
  assert.equal(privateImage.headers.get("content-type"), "image/png");
  assert.deepEqual(
    Array.from(new Uint8Array(await privateImage.arrayBuffer())),
    Array.from(fixture.imageBytes),
  );

  const cardImage = await fetch(
    `${fixture.origin}/api/image-assets/${encodeURIComponent(imageAssetId)}/content?variant=card`,
    { headers: authorization(ADMIN_TOKEN) },
  );
  assert.equal(cardImage.status, 200);
  assert.equal(cardImage.headers.get("content-type"), "image/webp");
  assert.equal(cardImage.headers.get("cache-control"), "no-store");
  assert.equal(cardImage.headers.get("x-content-type-options"), "nosniff");
  const cardBytes = new Uint8Array(await cardImage.arrayBuffer());
  assert.notDeepEqual(Array.from(cardBytes), Array.from(fixture.imageBytes));
  const cardMetadata = await sharp(cardBytes).metadata();
  assert.equal(cardMetadata.format, "webp");
  assert.ok((cardMetadata.width ?? 0) < (cardMetadata.height ?? 0));

  const cachedCard = await fetch(
    `${fixture.origin}/api/image-assets/${encodeURIComponent(imageAssetId)}/content?variant=card`,
    { headers: authorization(ADMIN_TOKEN) },
  );
  assert.deepEqual(
    new Uint8Array(await cachedCard.arrayBuffer()),
    cardBytes,
  );

  for (const invalidVariant of [
    "?variant=",
    "?variant=original",
    "?variant=card&variant=card",
  ]) {
    const invalid = await fetch(
      `${fixture.origin}/api/image-assets/${encodeURIComponent(imageAssetId)}/content${invalidVariant}`,
      { headers: authorization(ADMIN_TOKEN) },
    );
    assert.equal(invalid.status, 400);
    assert.equal(
      ((await invalid.json()) as { readonly error: { readonly code: string } })
        .error.code,
      "INVALID_INPUT",
    );
  }
  assert.equal(
    (
      await fetch(
        `${fixture.origin}/api/image-assets/${encodeURIComponent(imageAssetId)}/content`,
        { headers: authorization(ACTION_TOKEN) },
      )
    ).status,
    401,
  );

  const productId = batch.products[0].product_id;
  const productUpdate = await putJson(
    `${fixture.origin}/api/admin/products/${encodeURIComponent(productId)}`,
    {
      name: "Corrected shared serum",
      alias: "Purple Jar",
      brand: "Beautio",
      category: "精华",
      size_label: "30 ml",
      image_asset_id: imageAssetId,
      ingredient_list_text: "  Aqua,\nGlycerin, Ceramide  ",
      shared_notes: "  Corrected shared note  ",
    },
    ADMIN_TOKEN,
  );
  assert.equal(productUpdate.status, 200);
  const productUpdateBody = (await productUpdate.json()) as {
    readonly product: {
      readonly alias: string | null;
      readonly brand: string | null;
      readonly ingredient_list_text: string | null;
      readonly shared_notes: string | null;
    };
  };
  assert.equal(
    productUpdateBody.product.ingredient_list_text,
    "Aqua,\nGlycerin, Ceramide",
  );
  assert.equal(productUpdateBody.product.alias, "Purple Jar");
  assert.equal(productUpdateBody.product.brand, "Beautio");
  assert.equal(productUpdateBody.product.shared_notes, "Corrected shared note");

  const customNotesUpdate = await putJson(
    `${fixture.origin}/api/admin/inventory-items/${encodeURIComponent(batch.inventory_items[1].inventory_item_id)}/custom-notes`,
    { custom_notes: "  Corrected second bottle note  " },
    ADMIN_TOKEN,
  );
  assert.equal(customNotesUpdate.status, 200);
  assert.deepEqual(await customNotesUpdate.json(), {
    inventory_item: {
      inventory_item_id: batch.inventory_items[1].inventory_item_id,
      custom_notes: "Corrected second bottle note",
    },
  });

  const itemUpdate = await putJson(
    `${fixture.origin}/api/admin/inventory-items/${encodeURIComponent(batch.inventory_items[0].inventory_item_id)}/facts`,
    {
      as_of: "2026-08-19",
      lifecycle_status: "opened",
      opened_on: "2026-08-02",
      opened_on_accuracy: "exact",
      expires_on: "2027-12-31",
      pao_duration_months: 6,
    },
    ADMIN_TOKEN,
  );
  assert.equal(itemUpdate.status, 200);
  const itemUpdateBody = (await itemUpdate.json()) as {
    readonly opened_on_accuracy: string;
    readonly pao_deadline_accuracy: string;
  };
  assert.equal(itemUpdateBody.opened_on_accuracy, "exact");
  assert.equal(itemUpdateBody.pao_deadline_accuracy, "exact");

  const after = (await (
    await fetch(`${fixture.origin}/api/inventory?as_of=2026-08-19`, {
      headers: authorization(ADMIN_TOKEN),
    })
  ).json()) as {
    readonly items: ReadonlyArray<{
      readonly custom_notes: string | null;
      readonly product: {
        readonly name: string;
        readonly ingredient_list_text: string | null;
        readonly shared_notes: string | null;
      };
    }>;
  };
  assert.deepEqual(after.items.map((item) => item.product.name), [
    "Corrected shared serum",
    "Corrected shared serum",
  ]);
  assert.deepEqual(
    after.items.map((item) => item.product.ingredient_list_text),
    ["Aqua,\nGlycerin, Ceramide", "Aqua,\nGlycerin, Ceramide"],
  );
  assert.deepEqual(
    after.items.map((item) => item.product.shared_notes),
    ["Corrected shared note", "Corrected shared note"],
  );
  assert.deepEqual(
    after.items.map((item) => item.custom_notes),
    ["First bottle note", "Corrected second bottle note"],
  );
});

test("Admin end-use route persists terminal snapshots and rejects every no-write path", async (context) => {
  const fixture = await startFixture(context);
  const openedIds = [
    "end-finished",
    "end-discarded",
    "end-discarded-unknown",
    "end-invalid",
  ] as const;
  for (const id of openedIds) {
    await fixture.repository.seedInventoryItem(
      createInventoryItem({
        id,
        lifecycleStatus: "opened",
        openedOn: "2026-08-01",
        openedOnAccuracy: "exact",
        customNotes: `note-${id}`,
      }),
    );
  }
  await fixture.repository.seedInventoryItem(
    createInventoryItem({
      id: "end-unopened",
      lifecycleStatus: "unopened",
    }),
  );

  const finishedResponse = await postJson(
    `${fixture.origin}/api/admin/inventory-items/end-finished/end-use`,
    { as_of: "2026-09-01", lifecycle_status: "finished" },
    ADMIN_TOKEN,
  );
  assert.equal(finishedResponse.status, 200);
  const finished = endInventoryItemOutputSchema.parse(
    await finishedResponse.json(),
  );
  assert.equal(finished.product_id, null);
  assert.equal(finished.lifecycle_status, "finished");
  assert.equal(finished.remaining_percent_estimate, 0);
  assert.equal(finished.custom_notes, "note-end-finished");

  const discardedResponse = await postJson(
    `${fixture.origin}/api/admin/inventory-items/end-discarded/end-use`,
    {
      as_of: "2026-09-01",
      lifecycle_status: "discarded",
      remaining_percent_estimate: 35,
    },
    ADMIN_TOKEN,
  );
  assert.equal(discardedResponse.status, 200);
  const discarded = endInventoryItemOutputSchema.parse(
    await discardedResponse.json(),
  );
  assert.equal(discarded.lifecycle_status, "discarded");
  assert.equal(discarded.remaining_percent_estimate, 35);

  const discardedUnknownResponse = await postJson(
    `${fixture.origin}/api/admin/inventory-items/end-discarded-unknown/end-use`,
    {
      as_of: "2026-09-01",
      lifecycle_status: "discarded",
      remaining_percent_estimate: null,
    },
    ADMIN_TOKEN,
  );
  assert.equal(discardedUnknownResponse.status, 200);
  assert.equal(
    endInventoryItemOutputSchema.parse(await discardedUnknownResponse.json())
      .remaining_percent_estimate,
    null,
  );

  const listedResponse = await fetch(
    `${fixture.origin}/api/inventory?as_of=2026-09-01`,
    { headers: authorization(ADMIN_TOKEN) },
  );
  assert.equal(listedResponse.status, 200);
  const listed = inventoryListOutputSchema.parse(await listedResponse.json());
  const terminalById = new Map(
    listed.items.map((item) => [item.inventory_item_id, item]),
  );
  assert.equal(terminalById.get("end-finished")?.lifecycle_status, "finished");
  assert.equal(
    terminalById.get("end-finished")?.remaining_percent_estimate,
    0,
  );
  assert.equal(
    terminalById.get("end-discarded")?.lifecycle_status,
    "discarded",
  );
  assert.equal(
    terminalById.get("end-discarded")?.remaining_percent_estimate,
    35,
  );

  const invalidBefore = await fixture.repository.findById("end-invalid");
  assert.ok(invalidBefore);
  for (const body of [
    {
      as_of: "2026-09-01",
      lifecycle_status: "discarded",
      remaining_percent_estimate: -1,
    },
    {
      as_of: "2026-09-01",
      lifecycle_status: "discarded",
      remaining_percent_estimate: 101,
    },
    {
      as_of: "2026-09-01",
      lifecycle_status: "discarded",
      remaining_percent_estimate: 12.5,
    },
    { as_of: "2026-09-01", lifecycle_status: "discarded" },
    {
      as_of: "2026-09-01",
      lifecycle_status: "finished",
      remaining_percent_estimate: 0,
    },
  ]) {
    const invalid = await postJson(
      `${fixture.origin}/api/admin/inventory-items/end-invalid/end-use`,
      body,
      ADMIN_TOKEN,
    );
    assert.equal(invalid.status, 400);
    assert.equal(
      ((await invalid.json()) as { readonly error: { readonly code: string } })
        .error.code,
      "INVALID_INPUT",
    );
  }
  assert.deepEqual(
    await fixture.repository.findById("end-invalid"),
    invalidBefore,
  );

  const unopenedBefore = await fixture.repository.findById("end-unopened");
  const unopened = await postJson(
    `${fixture.origin}/api/admin/inventory-items/end-unopened/end-use`,
    { as_of: "2026-09-01", lifecycle_status: "finished" },
    ADMIN_TOKEN,
  );
  assert.equal(unopened.status, 400);
  assert.deepEqual(
    await fixture.repository.findById("end-unopened"),
    unopenedBefore,
  );

  const finishedBeforeRepeat = await fixture.repository.findById(
    "end-finished",
  );
  assert.ok(finishedBeforeRepeat);
  const repeatedFinished = await postJson(
    `${fixture.origin}/api/admin/inventory-items/end-finished/end-use`,
    {
      as_of: "2026-09-01",
      lifecycle_status: "discarded",
      remaining_percent_estimate: 20,
    },
    ADMIN_TOKEN,
  );
  assert.equal(repeatedFinished.status, 409);
  assert.equal(
    (
      (await repeatedFinished.json()) as {
        readonly error: { readonly code: string };
      }
    ).error.code,
    "INVENTORY_ITEM_TERMINAL",
  );
  assert.deepEqual(
    await fixture.repository.findById("end-finished"),
    finishedBeforeRepeat,
  );

  const discardedBeforeRepeat = await fixture.repository.findById(
    "end-discarded",
  );
  assert.ok(discardedBeforeRepeat);
  const repeatedDiscarded = await postJson(
    `${fixture.origin}/api/admin/inventory-items/end-discarded/end-use`,
    { as_of: "2026-09-01", lifecycle_status: "finished" },
    ADMIN_TOKEN,
  );
  assert.equal(repeatedDiscarded.status, 409);
  assert.deepEqual(
    await fixture.repository.findById("end-discarded"),
    discardedBeforeRepeat,
  );

  const missing = await postJson(
    `${fixture.origin}/api/admin/inventory-items/missing-end-use/end-use`,
    { as_of: "2026-09-01", lifecycle_status: "finished" },
    ADMIN_TOKEN,
  );
  assert.equal(missing.status, 404);
  assert.equal(
    ((await missing.json()) as { readonly error: { readonly code: string } })
      .error.code,
    "INVENTORY_ITEM_NOT_FOUND",
  );
});

test("Admin custom-notes route is strict, isolated, and preserves every lifecycle fact", async (context) => {
  const fixture = await startFixture(context);
  const lifecycles: readonly LifecycleStatus[] = [
    "unopened",
    "opened",
    "finished",
    "discarded",
  ];

  for (const lifecycleStatus of lifecycles) {
    await fixture.repository.seedInventoryItem(
      createInventoryItem({
        id: `notes-${lifecycleStatus}`,
        lifecycleStatus,
        ...(lifecycleStatus === "unopened"
          ? {}
          : {
              openedOn: "2026-07-01",
              openedOnAccuracy: "exact",
              paoDurationMonths: 6,
            }),
        expiresOn: "2027-12-31",
      }),
    );
  }

  const protectedItemId = "notes-unopened";
  const beforeUnauthorized = await fixture.repository.findById(protectedItemId);
  assert.ok(beforeUnauthorized);
  for (const token of [ACTION_TOKEN, "wrong-token"]) {
    const unauthorized = await putJson(
      `${fixture.origin}/api/admin/inventory-items/${protectedItemId}/custom-notes`,
      { custom_notes: "must not persist" },
      token,
    );
    assert.equal(unauthorized.status, 401);
  }
  assert.deepEqual(
    await fixture.repository.findById(protectedItemId),
    beforeUnauthorized,
  );

  for (const invalidBody of [
    {},
    { custom_notes: "valid", lifecycle_status: "discarded" },
    { custom_notes: "x".repeat(1001) },
  ]) {
    const invalid = await putJson(
      `${fixture.origin}/api/admin/inventory-items/${protectedItemId}/custom-notes`,
      invalidBody,
      ADMIN_TOKEN,
    );
    assert.equal(invalid.status, 400);
    assert.equal(
      ((await invalid.json()) as { readonly error: { readonly code: string } })
        .error.code,
      "INVALID_INPUT",
    );
  }
  assert.deepEqual(
    await fixture.repository.findById(protectedItemId),
    beforeUnauthorized,
  );

  const missing = await putJson(
    `${fixture.origin}/api/admin/inventory-items/missing/custom-notes`,
    { custom_notes: "not found" },
    ADMIN_TOKEN,
  );
  assert.equal(missing.status, 404);
  assert.equal(
    ((await missing.json()) as { readonly error: { readonly code: string } })
      .error.code,
    "INVENTORY_ITEM_NOT_FOUND",
  );

  for (const lifecycleStatus of lifecycles) {
    const inventoryItemId = `notes-${lifecycleStatus}`;
    const before = await fixture.repository.findById(inventoryItemId);
    assert.ok(before);
    const response = await putJson(
      `${fixture.origin}/api/admin/inventory-items/${inventoryItemId}/custom-notes`,
      {
        custom_notes:
          lifecycleStatus === "discarded"
            ? "   "
            : `  note for ${lifecycleStatus}  `,
      },
      ADMIN_TOKEN,
    );
    assert.equal(response.status, 200);
    const expectedNotes =
      lifecycleStatus === "discarded" ? null : `note for ${lifecycleStatus}`;
    assert.deepEqual(await response.json(), {
      inventory_item: {
        inventory_item_id: inventoryItemId,
        custom_notes: expectedNotes,
      },
    });

    const after = await fixture.repository.findById(inventoryItemId);
    assert.ok(after);
    const { customNotes: _beforeNotes, ...beforeFacts } = before;
    const { customNotes: afterNotes, ...afterFacts } = after;
    assert.equal(afterNotes, expectedNotes);
    assert.deepEqual(afterFacts, beforeFacts);
  }
});

test("Admin multipart upload uses the same image use case", async (context) => {
  const fixture = await startFixture(context);
  const form = new FormData();
  form.set("image", new Blob([fixture.imageBytes], { type: "image/png" }), "confirmed.png");

  const response = await fetch(`${fixture.origin}/api/admin/image-assets`, {
    method: "POST",
    headers: authorization(ADMIN_TOKEN),
    body: form,
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    readonly asset: { readonly image_asset_id: string; readonly media_type: string };
  };
  assert.equal(body.asset.media_type, "image/png");
  assert.ok(body.asset.image_asset_id.length > 0);
});

test("Codex Action bridge persists uploads, reads, writes, and shared Product images remotely", async (context) => {
  const fixture = await startFixture(context);
  const batchResponse = await postJson(
    `${fixture.origin}/api/actions/codex/create-inventory-batch`,
    {
      as_of: "2026-08-19",
      products: [
        {
          batch_ref: "shared_product",
          name: "Shared Product facts stay intact",
          alias: "Shared Jar",
          brand: "Beautio Lab",
          category: "serum",
          size_label: "30 ml",
          image_asset_id: null,
        },
      ],
      inventory_items: [
        {
          batch_ref: "shared_bottle_1",
          product_ref: { kind: "new", batch_ref: "shared_product" },
          lifecycle_status: "unopened",
        },
        {
          batch_ref: "shared_bottle_2",
          product_ref: { kind: "new", batch_ref: "shared_product" },
          lifecycle_status: "unopened",
        },
      ],
    },
    ACTION_TOKEN,
  );
  assert.equal(batchResponse.status, 200);
  const batch = (await batchResponse.json()) as {
    readonly products: readonly [{ readonly product_id: string }];
    readonly inventory_items: readonly [
      { readonly inventory_item_id: string },
      { readonly inventory_item_id: string },
    ];
  };

  const uploadForm = new FormData();
  uploadForm.set(
    "confirmed_display",
    new Blob([fixture.imageBytes], { type: "image/png" }),
    "image",
  );
  const uploadResponse = await fetch(
    `${fixture.origin}/api/actions/codex/upload-product-images`,
    {
      method: "POST",
      headers: authorization(ACTION_TOKEN),
      body: uploadForm,
    },
  );
  assert.equal(uploadResponse.status, 200);
  const upload = (await uploadResponse.json()) as {
    readonly assets: readonly [
      { readonly source_ref: string; readonly image_asset_id: string },
    ];
  };
  assert.equal(upload.assets[0].source_ref, "confirmed_display");

  const setResponse = await postJson(
    `${fixture.origin}/api/actions/codex/set-product-display-image`,
    {
      product_id: batch.products[0].product_id,
      image_asset_id: upload.assets[0].image_asset_id,
    },
    ACTION_TOKEN,
  );
  assert.equal(setResponse.status, 200);
  assert.deepEqual(await setResponse.json(), {
    product: {
      product_id: batch.products[0].product_id,
      name: "Shared Product facts stay intact",
      alias: "Shared Jar",
      brand: "Beautio Lab",
      category: "serum",
      size_label: "30 ml",
      pao_duration_months: null,
      image_asset_id: upload.assets[0].image_asset_id,
      image_ref: null,
      ingredient_list_text: null,
      shared_notes: null,
    },
  });

  const firstInventoryItemId = batch.inventory_items[0].inventory_item_id;
  for (const opened_on_accuracy of [null, "legacy-guess"] as const) {
    const invalidOpeningResponse = await postJson(
      `${fixture.origin}/api/actions/codex/record-product-opened`,
      {
        inventory_item_id: firstInventoryItemId,
        opened_on: "2026-08-19",
        opened_on_accuracy,
      },
      ACTION_TOKEN,
    );
    assert.equal(invalidOpeningResponse.status, 400);
  }
  const openedResponse = await postJson(
    `${fixture.origin}/api/actions/codex/record-product-opened`,
    {
      inventory_item_id: firstInventoryItemId,
      opened_on: "2026-08-19",
    },
    ACTION_TOKEN,
  );
  assert.equal(openedResponse.status, 200);
  const openedBody = (await openedResponse.json()) as {
    readonly outcome: string;
    readonly opened_on_accuracy: string;
  };
  assert.equal(openedBody.outcome, "opened");
  assert.equal(openedBody.opened_on_accuracy, "legacy_unknown");

  const explicitLegacyResponse = await postJson(
    `${fixture.origin}/api/actions/codex/record-product-opened`,
    {
      inventory_item_id: batch.inventory_items[1].inventory_item_id,
      opened_on: "2026-08-18",
      opened_on_accuracy: "legacy_unknown",
    },
    ACTION_TOKEN,
  );
  assert.equal(explicitLegacyResponse.status, 200);
  assert.equal(
    ((await explicitLegacyResponse.json()) as {
      readonly opened_on_accuracy: string;
    }).opened_on_accuracy,
    "legacy_unknown",
  );

  const getResponse = await postJson(
    `${fixture.origin}/api/actions/codex/get-inventory-item`,
    {
      inventory_item_id: firstInventoryItemId,
      as_of: "2026-08-19",
    },
    ACTION_TOKEN,
  );
  assert.equal(getResponse.status, 200);
  assert.equal(
    ((await getResponse.json()) as { readonly opened_on: string }).opened_on,
    "2026-08-19",
  );

  const inventoryResponse = await fetch(
    `${fixture.origin}/api/inventory?as_of=2026-08-19`,
    { headers: authorization(ADMIN_TOKEN) },
  );
  assert.equal(inventoryResponse.status, 200);
  const inventory = (await inventoryResponse.json()) as {
    readonly items: ReadonlyArray<{
      readonly product: {
        readonly name: string;
        readonly image_asset_id: string | null;
      };
    }>;
  };
  assert.equal(inventory.items.length, 2);
  assert.deepEqual(
    inventory.items.map((item) => item.product.image_asset_id),
    [upload.assets[0].image_asset_id, upload.assets[0].image_asset_id],
  );
  assert.deepEqual(
    inventory.items.map((item) => item.product.name),
    ["Shared Product facts stay intact", "Shared Product facts stay intact"],
  );
});

test("Codex multipart upload enforces field, count, byte, and all-or-nothing bounds", async (context) => {
  const fixture = await startFixture(context);

  const stringForm = new FormData();
  stringForm.set("confirmed", "not-a-file");
  assert.equal(
    (
      await fetch(`${fixture.origin}/api/actions/codex/upload-product-images`, {
        method: "POST",
        headers: authorization(ACTION_TOKEN),
        body: stringForm,
      })
    ).status,
    400,
  );

  const duplicateForm = new FormData();
  duplicateForm.append("duplicate", new Blob([fixture.imageBytes]), "image-a");
  duplicateForm.append("duplicate", new Blob([fixture.imageBytes]), "image-b");
  assert.equal(
    (
      await fetch(`${fixture.origin}/api/actions/codex/upload-product-images`, {
        method: "POST",
        headers: authorization(ACTION_TOKEN),
        body: duplicateForm,
      })
    ).status,
    400,
  );

  const invalidRefForm = new FormData();
  invalidRefForm.set("not allowed", new Blob([fixture.imageBytes]), "image");
  assert.equal(
    (
      await fetch(`${fixture.origin}/api/actions/codex/upload-product-images`, {
        method: "POST",
        headers: authorization(ACTION_TOKEN),
        body: invalidRefForm,
      })
    ).status,
    400,
  );

  const tooManyForm = new FormData();
  for (let index = 0; index < 11; index += 1) {
    tooManyForm.set(
      `image_${index}`,
      new Blob([fixture.imageBytes]),
      `image-${index}`,
    );
  }
  assert.equal(
    (
      await fetch(`${fixture.origin}/api/actions/codex/upload-product-images`, {
        method: "POST",
        headers: authorization(ACTION_TOKEN),
        body: tooManyForm,
      })
    ).status,
    400,
  );

  const oversizedImageForm = new FormData();
  oversizedImageForm.set(
    "oversized",
    new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]),
    "oversized",
  );
  assert.equal(
    (
      await fetch(`${fixture.origin}/api/actions/codex/upload-product-images`, {
        method: "POST",
        headers: authorization(ACTION_TOKEN),
        body: oversizedImageForm,
      })
    ).status,
    413,
  );

  const oversizedBatchForm = new FormData();
  oversizedBatchForm.set(
    "batch_a",
    new Blob([new Uint8Array(16 * 1024 * 1024)]),
    "batch-a",
  );
  oversizedBatchForm.set(
    "batch_b",
    new Blob([new Uint8Array(16 * 1024 * 1024)]),
    "batch-b",
  );
  oversizedBatchForm.set(
    "batch_c",
    new Blob([new Uint8Array(18 * 1024 * 1024 + 1)]),
    "batch-c",
  );
  assert.equal(
    (
      await fetch(`${fixture.origin}/api/actions/codex/upload-product-images`, {
        method: "POST",
        headers: authorization(ACTION_TOKEN),
        body: oversizedBatchForm,
      })
    ).status,
    413,
  );

  const mixedValidityForm = new FormData();
  mixedValidityForm.set(
    "valid_first",
    new Blob([fixture.imageBytes]),
    "valid",
  );
  mixedValidityForm.set(
    "invalid_second",
    new Blob([Uint8Array.from([1, 2, 3])]),
    "invalid",
  );
  assert.equal(
    (
      await fetch(`${fixture.origin}/api/actions/codex/upload-product-images`, {
        method: "POST",
        headers: authorization(ACTION_TOKEN),
        body: mixedValidityForm,
      })
    ).status,
    415,
  );

  const validAfterFailureForm = new FormData();
  validAfterFailureForm.set(
    "valid_after_failure",
    new Blob([fixture.imageBytes]),
    "valid",
  );
  const validAfterFailure = await fetch(
    `${fixture.origin}/api/actions/codex/upload-product-images`,
    {
      method: "POST",
      headers: authorization(ACTION_TOKEN),
      body: validAfterFailureForm,
    },
  );
  assert.equal(validAfterFailure.status, 200);
  assert.equal(
    (
      (await validAfterFailure.json()) as {
        readonly assets: readonly [{ readonly image_asset_id: string }];
      }
    ).assets[0].image_asset_id,
    "image_asset-1",
  );
});

test("Action deadline waits for signal-ignoring inspection to settle without blocking ordinary writes", async (context) => {
  let markInspectionStarted!: () => void;
  let releaseInspection!: () => void;
  const inspectionStarted = new Promise<void>((resolve) => {
    markInspectionStarted = resolve;
  });
  const inspectionRelease = new Promise<void>((resolve) => {
    releaseInspection = resolve;
  });
  const ignoringSignalInspector: ImageInspector = {
    async inspect(bytes) {
      markInspectionStarted();
      await inspectionRelease;
      return sharpImageInspector.inspect(bytes);
    },
  };
  const fixture = await startFixture(context, {
    actionUploadTimeoutMs: 20,
    imageInspector: ignoringSignalInspector,
  });
  context.after(() => releaseInspection());
  let commitCalls = 0;
  const originalCommit = fixture.application.commitPreparedProductImages;
  fixture.application.commitPreparedProductImages = async (...args) => {
    commitCalls += 1;
    return originalCommit.apply(fixture.application, args);
  };

  let uploadSettled = false;
  const response = postJson(
    `${fixture.origin}/api/actions/upload-product-images`,
    actionUploadBody("file_deadline"),
    CUSTOM_GPT_TOKEN,
  ).finally(() => {
    uploadSettled = true;
  });
  await inspectionStarted;

  const ordinaryWrite = postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    inventoryBatchFor("during_semantic_inspection", "During semantic inspection"),
    CUSTOM_GPT_TOKEN,
  );
  assert.equal(
    await Promise.race([
      ordinaryWrite.then(() => "ordinary" as const),
      response.then(() => "upload" as const),
    ]),
    "ordinary",
  );
  assert.equal((await ordinaryWrite).status, 200);

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(uploadSettled, false);
  assert.equal(commitCalls, 0);

  releaseInspection();
  const timedOut = await response;
  assert.equal(timedOut.status, 502);
  assert.deepEqual(await timedOut.json(), actionTimeoutBody());
  assert.equal(commitCalls, 0);
  assert.equal(await fixture.repository.findImageAssetById("image_asset-3"), null);
});

test("Admin body deadline is cleared before semantic image inspection begins", async (context) => {
  let markInspectionStarted!: () => void;
  let releaseInspection!: () => void;
  const inspectionStarted = new Promise<void>((resolve) => {
    markInspectionStarted = resolve;
  });
  const inspectionRelease = new Promise<void>((resolve) => {
    releaseInspection = resolve;
  });
  const fixture = await startFixture(context, {
    writeBodyTimeoutMs: 20,
    imageInspector: {
      async inspect(bytes) {
        markInspectionStarted();
        await inspectionRelease;
        return sharpImageInspector.inspect(bytes);
      },
    },
  });
  context.after(() => releaseInspection());
  const form = new FormData();
  form.set(
    "image",
    new Blob([fixture.imageBytes], { type: "image/png" }),
    "semantic-delay.png",
  );
  let responseSettled = false;
  const response = fetch(`${fixture.origin}/api/admin/image-assets`, {
    method: "POST",
    headers: authorization(ADMIN_TOKEN),
    body: form,
  }).finally(() => {
    responseSettled = true;
  });
  await inspectionStarted;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(responseSettled, false);

  releaseInspection();
  const completed = await response;
  assert.equal(completed.status, 200);
  assert.notDeepEqual(await completed.json(), {
    error: { code: "INVALID_INPUT", message: "request body timed out" },
  });
});

test("all HTTP image entry points prepare semantics before requesting exclusive commit", async (context) => {
  const fixture = await startFixture(context);
  const options = directRouteOptions({
    actionDownloader: async (references) =>
      references.map((reference) => ({
        source_ref: reference.id,
        bytes: fixture.imageBytes,
      })),
  });
  const multipartRequest = (
    origin: string,
    path: string,
    token: string,
    field: string,
  ): Promise<Response> => {
    const form = new FormData();
    form.set(
      field,
      new Blob([fixture.imageBytes], { type: "image/png" }),
      "prepared.png",
    );
    return fetch(`${origin}${path}`, {
      method: "POST",
      headers: authorization(token),
      body: form,
    });
  };

  await assertImageUploadPreparesBeforeExclusive(
    fixture.application,
    options,
    (origin) =>
      postJson(
        `${origin}/api/actions/upload-product-images`,
        actionUploadBody("semantic_custom_gpt"),
        CUSTOM_GPT_TOKEN,
      ),
  );
  await assertImageUploadPreparesBeforeExclusive(
    fixture.application,
    options,
    (origin) =>
      multipartRequest(
        origin,
        "/api/actions/codex/upload-product-images",
        ACTION_TOKEN,
        "semantic_codex",
      ),
  );
  await assertImageUploadPreparesBeforeExclusive(
    fixture.application,
    options,
    (origin) =>
      multipartRequest(
        origin,
        "/api/admin/image-assets",
        ADMIN_TOKEN,
        "image",
      ),
  );
});

test("real 40 megapixel image inspection is serialized across concurrent HTTP preparations", async (context) => {
  const fortyMegapixelBytes = await sharp({
    create: {
      width: 8_000,
      height: 5_000,
      channels: 3,
      background: "#f4eee9",
    },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  assert.ok(fortyMegapixelBytes.byteLength < 20 * 1024 * 1024);

  let activeInspections = 0;
  let maximumActiveInspections = 0;
  let completedInspections = 0;
  let markTwoDownloadsStarted!: () => void;
  let releaseDownloads!: () => void;
  const twoDownloadsStarted = new Promise<void>((resolve) => {
    markTwoDownloadsStarted = resolve;
  });
  const downloadsRelease = new Promise<void>((resolve) => {
    releaseDownloads = resolve;
  });
  let downloadStarts = 0;
  const fixture = await startFixture(context, {
    actionUploadTimeoutMs: 20_000,
    imageInspector: {
      async inspect(bytes) {
        activeInspections += 1;
        maximumActiveInspections = Math.max(
          maximumActiveInspections,
          activeInspections,
        );
        try {
          const inspected = await sharpImageInspector.inspect(bytes);
          completedInspections += 1;
          return inspected;
        } finally {
          activeInspections -= 1;
        }
      },
    },
    actionDownloader: async (references) => {
      downloadStarts += 1;
      if (downloadStarts === 2) {
        markTwoDownloadsStarted();
      }
      await downloadsRelease;
      return references.map((reference) => ({
        source_ref: reference.id,
        bytes: fortyMegapixelBytes,
      }));
    },
  });
  context.after(() => releaseDownloads());

  const uploads = [0, 1].map((index) =>
    postJson(
      `${fixture.origin}/api/actions/upload-product-images`,
      actionUploadBody(`forty_megapixel_${index}`),
      CUSTOM_GPT_TOKEN,
    ),
  );
  await waitForMarker(twoDownloadsStarted, "two large downloads did not start");
  releaseDownloads();
  const responses = await Promise.all(uploads);
  const imageAssetIds: string[] = [];
  for (const response of responses) {
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      readonly assets: readonly [{ readonly image_asset_id: string }];
    };
    imageAssetIds.push(body.assets[0].image_asset_id);
  }
  assert.equal(completedInspections, 2);
  assert.equal(maximumActiveInspections, 1);
  assert.equal(activeInspections, 0);

  await fixture.repository.markImageAssetsForCleanup(imageAssetIds);
  const cleanup = await fixture.application.cleanupExpiredImageAssets();
  assert.equal(cleanup.deleted, 2);
  for (const imageAssetId of imageAssetIds) {
    assert.equal(await fixture.repository.findImageAssetById(imageAssetId), null);
  }
});

test("Action timeout keeps the write gate until delayed storage settles and compensates", async (context) => {
  let releasePut!: () => void;
  let markPutStarted!: () => void;
  const putStarted = new Promise<void>((resolve) => {
    markPutStarted = resolve;
  });
  const putRelease = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  const fixture = await startFixture(context, {
    actionUploadTimeoutMs: 20,
    imageStorageFactory: (directory) => {
      const underlying = new FileImageAssetStorage(directory);
      return {
        async put(storageKey, bytes, signal) {
          markPutStarted();
          await putRelease;
          await underlying.put(storageKey, bytes, signal);
        },
        get: (storageKey, signal) => underlying.get(storageKey, signal),
        delete: (storageKey) => underlying.delete(storageKey),
      };
    },
  });

  let uploadSettled = false;
  const upload = postJson(
    `${fixture.origin}/api/actions/upload-product-images`,
    {
      openaiFileIdRefs: [
        {
          name: "confirmed.png",
          id: "file_delayed_storage",
          mime_type: "image/png",
          download_link: "https://files.example.test/short-lived",
        },
      ],
    },
    CUSTOM_GPT_TOKEN,
  ).finally(() => {
    uploadSettled = true;
  });
  await putStarted;

  let queuedWriteSettled = false;
  const queuedWrite = postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    {
      as_of: "2026-08-19",
      products: [{ batch_ref: "after_upload", name: "After upload timeout" }],
      inventory_items: [
        {
          batch_ref: "after_upload_bottle",
          product_ref: { kind: "new", batch_ref: "after_upload" },
          lifecycle_status: "unopened",
        },
      ],
    },
    CUSTOM_GPT_TOKEN,
  ).finally(() => {
    queuedWriteSettled = true;
  });

  await postJsonAndAbort(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    {
      as_of: "2026-08-19",
      products: [
        { batch_ref: "aborted_after_upload", name: "Aborted queued write" },
      ],
      inventory_items: [
        {
          batch_ref: "aborted_after_upload_bottle",
          product_ref: { kind: "new", batch_ref: "aborted_after_upload" },
          lifecycle_status: "unopened",
        },
      ],
    },
    CUSTOM_GPT_TOKEN,
  );

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(uploadSettled, false);
  assert.equal(queuedWriteSettled, false);

  releasePut();
  assert.equal((await upload).status, 502);
  assert.equal((await queuedWrite).status, 200);
  assert.equal(await fixture.repository.findImageAssetById("image_asset-1"), null);
  const inventory = await fixture.application.listInventory({
    as_of: "2026-08-19",
  });
  assert.deepEqual(
    inventory.items.map((item) => item.product?.name),
    ["After upload timeout"],
  );
});

test("upload compensation retains the exclusive gate until cleanup settles", async (context) => {
  const fixture = await startFixture(context, {
    imageStorageFactory: (directory) => {
      const underlying = new FileImageAssetStorage(directory);
      return {
        async put() {
          throw new BeautioError(
            "UPLOAD_FAILED",
            "forced storage failure before compensation",
          );
        },
        get: (storageKey, signal) => underlying.get(storageKey, signal),
        delete: (storageKey) => underlying.delete(storageKey),
      };
    },
  });
  let markCompensationStarted!: () => void;
  let releaseCompensation!: () => void;
  const compensationStarted = new Promise<void>((resolve) => {
    markCompensationStarted = resolve;
  });
  const compensationRelease = new Promise<void>((resolve) => {
    releaseCompensation = resolve;
  });
  const originalMarkForCleanup = fixture.repository.markImageAssetsForCleanup;
  fixture.repository.markImageAssetsForCleanup = async (...args) => {
    markCompensationStarted();
    await compensationRelease;
    return originalMarkForCleanup.apply(fixture.repository, args);
  };

  let exclusiveTail = Promise.resolve();
  let exclusiveRequests = 0;
  let markQueuedWriteRequestedExclusive!: () => void;
  const queuedWriteRequestedExclusive = new Promise<void>((resolve) => {
    markQueuedWriteRequestedExclusive = resolve;
  });
  const dependencies = directRouteDependencies({
    withExclusiveOperation: async (operation) => {
      exclusiveRequests += 1;
      if (exclusiveRequests === 2) {
        markQueuedWriteRequestedExclusive();
      }
      let releaseTurn!: () => void;
      const previous = exclusiveTail;
      exclusiveTail = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      await previous;
      try {
        return await operation();
      } finally {
        releaseTurn();
      }
    },
  });
  const options = directRouteOptions({
    actionDownloader: async (references) =>
      references.map((reference) => ({
        source_ref: reference.id,
        bytes: fixture.imageBytes,
      })),
  });
  let createCalls = 0;
  const originalCreate = fixture.application.createInventoryBatch;
  fixture.application.createInventoryBatch = async (...args) => {
    createCalls += 1;
    return originalCreate.apply(fixture.application, args);
  };

  try {
    await withDirectRouteServer(
      fixture.application,
      dependencies,
      async (origin) => {
        let uploadSettled = false;
        const upload = postJson(
          `${origin}/api/actions/upload-product-images`,
          actionUploadBody("compensation_barrier"),
          CUSTOM_GPT_TOKEN,
        ).finally(() => {
          uploadSettled = true;
        });
        await waitForMarker(
          compensationStarted,
          "failed upload did not enter compensation",
        );

        let queuedWriteSettled = false;
        const queuedWrite = postJson(
          `${origin}/api/actions/create-inventory-batch`,
          inventoryBatchFor(
            "after_compensation",
            "After upload compensation",
          ),
          CUSTOM_GPT_TOKEN,
        ).finally(() => {
          queuedWriteSettled = true;
        });
        try {
          await waitForMarker(
            queuedWriteRequestedExclusive,
            "ordinary write did not request the exclusive gate",
          );
          assert.equal(uploadSettled, false);
          assert.equal(queuedWriteSettled, false);
          assert.equal(createCalls, 0);

          releaseCompensation();
          const failedUpload = await upload;
          assert.equal(failedUpload.status, 502);
          assert.deepEqual(await failedUpload.json(), {
            error: {
              code: "UPLOAD_FAILED",
              message: "forced storage failure before compensation",
            },
          });
          assert.equal((await queuedWrite).status, 200);
          assert.equal(createCalls, 1);
        } finally {
          releaseCompensation();
          await Promise.allSettled([upload, queuedWrite]);
        }
      },
      undefined,
      options,
    );
  } finally {
    releaseCompensation();
    fixture.repository.markImageAssetsForCleanup = originalMarkForCleanup;
    fixture.application.createInventoryBatch = originalCreate;
  }
});

test("Codex multipart deadline drains a slow request without reaching persistence", async (context) => {
  const fixture = await startFixture(context, { actionUploadTimeoutMs: 5 });
  const response = await postSlowMultipart(
    `${fixture.origin}/api/actions/codex/upload-product-images`,
    ACTION_TOKEN,
  );
  assert.equal(response.status, 502);
  assert.deepEqual(response.body, {
    error: {
      code: "UPLOAD_FAILED",
      message: "Action image upload timed out",
    },
  });
  assert.deepEqual(
    await fixture.application.listInventory({ as_of: "2026-08-19" }),
    { as_of: "2026-08-19", items: [] },
  );
});

test("a timed-out ordinary JSON body never takes the exclusive gate and closes its socket", async (context) => {
  const fixture = await startFixture(context, { writeBodyTimeoutMs: 20 });
  let createCalls = 0;
  const originalCreate = fixture.application.createInventoryBatch;
  fixture.application.createInventoryBatch = async (...args) => {
    createCalls += 1;
    return originalCreate.apply(fixture.application, args);
  };

  const slow = startPartialHttpRequest(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    "POST",
    CUSTOM_GPT_TOKEN,
    "application/json",
    '{"as_of":"2026-08-19","products":[',
  );
  await slow.started;

  const valid = postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    inventoryBatchFor("ordinary_during_slow", "Ordinary during slow body"),
    CUSTOM_GPT_TOKEN,
  );
  assert.equal(
    await Promise.race([
      valid.then(() => "valid" as const),
      slow.response.then(() => "slow" as const),
    ]),
    "valid",
  );
  assert.equal((await valid).status, 200);

  const timedOut = await slow.response;
  assert.equal(timedOut.status, 400);
  assert.equal(timedOut.headers.connection, "close");
  assert.deepEqual(timedOut.body, {
    error: { code: "INVALID_INPUT", message: "request body timed out" },
  });
  await slow.socketClosed;
  assert.equal(createCalls, 1);

  const afterTimeout = await postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    inventoryBatchFor("ordinary_after_timeout", "Ordinary after timeout"),
    CUSTOM_GPT_TOKEN,
  );
  assert.equal(afterTimeout.status, 200);
  assert.equal(createCalls, 2);
  const inventory = await fixture.application.listInventory({
    as_of: "2026-08-19",
  });
  assert.deepEqual(
    inventory.items.map((item) => item.product?.name).sort(),
    ["Ordinary after timeout", "Ordinary during slow body"],
  );
});

test("slow Admin and Codex multipart preparation cannot block ordinary writes", async (context) => {
  const fixture = await startFixture(context, {
    writeBodyTimeoutMs: 20,
    actionUploadTimeoutMs: 40,
  });
  let uploadCalls = 0;
  const originalUpload = fixture.application.commitPreparedProductImages;
  fixture.application.commitPreparedProductImages = async (...args) => {
    uploadCalls += 1;
    return originalUpload.apply(fixture.application, args);
  };

  const slowAdmin = startPartialHttpRequest(
    `${fixture.origin}/api/admin/image-assets`,
    "POST",
    ADMIN_TOKEN,
    "multipart/form-data; boundary=slow-admin-boundary",
    "--slow-admin-boundary\r\nContent-Disposition: form-data; name=\"image\"; filename=\"partial.png\"\r\nContent-Type: image/png\r\n\r\npartial",
  );
  await slowAdmin.started;
  const duringAdmin = postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    inventoryBatchFor("during_admin_multipart", "During Admin multipart"),
    CUSTOM_GPT_TOKEN,
  );
  assert.equal(
    await Promise.race([
      duringAdmin.then(() => "valid" as const),
      slowAdmin.response.then(() => "slow" as const),
    ]),
    "valid",
  );
  assert.equal((await duringAdmin).status, 200);
  const adminTimeout = await slowAdmin.response;
  assert.equal(adminTimeout.status, 400);
  assert.equal(adminTimeout.headers.connection, "close");
  assert.deepEqual(adminTimeout.body, {
    error: { code: "INVALID_INPUT", message: "request body timed out" },
  });
  await slowAdmin.socketClosed;
  assert.equal(uploadCalls, 0);

  const slowCodex = startPartialHttpRequest(
    `${fixture.origin}/api/actions/codex/upload-product-images`,
    "POST",
    ACTION_TOKEN,
    "multipart/form-data; boundary=slow-codex-boundary",
    "--slow-codex-boundary\r\nContent-Disposition: form-data; name=\"partial\"; filename=\"partial.png\"\r\nContent-Type: image/png\r\n\r\npartial",
  );
  await slowCodex.started;
  const duringCodex = postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    inventoryBatchFor("during_codex_multipart", "During Codex multipart"),
    CUSTOM_GPT_TOKEN,
  );
  assert.equal(
    await Promise.race([
      duringCodex.then(() => "valid" as const),
      slowCodex.response.then(() => "slow" as const),
    ]),
    "valid",
  );
  assert.equal((await duringCodex).status, 200);
  const codexTimeout = await slowCodex.response;
  assert.equal(codexTimeout.status, 502);
  assert.deepEqual(codexTimeout.body, {
    error: {
      code: "UPLOAD_FAILED",
      message: "Action image upload timed out",
    },
  });
  await slowCodex.socketClosed;
  assert.equal(uploadCalls, 0);
});

test("a blocked Custom GPT downloader does not take the exclusive write gate", async (context) => {
  let markDownloaderStarted!: () => void;
  let releaseDownloader!: () => void;
  const downloaderStarted = new Promise<void>((resolve) => {
    markDownloaderStarted = resolve;
  });
  const downloaderRelease = new Promise<void>((resolve) => {
    releaseDownloader = resolve;
  });
  let imageBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const fixture = await startFixture(context, {
    actionUploadTimeoutMs: 500,
    actionDownloader: async (references, _allowedHosts, signal) => {
      markDownloaderStarted();
      await downloaderRelease;
      if (signal.aborted) {
        throw signal.reason;
      }
      return references.map((reference) => ({
        source_ref: reference.id,
        bytes: imageBytes,
      }));
    },
  });
  imageBytes = fixture.imageBytes;

  const upload = postJson(
    `${fixture.origin}/api/actions/upload-product-images`,
    {
      openaiFileIdRefs: [
        {
          name: "blocked.png",
          id: "blocked_download",
          mime_type: "image/png",
          download_link: "https://files.example.test/blocked",
        },
      ],
    },
    CUSTOM_GPT_TOKEN,
  );
  await downloaderStarted;

  const ordinaryWrite = postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    inventoryBatchFor("during_downloader", "During downloader"),
    CUSTOM_GPT_TOKEN,
  );
  assert.equal(
    await Promise.race([
      ordinaryWrite.then(() => "ordinary" as const),
      upload.then(() => "upload" as const),
    ]),
    "ordinary",
  );
  assert.equal((await ordinaryWrite).status, 200);

  releaseDownloader();
  const uploadResponse = await upload;
  assert.equal(uploadResponse.status, 200);
  const uploadBody = (await uploadResponse.json()) as {
    readonly assets: readonly [{ readonly image_asset_id: string }];
  };
  assert.ok(
    await fixture.repository.findImageAssetById(
      uploadBody.assets[0].image_asset_id,
    ),
  );
});

test("timed-out Action preparation keeps both permits until signal-ignoring downloaders settle", async (context) => {
  let markTwoDownloadersStarted!: () => void;
  let markTwoDownloadersAborted!: () => void;
  const twoDownloadersStarted = new Promise<void>((resolve) => {
    markTwoDownloadersStarted = resolve;
  });
  const twoDownloadersAborted = new Promise<void>((resolve) => {
    markTwoDownloadersAborted = resolve;
  });
  const releases: Array<() => void> = [];
  const releasePromises: Promise<void>[] = [];
  const abortedDownloaders = new Set<number>();
  let downloaderStarts = 0;
  let imageBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const fixture = await startFixture(context, {
    actionUploadTimeoutMs: 30,
    actionDownloader: async (references, _allowedHosts, signal) => {
      const index = downloaderStarts;
      downloaderStarts += 1;
      let release!: () => void;
      releasePromises[index] = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases[index] = release;
      const markAborted = (): void => {
        abortedDownloaders.add(index);
        if (abortedDownloaders.size === 2) {
          markTwoDownloadersAborted();
        }
      };
      signal.addEventListener("abort", markAborted, { once: true });
      if (signal.aborted) {
        markAborted();
      }
      if (downloaderStarts === 2) {
        markTwoDownloadersStarted();
      }

      await releasePromises[index];
      signal.removeEventListener("abort", markAborted);
      return references.map((reference) => ({
        source_ref: reference.id,
        bytes: imageBytes,
      }));
    },
  });
  imageBytes = fixture.imageBytes;
  let mutationCalls = 0;
  const originalUpload = fixture.application.commitPreparedProductImages;
  fixture.application.commitPreparedProductImages = async (...args) => {
    mutationCalls += 1;
    return originalUpload.apply(fixture.application, args);
  };

  const requests = [0, 1, 2].map((index) =>
    postJson(
      `${fixture.origin}/api/actions/upload-product-images`,
      actionUploadBody(`bounded_downloader_${index}`),
      CUSTOM_GPT_TOKEN,
    ),
  );
  try {
    await waitForMarker(twoDownloadersStarted, "two downloaders did not start");
    await waitForMarker(
      twoDownloadersAborted,
      "download deadlines did not abort",
    );
    assert.equal(downloaderStarts, 2);
    assert.equal(mutationCalls, 0);

    const third = await requests[2];
    assert.ok(third);
    assert.equal(third.status, 502);
    assert.deepEqual(await third.json(), actionTimeoutBody());
    assert.equal(downloaderStarts, 2);

    releases[0]?.();
    const first = await requests[0];
    assert.ok(first);
    assert.equal(first.status, 502);
    assert.deepEqual(await first.json(), actionTimeoutBody());
    assert.equal(downloaderStarts, 2);
    assert.equal(mutationCalls, 0);

    releases[1]?.();
    const second = await requests[1];
    assert.ok(second);
    assert.equal(second.status, 502);
    assert.deepEqual(await second.json(), actionTimeoutBody());
    assert.equal(downloaderStarts, 2);
    assert.equal(mutationCalls, 0);
  } finally {
    for (const release of releases) {
      release();
    }
    await Promise.allSettled(requests);
  }
});

test("timed-out Codex multipart parsing keeps both permits until formData settles", async (context) => {
  let markTwoParsersStarted!: () => void;
  const twoParsersStarted = new Promise<void>((resolve) => {
    markTwoParsersStarted = resolve;
  });
  const releases: Array<() => void> = [];
  const releasePromises: Promise<void>[] = [];
  let parserStarts = 0;
  let mutationCalls = 0;
  const originalRequest = globalThis.Request;
  class BlockingFormDataRequest extends originalRequest {
    override readonly formData = async (): Promise<FormData> => {
      const index = parserStarts;
      parserStarts += 1;
      let release!: () => void;
      releasePromises[index] = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases[index] = release;
      if (parserStarts === 2) {
        markTwoParsersStarted();
      }
      await releasePromises[index];
      return originalRequest.prototype.formData.call(this);
    };
  }
  globalThis.Request = BlockingFormDataRequest;
  const fixture = await startFixture(context, { actionUploadTimeoutMs: 30 });
  const originalUpload = fixture.application.commitPreparedProductImages;
  fixture.application.commitPreparedProductImages = async (...args) => {
    mutationCalls += 1;
    return originalUpload.apply(fixture.application, args);
  };

  const requests: Promise<Response>[] = [];
  try {
    for (const index of [0, 1, 2]) {
      const form = new FormData();
      form.set(
        `bounded_codex_${index}`,
        new Blob([fixture.imageBytes], { type: "image/png" }),
        "image",
      );
      requests.push(
        fetch(`${fixture.origin}/api/actions/codex/upload-product-images`, {
          method: "POST",
          headers: authorization(ACTION_TOKEN),
          body: form,
        }),
      );
    }

    await waitForMarker(twoParsersStarted, "two multipart parsers did not start");
    const third = await requests[2];
    assert.ok(third);
    assert.equal(third.status, 502);
    assert.deepEqual(await third.json(), actionTimeoutBody());
    assert.equal(parserStarts, 2);
    assert.equal(mutationCalls, 0);

    releases[0]?.();
    const first = await requests[0];
    assert.ok(first);
    assert.equal(first.status, 502);
    assert.deepEqual(await first.json(), actionTimeoutBody());
    assert.equal(parserStarts, 2);
    assert.equal(mutationCalls, 0);

    releases[1]?.();
    const second = await requests[1];
    assert.ok(second);
    assert.equal(second.status, 502);
    assert.deepEqual(await second.json(), actionTimeoutBody());
    assert.equal(parserStarts, 2);
    assert.equal(mutationCalls, 0);
  } finally {
    globalThis.Request = originalRequest;
    for (const release of releases) {
      release();
    }
    await Promise.allSettled(requests);
  }
});

test("ordinary body deadline ends before an exclusive mutation begins", async (context) => {
  const fixture = await startFixture(context, { writeBodyTimeoutMs: 20 });
  let markCommitStarted!: () => void;
  let releaseCommit!: () => void;
  const commitStarted = new Promise<void>((resolve) => {
    markCommitStarted = resolve;
  });
  const commitRelease = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  const originalCreate = fixture.application.createInventoryBatch;
  fixture.application.createInventoryBatch = async (...args) => {
    markCommitStarted();
    await commitRelease;
    return originalCreate.apply(fixture.application, args);
  };

  let responseSettled = false;
  const response = postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    inventoryBatchFor("commit_after_body", "Commit after body deadline"),
    CUSTOM_GPT_TOKEN,
  ).finally(() => {
    responseSettled = true;
  });
  await commitStarted;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(responseSettled, false);

  releaseCommit();
  assert.equal((await response).status, 200);
  const inventory = await fixture.application.listInventory({
    as_of: "2026-08-19",
  });
  assert.deepEqual(
    inventory.items.map((item) => item.product?.name),
    ["Commit after body deadline"],
  );
});

test("a full write-preparation queue rejects an incomplete body and closes its socket", async (context) => {
  const fixture = await startFixture(context);
  let createCalls = 0;
  const originalCreate = fixture.application.createInventoryBatch;
  fixture.application.createInventoryBatch = async (...args) => {
    createCalls += 1;
    return originalCreate.apply(fixture.application, args);
  };
  const dependencies = directRouteDependencies({
    acquireWritePreparation: async () => {
      throw new BeautioError(
        "BATCH_CONFLICT",
        "write preparation queue is full; retry later",
      );
    },
  });

  await withDirectRouteServer(
    fixture.application,
    dependencies,
    async (origin) => {
      const rejected = startPartialHttpRequest(
        `${origin}/api/actions/create-inventory-batch`,
        "POST",
        CUSTOM_GPT_TOKEN,
        "application/json",
        '{"as_of":"2026-08-19","products":[',
      );
      await rejected.started;
      const response = await rejected.response;
      assert.equal(response.status, 409);
      assert.equal(response.headers.connection, "close");
      assert.deepEqual(response.body, {
        error: {
          code: "BATCH_CONFLICT",
          message: "write preparation queue is full; retry later",
        },
      });
      await rejected.socketClosed;
    },
  );
  assert.equal(createCalls, 0);
});

test("a complete unread body is drained before its preparation failure keeps the connection reusable", async (context) => {
  const fixture = await startFixture(context);
  let incomingRequest: IncomingMessage | undefined;
  let observedCompleteUnread = false;
  let createCalls = 0;
  const originalCreate = fixture.application.createInventoryBatch;
  fixture.application.createInventoryBatch = async (...args) => {
    createCalls += 1;
    return originalCreate.apply(fixture.application, args);
  };
  const dependencies = directRouteDependencies({
    acquireWritePreparation: async () => {
      while (incomingRequest?.complete !== true) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      observedCompleteUnread = !incomingRequest.readableEnded;
      throw new BeautioError(
        "BATCH_CONFLICT",
        "write preparation queue is full; retry later",
      );
    },
  });

  await withDirectRouteServer(
    fixture.application,
    dependencies,
    async (origin) => {
      const response = await postJson(
        `${origin}/api/actions/create-inventory-batch`,
        {},
        CUSTOM_GPT_TOKEN,
      );
      assert.equal(response.status, 409);
      assert.notEqual(response.headers.get("connection"), "close");
      assert.equal(observedCompleteUnread, true);
      for (
        let attempt = 0;
        attempt < 100 && incomingRequest?.readableEnded !== true;
        attempt += 1
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(incomingRequest?.readableEnded, true);
    },
    (request) => {
      incomingRequest = request;
    },
  );
  assert.equal(createCalls, 0);
});

test("ordinary mutation routes finish preparation before entering their exclusive commit", async (context) => {
  const fixture = await startFixture(context);
  const uploaded = await fixture.application.uploadProductImages([
    { source_ref: "exclusive_matrix", bytes: fixture.imageBytes },
  ]);
  const imageAssetId = uploaded.assets[0]?.image_asset_id;
  assert.ok(imageAssetId);
  const seeded = await fixture.application.createInventoryBatch({
    as_of: "2026-08-19",
    products: [
      {
        batch_ref: "exclusive_product",
        name: "Exclusive route product",
      },
    ],
    inventory_items: [
      {
        batch_ref: "record_open_target",
        product_ref: { kind: "new", batch_ref: "exclusive_product" },
        lifecycle_status: "unopened",
      },
      {
        batch_ref: "facts_target",
        product_ref: { kind: "new", batch_ref: "exclusive_product" },
        lifecycle_status: "opened",
        opened_on: "2026-08-01",
        opened_on_accuracy: "exact",
      },
      {
        batch_ref: "end_target",
        product_ref: { kind: "new", batch_ref: "exclusive_product" },
        lifecycle_status: "opened",
        opened_on: "2026-08-02",
        opened_on_accuracy: "exact",
      },
      {
        batch_ref: "notes_target",
        product_ref: { kind: "new", batch_ref: "exclusive_product" },
        lifecycle_status: "unopened",
      },
    ],
  });
  const productId = seeded.products[0]?.product_id;
  const recordOpenId = seeded.inventory_items[0]?.inventory_item_id;
  const factsId = seeded.inventory_items[1]?.inventory_item_id;
  const endId = seeded.inventory_items[2]?.inventory_item_id;
  const notesId = seeded.inventory_items[3]?.inventory_item_id;
  assert.ok(productId);
  assert.ok(recordOpenId);
  assert.ok(factsId);
  assert.ok(endId);
  assert.ok(notesId);

  let calls = 0;
  const originalRecordOpened = fixture.application.recordProductOpened;
  fixture.application.recordProductOpened = async (...args) => {
    calls += 1;
    return originalRecordOpened.apply(fixture.application, args);
  };
  await assertRequestWaitsForExclusive(
    fixture.application,
    (origin) =>
      postJson(
        `${origin}/api/actions/codex/record-product-opened`,
        {
          inventory_item_id: recordOpenId,
          opened_on: "2026-08-19",
          opened_on_accuracy: "exact",
        },
        ACTION_TOKEN,
      ),
    () => calls,
  );
  fixture.application.recordProductOpened = originalRecordOpened;

  calls = 0;
  const originalSetImage = fixture.application.setProductDisplayImage;
  fixture.application.setProductDisplayImage = async (...args) => {
    calls += 1;
    return originalSetImage.apply(fixture.application, args);
  };
  await assertRequestWaitsForExclusive(
    fixture.application,
    (origin) =>
      postJson(
        `${origin}/api/actions/codex/set-product-display-image`,
        { product_id: productId, image_asset_id: imageAssetId },
        ACTION_TOKEN,
      ),
    () => calls,
  );
  fixture.application.setProductDisplayImage = originalSetImage;

  calls = 0;
  const originalCommitUpload = fixture.application.commitPreparedProductImages;
  fixture.application.commitPreparedProductImages = async (...args) => {
    calls += 1;
    return originalCommitUpload.apply(fixture.application, args);
  };
  await assertRequestWaitsForExclusive(
    fixture.application,
    async (origin) => {
      const form = new FormData();
      form.set(
        "image",
        new Blob([fixture.imageBytes], { type: "image/png" }),
        "exclusive.png",
      );
      return fetch(`${origin}/api/admin/image-assets`, {
        method: "POST",
        headers: authorization(ADMIN_TOKEN),
        body: form,
      });
    },
    () => calls,
  );
  fixture.application.commitPreparedProductImages = originalCommitUpload;

  calls = 0;
  const originalUpdateFacts = fixture.application.updateInventoryItemFacts;
  fixture.application.updateInventoryItemFacts = async (...args) => {
    calls += 1;
    return originalUpdateFacts.apply(fixture.application, args);
  };
  await assertRequestWaitsForExclusive(
    fixture.application,
    (origin) =>
      putJson(
        `${origin}/api/admin/inventory-items/${encodeURIComponent(factsId)}/facts`,
        {
          as_of: "2026-08-19",
          lifecycle_status: "opened",
          opened_on: "2026-08-03",
          opened_on_accuracy: "exact",
          expires_on: "2027-08-03",
          pao_duration_months: 6,
        },
        ADMIN_TOKEN,
      ),
    () => calls,
  );
  fixture.application.updateInventoryItemFacts = originalUpdateFacts;

  calls = 0;
  const originalEndUse = fixture.application.endInventoryItem;
  fixture.application.endInventoryItem = async (...args) => {
    calls += 1;
    return originalEndUse.apply(fixture.application, args);
  };
  await assertRequestWaitsForExclusive(
    fixture.application,
    (origin) =>
      postJson(
        `${origin}/api/admin/inventory-items/${encodeURIComponent(endId)}/end-use`,
        { as_of: "2026-08-19", lifecycle_status: "finished" },
        ADMIN_TOKEN,
      ),
    () => calls,
  );
  fixture.application.endInventoryItem = originalEndUse;

  calls = 0;
  const originalCustomNotes = fixture.application.updateInventoryItemCustomNotes;
  fixture.application.updateInventoryItemCustomNotes = async (...args) => {
    calls += 1;
    return originalCustomNotes.apply(fixture.application, args);
  };
  await assertRequestWaitsForExclusive(
    fixture.application,
    (origin) =>
      putJson(
        `${origin}/api/admin/inventory-items/${encodeURIComponent(notesId)}/custom-notes`,
        { custom_notes: "Prepared before commit" },
        ADMIN_TOKEN,
      ),
    () => calls,
  );
  fixture.application.updateInventoryItemCustomNotes = originalCustomNotes;
});

test("backup restore body timeout aborts the request and releases the exclusive gate", async (context) => {
  const fixture = await startFixture(context, { backupOperationTimeoutMs: 20 });

  const timedOut = await putSlowJson(
    `${fixture.origin}/api/admin/backup`,
    ADMIN_TOKEN,
  );
  assert.equal(timedOut.status, 502);
  assert.deepEqual(timedOut.body, {
    error: { code: "UPLOAD_FAILED", message: "backup operation timed out" },
  });

  const nextWrite = await postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    {
      as_of: "2026-08-19",
      products: [{ batch_ref: "after_timeout", name: "After timeout" }],
      inventory_items: [
        {
          batch_ref: "after_timeout_bottle",
          product_ref: { kind: "new", batch_ref: "after_timeout" },
          lifecycle_status: "unopened",
        },
      ],
    },
    CUSTOM_GPT_TOKEN,
  );
  assert.equal(nextWrite.status, 200);
});

test("a slow backup upload does not hold the exclusive write gate", async (context) => {
  const fixture = await startFixture(context, { backupOperationTimeoutMs: 200 });
  const slowRestore = putSlowJson(
    `${fixture.origin}/api/admin/backup`,
    ADMIN_TOKEN,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  const nextWrite = await Promise.race([
    postJson(
      `${fixture.origin}/api/actions/create-inventory-batch`,
      {
        as_of: "2026-08-19",
        products: [{ batch_ref: "during_upload", name: "During backup upload" }],
        inventory_items: [
          {
            batch_ref: "during_upload_bottle",
            product_ref: { kind: "new", batch_ref: "during_upload" },
            lifecycle_status: "unopened",
          },
        ],
      },
      CUSTOM_GPT_TOKEN,
    ),
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error("write was blocked by the backup request body")),
        100,
      ),
    ),
  ]);
  assert.equal(nextWrite.status, 200);

  const timedOut = await slowRestore;
  assert.equal(timedOut.status, 502);
  assert.deepEqual(timedOut.body, {
    error: { code: "UPLOAD_FAILED", message: "backup operation timed out" },
  });
});

test("timed-out backup inspection releases restore while retaining the shared inspector slot", async (context) => {
  let blockNextInspection = false;
  let inspectionCalls = 0;
  let markBlockedInspectionStarted!: () => void;
  let releaseBlockedInspection!: () => void;
  let markNextUploadInspectionStarted!: () => void;
  const blockedInspectionStarted = new Promise<void>((resolve) => {
    markBlockedInspectionStarted = resolve;
  });
  const blockedInspectionRelease = new Promise<void>((resolve) => {
    releaseBlockedInspection = resolve;
  });
  const nextUploadInspectionStarted = new Promise<void>((resolve) => {
    markNextUploadInspectionStarted = resolve;
  });
  const fixture = await startFixture(context, {
    backupOperationTimeoutMs: 20,
    imageInspector: {
      async inspect(bytes) {
        inspectionCalls += 1;
        if (blockNextInspection) {
          blockNextInspection = false;
          markBlockedInspectionStarted();
          await blockedInspectionRelease;
        } else if (inspectionCalls === 3) {
          markNextUploadInspectionStarted();
        }
        return sharpImageInspector.inspect(bytes);
      },
    },
  });
  context.after(() => releaseBlockedInspection());
  const uploaded = await fixture.application.uploadProductImages([
    { source_ref: "deadline_restore", bytes: fixture.imageBytes },
  ]);
  assert.equal(inspectionCalls, 1);
  await fixture.application.createInventoryBatch({
    as_of: "2026-08-19",
    products: [
      {
        batch_ref: "before_deadline",
        name: "Before deadline restore",
        image_asset_id: uploaded.assets[0]?.image_asset_id,
      },
    ],
    inventory_items: [
      {
        batch_ref: "before_deadline_bottle",
        product_ref: { kind: "new", batch_ref: "before_deadline" },
        lifecycle_status: "unopened",
      },
    ],
  });
  const backup = (await (
    await fetch(`${fixture.origin}/api/admin/backup`, {
      headers: authorization(ADMIN_TOKEN),
    })
  ).json()) as BeautioBackup;

  blockNextInspection = true;
  const restore = putJson(
    `${fixture.origin}/api/admin/backup`,
    backup,
    ADMIN_TOKEN,
  );
  await waitForMarker(
    blockedInspectionStarted,
    "backup image inspection did not start",
  );
  const timedOut = await restore;
  assert.equal(timedOut.status, 502);
  assert.deepEqual(await timedOut.json(), {
    error: { code: "UPLOAD_FAILED", message: "backup operation timed out" },
  });
  assert.equal(inspectionCalls, 2);

  const nextWrite = await postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    {
      as_of: "2026-08-19",
      products: [{ batch_ref: "after_restore_timeout", name: "After restore timeout" }],
      inventory_items: [
        {
          batch_ref: "after_restore_timeout_bottle",
          product_ref: { kind: "new", batch_ref: "after_restore_timeout" },
          lifecycle_status: "unopened",
        },
      ],
    },
    CUSTOM_GPT_TOKEN,
  );
  assert.equal(nextWrite.status, 200);

  let markUploadPreparationStarted!: () => void;
  const uploadPreparationStarted = new Promise<void>((resolve) => {
    markUploadPreparationStarted = resolve;
  });
  const originalPrepare = fixture.application.prepareProductImages;
  fixture.application.prepareProductImages = (...args) => {
    const preparation = originalPrepare.apply(fixture.application, args);
    markUploadPreparationStarted();
    return preparation;
  };
  let nextUploadSettled = false;
  const nextUpload = postJson(
    `${fixture.origin}/api/actions/upload-product-images`,
    actionUploadBody("after_timed_out_restore"),
    CUSTOM_GPT_TOKEN,
  ).finally(() => {
    nextUploadSettled = true;
  });
  await waitForMarker(
    uploadPreparationStarted,
    "new image upload did not enter semantic preparation",
  );
  assert.equal(inspectionCalls, 2);
  assert.equal(nextUploadSettled, false);

  releaseBlockedInspection();
  await waitForMarker(
    nextUploadInspectionStarted,
    "new image upload did not acquire the released inspector slot",
  );
  assert.equal(inspectionCalls, 3);
  const nextUploadResponse = await nextUpload;
  assert.equal(nextUploadResponse.status, 200);
  fixture.application.prepareProductImages = originalPrepare;

  const inventory = await fixture.application.listInventory({ as_of: "2026-08-19" });
  assert.deepEqual(
    inventory.items.map((item) => item.product?.name).sort(),
    ["After restore timeout", "Before deadline restore"],
  );
  const originalAsset = await fixture.repository.findImageAssetById(
    uploaded.assets[0]?.image_asset_id ?? "missing",
  );
  assert.equal(originalAsset?.status, "linked");
});

test("backup deadline does not hide a non-abort failure that settles later", async (context) => {
  let failWrites = false;
  const fixture = await startFixture(context, {
    backupOperationTimeoutMs: 20,
    imageStorageFactory: (directory) => {
      const underlying = new FileImageAssetStorage(directory);
      return {
        async put(storageKey, bytes, signal) {
          if (failWrites) {
            await new Promise((resolve) => setTimeout(resolve, 35));
            throw new BeautioError(
              "UNSUPPORTED_MEDIA_TYPE",
              "late backup image validation failure",
            );
          }
          await underlying.put(storageKey, bytes, signal);
        },
        get: (storageKey, signal) => underlying.get(storageKey, signal),
        delete: (storageKey) => underlying.delete(storageKey),
      };
    },
  });
  const uploaded = await fixture.application.uploadProductImages([
    { source_ref: "late_failure", bytes: fixture.imageBytes },
  ]);
  await fixture.application.createInventoryBatch({
    as_of: "2026-08-19",
    products: [
      {
        batch_ref: "late_failure_product",
        name: "Late failure product",
        image_asset_id: uploaded.assets[0]?.image_asset_id,
      },
    ],
    inventory_items: [
      {
        batch_ref: "late_failure_bottle",
        product_ref: { kind: "new", batch_ref: "late_failure_product" },
        lifecycle_status: "unopened",
      },
    ],
  });
  const backup = (await (
    await fetch(`${fixture.origin}/api/admin/backup`, {
      headers: authorization(ADMIN_TOKEN),
    })
  ).json()) as BeautioBackup;

  failWrites = true;
  const response = await putJson(
    `${fixture.origin}/api/admin/backup`,
    backup,
    ADMIN_TOKEN,
  );
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "late backup image validation failure",
    },
  });
});

test("shared Product PAO is inherited and updates per-bottle deadlines through Admin HTTP", async (context) => {
  const fixture = await startFixture(context);
  const createdResponse = await postJson(`${fixture.origin}/api/admin/create-inventory-batch`, {
    as_of: "2026-03-01",
    products: [{ batch_ref: "shared_pao", name: "Shared PAO test", pao_duration_months: 6 }],
    inventory_items: ["2026-01-01", "2026-02-01"].map((openedOn, index) => ({
      batch_ref: `bottle_${index}`,
      product_ref: { kind: "new", batch_ref: "shared_pao" },
      lifecycle_status: "opened",
      opened_on: openedOn,
      opened_on_accuracy: "exact",
      expires_on: "2026-11-01",
    })),
  }, ADMIN_TOKEN);
  assert.equal(createdResponse.status, 200);
  const created = createInventoryBatchOutputSchema.parse(await createdResponse.json());
  const product = created.products[0];
  assert.ok(product);
  assert.equal(product.pao_duration_months, 6);
  assert.deepEqual(created.inventory_items.map((item) => item.pao_deadline), ["2026-07-01", "2026-08-01"]);

  const edited = await putJson(`${fixture.origin}/api/admin/products/${product.product_id}`, {
    name: product.name, category: null, size_label: null,
    image_asset_id: null, ingredient_list_text: null, shared_notes: null,
    pao_duration_months: 12,
  }, ADMIN_TOKEN);
  assert.equal(edited.status, 200);
  const readback = await fixture.application.listInventory({ as_of: "2026-03-01" });
  assert.deepEqual(readback.items.map((item) => item.pao_duration_months), [12, 12]);
  assert.deepEqual(readback.items.map((item) => item.pao_deadline).sort(), ["2027-01-01", "2027-02-01"]);
  assert.ok(readback.items.every((item) => item.usable_until === "2026-11-01"));
  assert.ok(readback.items.every((item) => item.product?.pao_duration_months === 12));

  const existingBottle = {
    batch_ref: "added_bottle", product_ref: { kind: "existing", product_id: product.product_id },
    lifecycle_status: "unopened",
  };
  const inherited = await postJson(`${fixture.origin}/api/actions/create-inventory-batch`, {
    as_of: "2026-03-01", products: [], inventory_items: [existingBottle],
  }, CUSTOM_GPT_TOKEN);
  assert.equal(inherited.status, 200);
  assert.equal(createInventoryBatchOutputSchema.parse(await inherited.json()).inventory_items[0]?.pao_duration_months, 12);

  const conflicting = await postJson(`${fixture.origin}/api/actions/create-inventory-batch`, {
    as_of: "2026-03-01", products: [], inventory_items: [{ ...existingBottle, pao_duration_months: 6 }],
  }, CUSTOM_GPT_TOKEN);
  assert.equal(conflicting.status, 400);
  assert.match(JSON.stringify(await conflicting.json()), /PAO|pao/u);
  assert.equal((await fixture.application.listInventory({ as_of: "2026-03-01" })).items.length, 3);
});

test("HTTP maps strict batch errors and serves versioned Actions OpenAPI", async (context) => {
  const fixture = await startFixture(context);
  const jsonp = await fetch(
    `${fixture.origin}/api/actions/codex/get-inventory-item`,
    {
      method: "POST",
      headers: {
        ...authorization(ACTION_TOKEN),
        "content-type": "application/jsonp",
      },
      body: JSON.stringify({
        inventory_item_id: "missing",
        as_of: "2026-08-19",
      }),
    },
  );
  assert.equal(jsonp.status, 400);

  const invalid = await postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    { ...emptyBatch(), unexpected: true },
    CUSTOM_GPT_TOKEN,
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: {
      code: "INVALID_INPUT",
      message: "input does not match the tool contract",
    },
  });

  const oversizedAlias = await postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    {
      as_of: "2026-08-19",
      products: [
        {
          batch_ref: "product_alias_limit",
          name: "Serum",
          alias: "紫".repeat(11),
        },
      ],
      inventory_items: [
        {
          batch_ref: "bottle_alias_limit",
          product_ref: { kind: "new", batch_ref: "product_alias_limit" },
          lifecycle_status: "unopened",
        },
      ],
    },
    CUSTOM_GPT_TOKEN,
  );
  assert.equal(oversizedAlias.status, 400);
  assert.deepEqual(await oversizedAlias.json(), {
    error: {
      code: "INVALID_INPUT",
      message: "alias must be at most 10 characters",
    },
  });
  assert.deepEqual(
    await fixture.application.listInventory({ as_of: "2026-08-19" }),
    { as_of: "2026-08-19", items: [] },
  );

  const openapi = await fetch(`${fixture.origin}/openapi/beautio-actions-v1.json`, {
    headers: authorization(CUSTOM_GPT_TOKEN),
  });
  assert.equal(openapi.status, 200);
  const openapiBody = (await openapi.json()) as {
    readonly paths: object;
    readonly servers?: unknown;
  };
  assert.equal(Object.keys(openapiBody.paths).length, 2);
  assert.equal(openapiBody.servers, undefined);
});

test("maximum legal confirmed text batch stays within the existing one MiB JSON boundary", async (context) => {
  const fixture = await startFixture(context);
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
  const requestBody = JSON.stringify({
    as_of: "2026-08-19",
    products,
    inventory_items: inventoryItems,
  });
  assert.ok(Buffer.byteLength(requestBody) < 1024 * 1024);

  const response = await fetch(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    {
      method: "POST",
      headers: {
        ...authorization(CUSTOM_GPT_TOKEN),
        "content-type": "application/json",
      },
      body: requestBody,
    },
  );
  assert.equal(response.status, 200);
  const responseText = await response.text();
  assert.ok(Buffer.byteLength(responseText) < 1024 * 1024);
  const output = JSON.parse(responseText) as {
    readonly products: ReadonlyArray<{
      readonly ingredient_list_text: string | null;
      readonly shared_notes: string | null;
    }>;
    readonly inventory_items: ReadonlyArray<{
      readonly custom_notes: string | null;
    }>;
  };
  assert.equal(output.products.length, 25);
  assert.equal(output.inventory_items.length, 100);
  assert.equal(output.products[24]?.ingredient_list_text?.length, 5000);
  assert.equal(output.products[24]?.shared_notes?.length, 1000);
  assert.equal(output.inventory_items[99]?.custom_notes?.length, 1000);
});

test("optional production web root stays same-origin without shadowing API or OpenAPI", async (context) => {
  const fixture = await startFixture(context, {
    serveWeb: true,
    publicOrigin: "https://beautio.example.test/",
  });

  const page = await fetch(`${fixture.origin}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(page.headers.get("cache-control"), "no-cache");
  assert.equal(await page.text(), "<!doctype html><title>Beautio production</title>\n");

  const scriptHead = await fetch(
    `${fixture.origin}/assets/app-12345678.js`,
    { method: "HEAD" },
  );
  assert.equal(scriptHead.status, 200);
  assert.equal(
    scriptHead.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(
    scriptHead.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  assert.equal(
    scriptHead.headers.get("content-length"),
    String(Buffer.byteLength(STATIC_SCRIPT)),
  );
  assert.equal(await scriptHead.text(), "");

  const script = await fetch(`${fixture.origin}/assets/app-12345678.js`);
  assert.equal(await script.text(), STATIC_SCRIPT);

  const health = await fetch(`${fixture.origin}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", mode: "managed" });
  assert.equal((await fetch(`${fixture.origin}/api`)).status, 401);
  assert.equal((await fetch(`${fixture.origin}/openapi`)).status, 404);

  assert.equal(
    (await fetch(`${fixture.origin}/openapi/beautio-actions-v1.json`)).status,
    401,
  );
  const openapi = await fetch(
    `${fixture.origin}/openapi/beautio-actions-v1.json`,
    { headers: authorization(CUSTOM_GPT_TOKEN) },
  );
  const openapiBody = (await openapi.json()) as {
    readonly servers: readonly [{ readonly url: string }];
  };
  assert.deepEqual(openapiBody.servers, [
    { url: "https://beautio.example.test" },
  ]);

  for (const rejectedPath of [
    "/assets/escape.txt",
    "/assets%2Fapp-12345678.js",
    "/.env",
    "/%2e%2e%2foutside.txt",
    "/%61pi/health",
    "/%6fpenapi/beautio-actions-v1.json",
    "/missing.txt",
  ]) {
    const response = await fetch(`${fixture.origin}${rejectedPath}`);
    assert.equal(response.status, 404, rejectedPath);
    assert.deepEqual(await response.json(), {
      error: { code: "INVALID_INPUT", message: "Route not found." },
    });
  }
});

interface Fixture {
  readonly origin: string;
  readonly application: InventoryApplicationService;
  readonly repository: SqliteInventoryRepository;
  readonly imageBytes: Uint8Array;
}

interface FixtureOptions {
  readonly actionUploadTimeoutMs?: number;
  readonly backupOperationTimeoutMs?: number;
  readonly writeBodyTimeoutMs?: number;
  readonly actionDownloader?: NonNullable<
    CoreApiHandlerOptions["actionDownloader"]
  >;
  readonly imageInspector?: ImageInspector;
  readonly imageStorageFactory?: (directory: string) => ImageAssetStorage;
  readonly publicOrigin?: string;
  readonly serveWeb?: boolean;
}

async function startFixture(
  context: TestContext,
  options: FixtureOptions = {},
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "beautio-http-"));
  const webRoot =
    options.serveWeb === true
      ? await createStaticWebFixture(directory)
      : undefined;
  const repository = new SqliteInventoryRepository(join(directory, "inventory.sqlite"));
  const imageSubject = await sharp({
    create: {
      width: 120,
      height: 270,
      channels: 3,
      background: "#d7a9b9",
    },
  })
    .png()
    .toBuffer();
  const imageBytes = await sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([{ input: imageSubject, left: 140, top: 30 }])
    .png()
    .toBuffer();
  let nextId = 0;
  const application = new InventoryApplicationService(repository, {
    idGenerator: (kind) => `${kind}-${++nextId}`,
    clock: () => new Date("2026-08-19T00:00:00.000Z"),
    imageStorage:
      options.imageStorageFactory?.(join(directory, "images")) ??
      new FileImageAssetStorage(join(directory, "images")),
    imageInspector: options.imageInspector ?? sharpImageInspector,
    imageRenditions: new FileImageRenditionProvider(join(directory, "images")),
  });
  const server = createServer(
    createCoreApiHandler(application, {
      customGptBearerToken: CUSTOM_GPT_TOKEN,
      actionBearerToken: ACTION_TOKEN,
      adminBearerToken: ADMIN_TOKEN,
      actionFileHosts: new Set(["files.example.test"]),
      actionDownloader:
        options.actionDownloader ??
        (async (references) =>
          references.map((reference) => ({
            source_ref: reference.id,
            bytes: imageBytes,
          }))),
      ...(options.actionUploadTimeoutMs === undefined
        ? {}
        : { actionUploadTimeoutMs: options.actionUploadTimeoutMs }),
      ...(options.backupOperationTimeoutMs === undefined
        ? {}
        : { backupOperationTimeoutMs: options.backupOperationTimeoutMs }),
      ...(options.writeBodyTimeoutMs === undefined
        ? {}
        : { writeBodyTimeoutMs: options.writeBodyTimeoutMs }),
      ...(options.publicOrigin === undefined
        ? {}
        : { publicOrigin: options.publicOrigin }),
      ...(webRoot === undefined ? {} : { webRoot }),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await closeServer(server);
    repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    application,
    repository,
    imageBytes,
  };
}

function emptyBatch(): object {
  return {
    as_of: "2026-08-19",
    products: [],
    inventory_items: [
      {
        batch_ref: "missing_bottle",
        product_ref: { kind: "existing", product_id: "missing-product" },
        lifecycle_status: "unopened",
      },
    ],
  };
}

function inventoryBatchFor(batchRef: string, name: string): object {
  return {
    as_of: "2026-08-19",
    products: [{ batch_ref: batchRef, name }],
    inventory_items: [
      {
        batch_ref: `${batchRef}_bottle`,
        product_ref: { kind: "new", batch_ref: batchRef },
        lifecycle_status: "unopened",
      },
    ],
  };
}

function actionUploadBody(sourceRef: string): object {
  return {
    openaiFileIdRefs: [
      {
        name: `${sourceRef}.png`,
        id: sourceRef,
        mime_type: "image/png",
        download_link: `https://files.example.test/${sourceRef}`,
      },
    ],
  };
}

function actionTimeoutBody(): object {
  return {
    error: {
      code: "UPLOAD_FAILED",
      message: "Action image upload timed out",
    },
  };
}

function waitForMarker(marker: Promise<void>, message: string): Promise<void> {
  return Promise.race([
    marker,
    new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(message)), 1_000);
      marker.finally(() => clearTimeout(timeout)).catch(() => undefined);
    }),
  ]);
}

function authorization(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function postJson(url: string, body: object, token: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { ...authorization(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postJsonAndAbort(
  url: string,
  body: object,
  token: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = makeHttpRequest(url, {
      method: "POST",
      headers: {
        ...authorization(token),
        "content-length": String(Buffer.byteLength(payload)),
        "content-type": "application/json",
      },
    });
    request.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET") {
        resolve();
        return;
      }
      reject(error);
    });
    request.end(payload, () => {
      setTimeout(() => {
        request.destroy();
        resolve();
      }, 10);
    });
  });
}

function putJson(url: string, body: object, token: string): Promise<Response> {
  return fetch(url, {
    method: "PUT",
    headers: { ...authorization(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function directRouteOptions(
  overrides: Partial<ValidatedOptions> = {},
): ValidatedOptions {
  return {
    customGptBearerToken: CUSTOM_GPT_TOKEN,
    actionBearerToken: ACTION_TOKEN,
    adminBearerToken: ADMIN_TOKEN,
    actionFileHosts: new Set(["files.example.test"]),
    actionDownloader: async () => [],
    actionUploadTimeoutMs: 500,
    backupOperationTimeoutMs: 500,
    writeBodyTimeoutMs: 500,
    publicOrigin: undefined,
    staticWebRoot: null,
    readOnlyMcp: null,
    customGptReadRoute: null,
    customGptFactActionRoute: null,
    ...overrides,
  };
}

function directRouteDependencies(
  overrides: Partial<RouteRequestDependencies> = {},
): RouteRequestDependencies {
  return {
    withActionUploadDeadline: async (_timeoutMs, signal, operation) =>
      operation(signal),
    acquireWritePreparation: async () => ({ release: () => undefined }),
    withExclusiveOperation: async (operation) => operation(),
    withBackupDeadline: async (_timeoutMs, signal, operation) =>
      operation(signal),
    withWriteBodyDeadline: async (_timeoutMs, signal, operation) =>
      operation(signal),
    ...overrides,
  };
}

async function withDirectRouteServer<T>(
  application: InventoryApplicationService,
  dependencies: RouteRequestDependencies,
  run: (origin: string) => Promise<T>,
  observeRequest?: (request: IncomingMessage) => void,
  options: ValidatedOptions = directRouteOptions(),
): Promise<T> {
  const server = createServer((request, response) => {
    observeRequest?.(request);
    void routeRequest(
      application,
      options,
      request,
      response,
      dependencies,
    ).catch((error: unknown) => {
      if (!response.headersSent) {
        sendError(response, error);
        return;
      }
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

async function assertRequestWaitsForExclusive(
  application: InventoryApplicationService,
  makeRequest: (origin: string) => Promise<Response>,
  calls: () => number,
): Promise<void> {
  let markExclusiveEntered!: () => void;
  let releaseExclusive!: () => void;
  const exclusiveEntered = new Promise<void>((resolve) => {
    markExclusiveEntered = resolve;
  });
  const exclusiveRelease = new Promise<void>((resolve) => {
    releaseExclusive = resolve;
  });
  const dependencies = directRouteDependencies({
    withExclusiveOperation: async (operation) => {
      markExclusiveEntered();
      await exclusiveRelease;
      return operation();
    },
  });

  await withDirectRouteServer(application, dependencies, async (origin) => {
    let responseSettled = false;
    const response = makeRequest(origin).finally(() => {
      responseSettled = true;
    });
    await exclusiveEntered;
    assert.equal(responseSettled, false);
    assert.equal(calls(), 0);
    releaseExclusive();
    assert.equal((await response).status, 200);
    assert.equal(calls(), 1);
  });
}

async function assertImageUploadPreparesBeforeExclusive(
  application: InventoryApplicationService,
  options: ValidatedOptions,
  makeRequest: (origin: string) => Promise<Response>,
): Promise<void> {
  let markPrepareStarted!: () => void;
  let releasePrepare!: () => void;
  const prepareStarted = new Promise<void>((resolve) => {
    markPrepareStarted = resolve;
  });
  const prepareRelease = new Promise<void>((resolve) => {
    releasePrepare = resolve;
  });
  let markExclusiveEntered!: () => void;
  let releaseExclusive!: () => void;
  const exclusiveEntered = new Promise<void>((resolve) => {
    markExclusiveEntered = resolve;
  });
  const exclusiveRelease = new Promise<void>((resolve) => {
    releaseExclusive = resolve;
  });
  let insideExclusive = false;
  let exclusiveWasEntered = false;
  let prepareCalls = 0;
  let prepareCompleted = false;
  let commitCalls = 0;
  let commitOutsideExclusive = false;
  const originalPrepare = application.prepareProductImages;
  const originalCommit = application.commitPreparedProductImages;
  application.prepareProductImages = async (...args) => {
    prepareCalls += 1;
    markPrepareStarted();
    await prepareRelease;
    const prepared = await originalPrepare.apply(application, args);
    prepareCompleted = true;
    return prepared;
  };
  application.commitPreparedProductImages = async (...args) => {
    commitCalls += 1;
    if (!insideExclusive) {
      commitOutsideExclusive = true;
    }
    return originalCommit.apply(application, args);
  };
  const dependencies = directRouteDependencies({
    withExclusiveOperation: async (operation) => {
      exclusiveWasEntered = true;
      markExclusiveEntered();
      await exclusiveRelease;
      insideExclusive = true;
      try {
        return await operation();
      } finally {
        insideExclusive = false;
      }
    },
  });

  try {
    await withDirectRouteServer(
      application,
      dependencies,
      async (origin) => {
        let responseSettled = false;
        const response = makeRequest(origin).finally(() => {
          responseSettled = true;
        });
        await prepareStarted;
        assert.equal(responseSettled, false);
        assert.equal(prepareCalls, 1);
        assert.equal(prepareCompleted, false);
        assert.equal(exclusiveWasEntered, false);
        assert.equal(commitCalls, 0);
        releasePrepare();
        await exclusiveEntered;
        assert.equal(responseSettled, false);
        assert.equal(prepareCalls, 1);
        assert.equal(prepareCompleted, true);
        assert.equal(commitCalls, 0);
        releaseExclusive();
        assert.equal((await response).status, 200);
        assert.equal(commitCalls, 1);
        assert.equal(commitOutsideExclusive, false);
      },
      undefined,
      options,
    );
  } finally {
    releasePrepare();
    releaseExclusive();
    application.prepareProductImages = originalPrepare;
    application.commitPreparedProductImages = originalCommit;
  }
}

interface PartialHttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

interface StartedPartialHttpRequest {
  readonly started: Promise<void>;
  readonly response: Promise<PartialHttpResult>;
  readonly socketClosed: Promise<void>;
}

function startPartialHttpRequest(
  url: string,
  method: "POST" | "PUT",
  token: string,
  contentType: string,
  firstChunk: string,
): StartedPartialHttpRequest {
  let markStarted!: () => void;
  let rejectStarted!: (error: unknown) => void;
  let markSocketClosed!: () => void;
  const started = new Promise<void>((resolve, reject) => {
    markStarted = resolve;
    rejectStarted = reject;
  });
  const socketClosed = new Promise<void>((resolve) => {
    markSocketClosed = resolve;
  });
  const response = new Promise<PartialHttpResult>((resolve, reject) => {
    let responseStarted = false;
    const request = makeHttpRequest(
      url,
      {
        method,
        headers: {
          ...authorization(token),
          "content-length": String(1024 * 1024),
          "content-type": contentType,
        },
      },
      (incoming) => {
        responseStarted = true;
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: JSON.parse(text) as unknown,
          });
        });
      },
    );
    request.once("socket", (socket) => {
      socket.once("close", markSocketClosed);
    });
    request.once("error", (error: NodeJS.ErrnoException) => {
      if (!responseStarted) {
        rejectStarted(error);
        reject(error);
      }
    });
    request.write(firstChunk, (error) => {
      if (error == null) {
        markStarted();
        return;
      }
      rejectStarted(error);
      reject(error);
    });
  });
  return { started, response, socketClosed };
}

function postSlowMultipart(
  url: string,
  token: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = makeHttpRequest(
      url,
      {
        method: "POST",
        headers: {
          ...authorization(token),
          "content-length": String(50 * 1024 * 1024),
          "content-type": "multipart/form-data; boundary=slow-boundary",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          settled = true;
          request.destroy();
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(text) as unknown,
          });
        });
      },
    );
    request.once("error", (error) => {
      if (!settled) {
        reject(error);
      }
    });
    request.write(
      "--slow-boundary\r\nContent-Disposition: form-data; name=\"slow_image\"; filename=\"image\"\r\nContent-Type: application/octet-stream\r\n\r\npartial",
    );
  });
}

function putSlowJson(
  url: string,
  token: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = makeHttpRequest(
      url,
      {
        method: "PUT",
        headers: {
          ...authorization(token),
          "content-length": String(1024 * 1024),
          "content-type": "application/json",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          settled = true;
          request.destroy();
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          });
        });
      },
    );
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
    request.write('{"format":"beautio-backup"');
  });
}

async function createStaticWebFixture(directory: string): Promise<string> {
  const webRoot = join(directory, "web");
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await mkdir(join(webRoot, "api"), { recursive: true });
  await mkdir(join(webRoot, "openapi"), { recursive: true });
  await writeFile(
    join(webRoot, "index.html"),
    "<!doctype html><title>Beautio production</title>\n",
  );
  await writeFile(join(webRoot, "assets", "app-12345678.js"), STATIC_SCRIPT);
  await writeFile(join(webRoot, "api", "health"), "static shadow must lose\n");
  await writeFile(
    join(webRoot, "openapi", "beautio-actions-v1.json"),
    "static shadow must lose\n",
  );
  await writeFile(join(webRoot, ".env"), "must not be public\n");
  const outsidePath = join(directory, "outside.txt");
  await writeFile(outsidePath, "outside root must not be public\n");
  await symlink(outsidePath, join(webRoot, "assets", "escape.txt"));
  return webRoot;
}

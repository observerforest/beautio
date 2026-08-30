import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request as makeHttpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  InventoryApplicationService,
  type ImageAssetStorage,
  type ImageInspector,
} from "@beautio/application";
import type { BeautioBackup } from "@beautio/contracts";
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
import { createCoreApiHandler } from "../src/index.ts";

const ACTION_TOKEN = "test-action-token-not-a-secret";
const ADMIN_TOKEN = "test-admin-token-not-a-secret";
const STATIC_SCRIPT = "console.log('beautio production web');\n";

test("HTTP adapter fails closed when either token is empty or both are equal", () => {
  const repository = new SqliteInventoryRepository(":memory:");
  const application = new InventoryApplicationService(repository);
  const options = {
    actionBearerToken: ACTION_TOKEN,
    adminBearerToken: ADMIN_TOKEN,
    actionFileHosts: new Set(["files.example.test"]),
  };

  assert.throws(
    () => createCoreApiHandler(application, { ...options, actionBearerToken: "" }),
    /both Beautio HTTP bearer tokens are required/,
  );
  assert.throws(
    () => createCoreApiHandler(application, { ...options, adminBearerToken: " " }),
    /both Beautio HTTP bearer tokens are required/,
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

test("health is public while inventory and both write scopes are isolated", async (context) => {
  const fixture = await startFixture(context);

  assert.equal((await fetch(`${fixture.origin}/api/health`)).status, 200);

  const actionRequests = [
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

  for (const request of actionRequests) {
    assert.equal((await request()).status, 401);
    assert.equal((await request(ADMIN_TOKEN)).status, 401);
    assert.equal((await request("wrong-token")).status, 401);
  }
  for (const request of adminRequests) {
    assert.equal((await request()).status, 401);
    assert.equal((await request(ACTION_TOKEN)).status, 401);
    assert.equal((await request("wrong-token")).status, 401);
  }
  assert.deepEqual(
    await fixture.application.listInventory({ as_of: "2026-08-19" }),
    { as_of: "2026-08-19", items: [] },
  );
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

test("restore excludes concurrent Admin and Action writes until replacement completes", async (context) => {
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
  let actionSettled = false;
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
  const actionWrite = postJson(
    `${fixture.origin}/api/actions/create-inventory-batch`,
    {
      as_of: "2026-08-19",
      products: [{ batch_ref: "queued_product", name: "Queued Action product" }],
      inventory_items: [
        {
          batch_ref: "queued_bottle",
          product_ref: { kind: "new", batch_ref: "queued_product" },
          lifecycle_status: "unopened",
        },
      ],
    },
    ACTION_TOKEN,
  ).finally(() => {
    actionSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(adminSettled, false);
  assert.equal(actionSettled, false);

  releaseInspection();
  assert.equal((await restore).status, 200);
  assert.equal((await adminWrite).status, 200);
  assert.equal((await actionWrite).status, 200);
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
    ["Admin write after restore", "Queued Action product"],
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
    ACTION_TOKEN,
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
    ACTION_TOKEN,
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
    `${fixture.origin}/api/actions/create-inventory-batch`,
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
      image_asset_id: upload.assets[0].image_asset_id,
      image_ref: null,
      ingredient_list_text: null,
      shared_notes: null,
    },
  });

  const firstInventoryItemId = batch.inventory_items[0].inventory_item_id;
  const openedResponse = await postJson(
    `${fixture.origin}/api/actions/codex/record-product-opened`,
    {
      inventory_item_id: firstInventoryItemId,
      opened_on: "2026-08-19",
    },
    ACTION_TOKEN,
  );
  assert.equal(openedResponse.status, 200);
  assert.equal(
    ((await openedResponse.json()) as { readonly outcome: string }).outcome,
    "opened",
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

test("Action upload deadline covers shared image inspection before persistence", async (context) => {
  const neverCompletes: ImageInspector = {
    async inspect() {
      return await new Promise(() => undefined);
    },
  };
  const fixture = await startFixture(context, {
    actionUploadTimeoutMs: 5,
    imageInspector: neverCompletes,
  });

  const response = await postJson(
    `${fixture.origin}/api/actions/upload-product-images`,
    {
      openaiFileIdRefs: [
        {
          name: "confirmed.png",
          id: "file_deadline",
          mime_type: "image/png",
          download_link: "https://files.example.test/short-lived",
        },
      ],
    },
    ACTION_TOKEN,
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
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
    ACTION_TOKEN,
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
    ACTION_TOKEN,
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
    ACTION_TOKEN,
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
    ACTION_TOKEN,
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
      ACTION_TOKEN,
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

test("backup restore deadline aborts blocked image inspection before replacement", async (context) => {
  let blockInspection = false;
  const fixture = await startFixture(context, {
    backupOperationTimeoutMs: 20,
    imageInspector: {
      async inspect(bytes) {
        if (blockInspection) {
          return await new Promise(() => undefined);
        }
        return sharpImageInspector.inspect(bytes);
      },
    },
  });
  const uploaded = await fixture.application.uploadProductImages([
    { source_ref: "deadline_restore", bytes: fixture.imageBytes },
  ]);
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

  blockInspection = true;
  const timedOut = await putJson(
    `${fixture.origin}/api/admin/backup`,
    backup,
    ADMIN_TOKEN,
  );
  assert.equal(timedOut.status, 502);
  assert.deepEqual(await timedOut.json(), {
    error: { code: "UPLOAD_FAILED", message: "backup operation timed out" },
  });

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
    ACTION_TOKEN,
  );
  assert.equal(nextWrite.status, 200);
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
    ACTION_TOKEN,
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
    ACTION_TOKEN,
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
    headers: authorization(ACTION_TOKEN),
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
        ...authorization(ACTION_TOKEN),
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
    { headers: authorization(ACTION_TOKEN) },
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
      actionBearerToken: ACTION_TOKEN,
      adminBearerToken: ADMIN_TOKEN,
      actionFileHosts: new Set(["files.example.test"]),
      actionDownloader: async (references) =>
        references.map((reference) => ({
          source_ref: reference.id,
          bytes: imageBytes,
        })),
      ...(options.actionUploadTimeoutMs === undefined
        ? {}
        : { actionUploadTimeoutMs: options.actionUploadTimeoutMs }),
      ...(options.backupOperationTimeoutMs === undefined
        ? {}
        : { backupOperationTimeoutMs: options.backupOperationTimeoutMs }),
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

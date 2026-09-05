import assert from "node:assert/strict";
import {
  CommandExecutionError,
  CustomGptCreateCommandService,
  type CreateCommandRepository,
} from "@beautio/application";
import {
  createInventoryBatchOutputSchema,
  customGptCommandStatusOutputSchema,
  customGptCreateActionErrorSchema,
  customGptCreateCommandMaximumResponseBytes,
  customGptCreateCommandOutputSchema,
  customGptFetchOutputSchema,
} from "@beautio/contracts";
import { request as httpRequest } from "node:http";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  createActionFixture,
  createAdminToken,
  createCodexToken,
  createCommandId,
  createCustomGptToken,
} from "./custom-gpt-create-action-fixture.ts";

const createPath = "/api/actions/create-inventory-batch";

test("Custom GPT create commits a compact receipt and supports status, fetch, and exact replay", async (context) => {
  const fixture = await createActionFixture(context);
  const existing = await fixture.application.createInventoryBatch({
    as_of: "2026-09-05",
    products: [{ batch_ref: "existing_product", name: "Existing cream" }],
    inventory_items: [
      {
        batch_ref: "existing_bottle",
        product_ref: { kind: "new", batch_ref: "existing_product" },
        lifecycle_status: "unopened",
      },
    ],
  });
  const existingProductId = existing.products[0]?.product_id;
  assert.ok(existingProductId);
  const uploaded = await fixture.application.uploadProductImages([
    { source_ref: "synthetic_create_image", bytes: fixture.imageBytes },
  ]);
  const imageAssetId = uploaded.assets[0]?.image_asset_id;
  assert.ok(imageAssetId);

  const body = {
    command_id: createCommandId(1),
    as_of: "2026-09-05",
    products: [
      {
        batch_ref: "new_serum",
        name: "Confirmed serum",
        alias: "Purple Jar",
        brand: "Beautio Lab",
        category: "serum",
        size_label: "30 ml",
        pao_duration_months: 6,
        image_asset_id: imageAssetId,
        ingredient_list_text: "Aqua,\nGlycerin",
        shared_notes: "Synthetic shared note",
      },
    ],
    inventory_items: [
      {
        batch_ref: "new_opened",
        product_ref: { kind: "new", batch_ref: "new_serum" },
        lifecycle_status: "opened",
        opened_on: "2026-09-01",
        opened_on_accuracy: "exact",
        expires_on: "2027-09-01",
        custom_notes: "Opened bottle",
      },
      {
        batch_ref: "new_unopened",
        product_ref: { kind: "new", batch_ref: "new_serum" },
        lifecycle_status: "unopened",
        custom_notes: "Spare bottle",
      },
      {
        batch_ref: "existing_unopened",
        product_ref: { kind: "existing", product_id: existingProductId },
        lifecycle_status: "unopened",
        custom_notes: "Existing Product bottle",
      },
    ],
  };
  const response = await fixture.request("POST", createPath, body);
  assert.equal(response.status, 200);
  const responseText = await response.text();
  assert.ok(
    Buffer.byteLength(responseText, "utf8") <=
      customGptCreateCommandMaximumResponseBytes,
  );
  assert.doesNotMatch(
    responseText,
    /new_serum|new_opened|Purple Jar|synthetic_create_image/u,
  );
  const created = customGptCreateCommandOutputSchema.parse(
    JSON.parse(responseText),
  );
  assert.equal(created.status, "succeeded");
  assert.equal(created.result.inventory_item_ids.length, 3);

  const [opened, unopened, linkedToExisting] = await Promise.all(
    created.result.inventory_item_ids.map((inventoryItemId) =>
      fetchInventory(fixture.origin, inventoryItemId),
    ),
  );
  assert.equal(opened?.inventory_item.product?.name, "Confirmed serum");
  assert.equal(opened?.inventory_item.product?.alias, "Purple Jar");
  assert.equal(opened?.inventory_item.product?.has_image, true);
  assert.equal(opened?.inventory_item.lifecycle_status, "opened");
  assert.equal(opened?.inventory_item.opened_on, "2026-09-01");
  assert.equal(opened?.inventory_item.opened_on_accuracy, "exact");
  assert.equal(opened?.inventory_item.custom_notes, "Opened bottle");
  assert.equal(unopened?.inventory_item.product?.name, "Confirmed serum");
  assert.equal(unopened?.inventory_item.custom_notes, "Spare bottle");
  assert.equal(linkedToExisting?.inventory_item.product_id, existingProductId);
  assert.equal(
    linkedToExisting?.inventory_item.custom_notes,
    "Existing Product bottle",
  );

  const status = await fetchCommandStatus(fixture.origin, body.command_id);
  assert.equal(status.status, "succeeded");
  assert.deepEqual(status.result, created.result);
  const afterFirst = fixture.snapshot();
  const replay = await fixture.request("POST", createPath, body);
  assert.equal(replay.status, 200);
  assert.deepEqual(
    customGptCreateCommandOutputSchema.parse(await replay.json()),
    created,
  );
  assert.deepEqual(fixture.snapshot(), afterFirst);
});

test("create Action identity, availability, method, query, media, fields, and body limits fail closed", async (context) => {
  const disabled = await createActionFixture(context, {
    enableCustomGptCreates: false,
  });
  const validBody = createBatch(createCommandId(10), "disabled");
  for (const token of [null, createCodexToken, createAdminToken]) {
    assert.equal(
      (await disabled.request("POST", createPath, validBody, token)).status,
      401,
    );
  }
  const unavailable = await disabled.request("POST", createPath, validBody);
  assert.equal(unavailable.status, 404);
  assert.equal(
    customGptCreateActionErrorSchema.parse(await unavailable.json()).error.code,
    "NOT_FOUND",
  );
  assert.deepEqual(disabled.snapshot()[5], []);

  const fixture = await createActionFixture(context);
  const cases = [
    fixture
      .request("PUT", createPath, validBody)
      .then((response) => [response, 404] as const),
    fixture
      .request("POST", `${createPath}?extra=true`, validBody)
      .then((response) => [response, 400] as const),
    fixture
      .request("POST", createPath, validBody, undefined, "text/plain")
      .then((response) => [response, 400] as const),
    fixture
      .request("POST", createPath, { ...validBody, unknown: true })
      .then((response) => [response, 400] as const),
    fixture
      .request("POST", createPath, {
        as_of: validBody.as_of,
        products: validBody.products,
        inventory_items: validBody.inventory_items,
      })
      .then((response) => [response, 400] as const),
    fixture
      .request(
        "POST",
        createPath,
        JSON.stringify({ ...validBody, padding: "x".repeat(1024 * 1024) }),
      )
      .then((response) => [response, 413] as const),
  ];
  for (const pending of cases) {
    const [response, expectedStatus] = await pending;
    assert.equal(response.status, expectedStatus);
    customGptCreateActionErrorSchema.parse(await response.json());
  }
  assert.deepEqual(fixture.snapshot()[5], []);
});

test("Admin and Codex retain their legacy create contract while Custom GPT requires command_id", async (context) => {
  const fixture = await createActionFixture(context);
  const admin = await fixture.request(
    "POST",
    "/api/admin/create-inventory-batch",
    createBatchWithoutCommand("admin"),
    createAdminToken,
  );
  assert.equal(admin.status, 200);
  assert.equal(
    createInventoryBatchOutputSchema.parse(await admin.json()).outcome,
    "created",
  );

  const codex = await fixture.request(
    "POST",
    "/api/actions/codex/create-inventory-batch",
    createBatchWithoutCommand("codex"),
    createCodexToken,
  );
  assert.equal(codex.status, 200);
  assert.equal(
    createInventoryBatchOutputSchema.parse(await codex.json()).outcome,
    "created",
  );

  const missingCommand = await fixture.request(
    "POST",
    createPath,
    createBatchWithoutCommand("custom_gpt"),
  );
  assert.equal(missingCommand.status, 400);
  assert.equal(
    customGptCreateActionErrorSchema.parse(await missingCommand.json()).error
      .code,
    "INVALID_INPUT",
  );
  assert.deepEqual(fixture.snapshot()[5], []);
});

test("create command replays normalized input, conflicts on changed payload, and records proven rejection", async (context) => {
  const fixture = await createActionFixture(context);
  const commandId = createCommandId(20);
  const firstBody = createBatch(commandId, "normal", "  Normalized product  ");
  const first = await createCommand(
    fixture.request("POST", createPath, firstBody),
  );
  const afterFirst = fixture.snapshot();
  const replay = await createCommand(
    fixture.request(
      "POST",
      createPath,
      createBatch(commandId, "normal", "Normalized product"),
    ),
  );
  assert.deepEqual(replay, first);
  assert.deepEqual(fixture.snapshot(), afterFirst);

  const conflict = await fixture.request(
    "POST",
    createPath,
    createBatch(commandId, "changed", "Changed product"),
  );
  assert.equal(conflict.status, 409);
  assert.equal(
    customGptCreateActionErrorSchema.parse(await conflict.json()).error.code,
    "COMMAND_PAYLOAD_CONFLICT",
  );
  assert.deepEqual(fixture.snapshot(), afterFirst);

  const rejectedBody = {
    command_id: createCommandId(21),
    as_of: "2026-09-05",
    products: [],
    inventory_items: [
      {
        batch_ref: "missing_product_bottle",
        product_ref: {
          kind: "existing",
          product_id: "00000000-0000-4000-8000-999999999999",
        },
        lifecycle_status: "unopened",
      },
    ],
  };
  const rejected = await createCommand(
    fixture.request("POST", createPath, rejectedBody),
  );
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.failure_code, "PRODUCT_NOT_FOUND");
  assert.equal(rejected.result, null);
  const rejectedReplay = await createCommand(
    fixture.request("POST", createPath, rejectedBody),
  );
  assert.deepEqual(rejectedReplay, rejected);
});

test("a committed create with a lost repository return is recoverable through status and never runs twice", async (context) => {
  let effects = 0;
  const fixture = await createActionFixture(context, {
    createCustomGptCreates: ({ commands, repository, serviceOptions }) => {
      const lostReturn: CreateCommandRepository = {
        async executeCreateCommand(input) {
          effects += 1;
          await repository.executeCreateCommand(input);
          throw new Error("Synthetic private storage return was lost");
        },
      };
      return new CustomGptCreateCommandService(
        lostReturn,
        commands,
        serviceOptions,
      );
    },
  });
  const body = createBatch(createCommandId(30), "lost_return");
  let response = await fixture.request("POST", createPath, body);
  assert.equal(response.status, 500);
  const errorText = await response.text();
  assert.doesNotMatch(errorText, /Synthetic private|storage return/u);
  assert.match(errorText, /command status and inventory facts/u);

  const status = await fetchCommandStatus(fixture.origin, body.command_id);
  assert.equal(status.status, "succeeded");
  assert.equal(status.result?.outcome, "created");
  assert.equal(status.result?.inventory_item_ids.length, 1);
  const createdId = status.result?.inventory_item_ids[0];
  assert.ok(createdId);
  assert.equal(
    (await fetchInventory(fixture.origin, createdId)).inventory_item.product
      ?.name,
    "Product lost_return",
  );
  const afterFirst = fixture.snapshot();

  response = await fixture.request("POST", createPath, body);
  assert.equal(response.status, 200);
  assert.equal(
    customGptCreateCommandOutputSchema.parse(await response.json()).status,
    "succeeded",
  );
  assert.equal(effects, 1);
  assert.deepEqual(fixture.snapshot(), afterFirst);
});

test("disconnect while queued creates no claim and an active create retains the shared gate until settlement", { timeout: 10_000 }, async (context) => {
  const firstEntered = Promise.withResolvers<void>();
  const secondPrepared = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let prepareCalls = 0;
  let executeCalls = 0;
  const fixture = await createActionFixture(context, {
    createCustomGptCreates: ({ service }) => ({
      prepare(input) {
        const prepared = service.prepare(input);
        prepareCalls += 1;
        if (prepareCalls === 2) secondPrepared.resolve();
        return prepared;
      },
      async executePrepared(prepared) {
        executeCalls += 1;
        if (executeCalls === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
        return service.executePrepared(prepared);
      },
    }),
  });

  const first = fixture.request(
    "POST",
    createPath,
    createBatch(createCommandId(40), "first"),
  );
  await firstEntered.promise;
  const serverObservedClose = new Promise<void>((resolve) =>
    fixture.server.once("request", (_request, response) =>
      response.once("close", () => resolve()),
    ),
  );
  const cancelled = startAbortableJsonRequest(
    fixture.origin + createPath,
    createBatch(createCommandId(41), "cancelled"),
  );
  await secondPrepared.promise;
  cancelled.request.destroy();
  await cancelled.closed;
  await serverObservedClose;
  await nextTurn();
  assert.equal(executeCalls, 1);

  releaseFirst.resolve();
  assert.equal((await first).status, 200);
  await nextTurn();
  assert.equal(executeCalls, 1);
  assert.equal(
    (
      await fixture.reads.getCommandStatus({
        operation_id: "create_inventory_batch",
        command_id: createCommandId(41),
      })
    ).status,
    "not_found",
  );
  assert.equal(
    fixture.database
      .prepare("SELECT COUNT(*) AS count FROM inventory_items")
      .get()?.count,
    1,
  );
});

test("known-failure settlement busy stays unknown, holds the gate, and replays in-progress", { timeout: 10_000 }, async (context) => {
  const settlementEntered = Promise.withResolvers<void>();
  const releaseSettlement = Promise.withResolvers<void>();
  let settlementCalls = 0;
  const fixture = await createActionFixture(context);
  fixture.repository.completeCommandExecutionKnownFailure = async () => {
    settlementCalls += 1;
    settlementEntered.resolve();
    await releaseSettlement.promise;
    throw new CommandExecutionError(
      "COMMAND_STORE_BUSY",
      "Synthetic private failed-settlement detail",
    );
  };
  const rejectedBody = {
    command_id: createCommandId(50),
    as_of: "2026-09-05",
    products: [],
    inventory_items: [
      {
        batch_ref: "missing_target",
        product_ref: {
          kind: "existing",
          product_id: "00000000-0000-4000-8000-999999999999",
        },
        lifecycle_status: "unopened",
      },
    ],
  };
  const rejected = fixture.request("POST", createPath, rejectedBody);
  await settlementEntered.promise;

  let adminSettled = false;
  const admin = fixture
    .request(
      "POST",
      "/api/admin/create-inventory-batch",
      createBatchWithoutCommand("after_settlement"),
      createAdminToken,
    )
    .finally(() => {
      adminSettled = true;
    });
  await delay(30);
  assert.equal(adminSettled, false);

  releaseSettlement.resolve();
  const failedResponse = await rejected;
  assert.equal(failedResponse.status, 500);
  const errorText = await failedResponse.text();
  assert.doesNotMatch(errorText, /Synthetic private|settlement detail/u);
  assert.match(errorText, /command status and inventory facts/u);
  assert.equal((await admin).status, 200);
  const status = await fetchCommandStatus(
    fixture.origin,
    rejectedBody.command_id,
  );
  assert.equal(status.status, "in_progress");
  const afterFirst = fixture.snapshot();

  const replay = await fixture.request("POST", createPath, rejectedBody);
  assert.equal(replay.status, 200);
  assert.equal(
    customGptCreateCommandOutputSchema.parse(await replay.json()).status,
    "in_progress",
  );
  assert.equal(settlementCalls, 1);
  assert.deepEqual(fixture.snapshot(), afterFirst);
});

test("the maximum 25 Product and 100 bottle request keeps its one MiB input and eight KiB receipt bounds", async (context) => {
  const fixture = await createActionFixture(context);
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
  const body = {
    command_id: createCommandId(60),
    as_of: "2026-09-05",
    products,
    inventory_items: inventoryItems,
  };
  const requestText = JSON.stringify(body);
  assert.ok(Buffer.byteLength(requestText, "utf8") < 1024 * 1024);

  const response = await fixture.request("POST", createPath, requestText);
  assert.equal(response.status, 200);
  const responseText = await response.text();
  assert.ok(
    Buffer.byteLength(responseText, "utf8") <=
      customGptCreateCommandMaximumResponseBytes,
  );
  const output = customGptCreateCommandOutputSchema.parse(
    JSON.parse(responseText),
  );
  assert.equal(output.status, "succeeded");
  assert.equal(output.result.inventory_item_ids.length, 100);
  assert.equal(
    (await fetchInventory(fixture.origin, output.result.inventory_item_ids[0]!))
      .inventory_item.product?.name,
    "Product 0",
  );
  assert.equal(
    (
      await fetchInventory(
        fixture.origin,
        output.result.inventory_item_ids[99]!,
      )
    ).inventory_item.product?.name,
    "Product 24",
  );
});

test("strict response validation hides malformed post-commit output without changing persisted success", async (context) => {
  const fixture = await createActionFixture(context, {
    createCustomGptCreates: ({ service }) => ({
      prepare: service.prepare.bind(service),
      async executePrepared(prepared) {
        return {
          ...(await service.executePrepared(prepared)),
          private_payload: "Synthetic private response detail",
        };
      },
    }),
  });
  const body = createBatch(createCommandId(70), "malformed_response");
  let response = await fixture.request("POST", createPath, body);
  assert.equal(response.status, 500);
  let text = await response.text();
  assert.doesNotMatch(text, /private_payload|Synthetic private response/u);
  assert.match(text, /command status and inventory facts/u);
  const status = await fetchCommandStatus(fixture.origin, body.command_id);
  assert.equal(status.status, "succeeded");
  const afterFirst = fixture.snapshot();

  response = await fixture.request("POST", createPath, body);
  assert.equal(response.status, 500);
  text = await response.text();
  assert.doesNotMatch(text, /private_payload|Synthetic private response/u);
  assert.deepEqual(fixture.snapshot(), afterFirst);
});

function createBatch(commandId: string, suffix: string, name?: string) {
  return {
    command_id: commandId,
    ...createBatchWithoutCommand(suffix, name),
  };
}

function createBatchWithoutCommand(suffix: string, name?: string) {
  return {
    as_of: "2026-09-05",
    products: [
      {
        batch_ref: `product_${suffix}`,
        name: name ?? `Product ${suffix}`,
      },
    ],
    inventory_items: [
      {
        batch_ref: `bottle_${suffix}`,
        product_ref: { kind: "new", batch_ref: `product_${suffix}` },
        lifecycle_status: "unopened",
      },
    ],
  };
}

async function createCommand(responsePromise: Promise<Response>) {
  const response = await responsePromise;
  assert.equal(response.status, 200);
  return customGptCreateCommandOutputSchema.parse(await response.json());
}

async function fetchCommandStatus(origin: string, commandId: string) {
  const response = await fetch(`${origin}/api/actions/commands/status`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${createCustomGptToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      operation_id: "create_inventory_batch",
      command_id: commandId,
    }),
  });
  assert.equal(response.status, 200);
  return customGptCommandStatusOutputSchema.parse(await response.json());
}

async function fetchInventory(origin: string, inventoryItemId: string) {
  const response = await fetch(`${origin}/api/actions/inventory/fetch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${createCustomGptToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ inventory_item_id: inventoryItemId }),
  });
  assert.equal(response.status, 200);
  return customGptFetchOutputSchema.parse(await response.json());
}

function startAbortableJsonRequest(url: string, body: unknown): {
  readonly closed: Promise<void>;
  readonly request: ReturnType<typeof httpRequest>;
} {
  const payload = JSON.stringify(body);
  const closed = Promise.withResolvers<void>();
  const request = httpRequest(
    url,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${createCustomGptToken}`,
        "content-length": String(Buffer.byteLength(payload)),
        "content-type": "application/json",
      },
    },
    (response) => response.resume(),
  );
  request.on("error", () => undefined);
  request.once("close", () => closed.resolve());
  request.end(payload);
  return { closed: closed.promise, request };
}

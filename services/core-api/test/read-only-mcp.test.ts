import assert from "node:assert/strict";
import { createServer, request as makeHttpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { InventoryApplicationService } from "@beautio/application";
import {
  fetchInventoryOutputSchema,
  searchInventoryOutputSchema,
} from "@beautio/contracts";
import { SqliteInventoryRepository } from "@beautio/database";
import {
  BeautioError,
  createInventoryItem,
  type InventoryItem,
} from "@beautio/domain";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createCoreApiHandler } from "../src/index.ts";
import {
  createReadOnlyInventoryMcpServer,
  createReadOnlyMcpRoute,
  fetchInventoryItemToolName,
  searchInventoryToolName,
} from "../src/read-only-mcp.ts";

const ACTION_TOKEN = "remote-mcp-test-action-token";
const CUSTOM_GPT_TOKEN = "remote-mcp-test-custom-gpt-token";
const ADMIN_TOKEN = "remote-mcp-test-admin-token";
const ACCESS_ASSERTION = "signed-access-assertion-placeholder";

test("read-only MCP exposes exactly search and fetch over the shared application", async (context) => {
  const fixture = await createInventoryFixture(context);
  const server = createReadOnlyInventoryMcpServer(fixture.application);
  const client = new Client({ name: "read-only-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  assert.deepEqual(client.getServerCapabilities(), {
    tools: { listChanged: true },
  });
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [searchInventoryToolName, fetchInventoryItemToolName],
  );
  const searchTool = listed.tools.find(
    (tool) => tool.name === searchInventoryToolName,
  );
  assert.match(searchTool?.description ?? "", /fetch_inventory_item/);
  assert.match(searchTool?.description ?? "", /alias/i);
  assert.match(searchTool?.description ?? "", /complete inventory_item_id/);
  assert.match(searchTool?.description ?? "", /never invent an ID from a name/i);
  for (const tool of listed.tools) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.equal(tool.inputSchema.additionalProperties, false);
  }

  for (const invalidCall of [
    client.callTool({
      name: searchInventoryToolName,
      arguments: { query: " " },
    }),
    client.callTool({
      name: searchInventoryToolName,
      arguments: { unexpected: true },
    }),
  ]) {
    const invalid = await invalidCall;
    assert.equal(invalid.isError, true);
    assert.equal(
      (invalid.structuredContent as { readonly code?: string } | undefined)
        ?.code,
      "INVALID_INPUT",
    );
    assert.deepEqual(textJson(invalid), invalid.structuredContent);
  }

  const before = await fixture.application.listInventory({
    as_of: "2026-08-21",
  });
  const searchResult = await client.callTool({
    name: searchInventoryToolName,
    arguments: { query: "glycerin" },
  });
  assert.equal(searchResult.isError, undefined);
  const search = searchInventoryOutputSchema.parse(
    searchResult.structuredContent,
  );
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0]?.inventory_item_id, fixture.inventoryItemId);
  assert.equal(search.items[0]?.alias, "Purple Jar");
  assert.deepEqual(textJson(searchResult), search);

  const fetchResult = await client.callTool({
    name: fetchInventoryItemToolName,
    arguments: { inventory_item_id: fixture.inventoryItemId },
  });
  assert.equal(fetchResult.isError, undefined);
  const fetched = fetchInventoryOutputSchema.parse(
    fetchResult.structuredContent,
  );
  assert.equal(
    fetched.inventory_item.product?.ingredient_list_text,
    "Aqua,\nGlycerin",
  );
  assert.equal(
    fetched.inventory_item.product?.alias,
    "Purple Jar",
  );
  assert.equal(fetched.inventory_item.product?.shared_notes, "Shared note");
  assert.equal(fetched.inventory_item.custom_notes, "Bottle note");
  assert.equal(fetched.inventory_item.derived_status, null);
  assert.deepEqual(textJson(fetchResult), fetched);
  const serialized = JSON.stringify(fetched);
  assert.equal(serialized.includes("image_asset_id"), false);
  assert.equal(serialized.includes("image_ref"), false);

  const after = await fixture.application.listInventory({
    as_of: "2026-08-21",
  });
  assert.deepEqual(after, before);

  const missing = await client.callTool({
    name: fetchInventoryItemToolName,
    arguments: { inventory_item_id: "missing-item" },
  });
  assert.equal(missing.isError, true);
  assert.equal(
    (missing.structuredContent as { readonly code?: string } | undefined)?.code,
    "INVENTORY_ITEM_NOT_FOUND",
  );
  assert.deepEqual(missing.structuredContent, {
    code: "INVENTORY_ITEM_NOT_FOUND",
    message: "inventory item does not exist",
  });

  const hugeMissingId = "private-input-".repeat(20_000);
  const hugeMissing = await client.callTool({
    name: fetchInventoryItemToolName,
    arguments: { inventory_item_id: hugeMissingId },
  });
  assert.equal(hugeMissing.isError, true);
  assert.equal(JSON.stringify(hugeMissing).includes(hugeMissingId), false);
  assert.deepEqual(hugeMissing.structuredContent, {
    code: "INVENTORY_ITEM_NOT_FOUND",
    message: "inventory item does not exist",
  });
});

test("real Streamable HTTP client reaches the two tools only after Access verification", async (context) => {
  const fixture = await createInventoryFixture(context);
  const verifiedAssertions: string[] = [];
  const route = createReadOnlyMcpRoute(fixture.application, {
    publicOrigin: "https://127.0.0.1",
    verifyAccessJwt: async (assertion) => {
      if (assertion !== ACCESS_ASSERTION) {
        throw new BeautioError(
          "UNAUTHORIZED",
          "valid Cloudflare Access authentication is required",
        );
      }
      verifiedAssertions.push(assertion);
    },
  });
  const httpServer = createServer(
    createCoreApiHandler(fixture.application, {
      customGptBearerToken: CUSTOM_GPT_TOKEN,
      actionBearerToken: ACTION_TOKEN,
      adminBearerToken: ADMIN_TOKEN,
      actionFileHosts: new Set(["files.example.test"]),
      readOnlyMcp: route,
    }),
  );
  await listen(httpServer);
  const address = httpServer.address() as AddressInfo;
  const localOrigin = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await route.close();
    await closeServer(httpServer);
  });

  const unauthenticated = await fetch(`${localOrigin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthenticated.status, 401);
  for (const bearerToken of [CUSTOM_GPT_TOKEN, ACTION_TOKEN, ADMIN_TOKEN]) {
    assert.equal(
      (
        await fetch(`${localOrigin}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearerToken}`,
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      401,
    );
  }
  assert.equal(
    (
      await fetch(`${localOrigin}/mcp`, {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": ACCESS_ASSERTION,
          "content-type": "text/plain",
        },
        body: "{}",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await fetch(`${localOrigin}/mcp`, {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": ACCESS_ASSERTION,
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    await requestStatus(address.port, {
      host: "beautio.example.test",
      "cf-access-jwt-assertion": ACCESS_ASSERTION,
      "content-type": "application/json",
    }),
    403,
  );
  assert.equal(
    (
      await fetch(`${localOrigin}/mcp`, {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": ACCESS_ASSERTION,
          "content-type": "application/json",
        },
        body: Buffer.alloc(1024 * 1024 + 1, 32),
      })
    ).status,
    413,
  );

  const client = new Client({ name: "read-only-http-e2e", version: "1.0.0" });
  const privateResponseHeaders: Array<
    readonly [string, string | null, string | null, string | null]
  > = [];
  const transport = new StreamableHTTPClientTransport(
    new URL("https://127.0.0.1/mcp"),
    {
      fetch: mappedFetch(localOrigin, ACCESS_ASSERTION, (request, response) => {
        privateResponseHeaders.push([
          request.method,
          response.headers.get("content-type"),
          response.headers.get("cache-control"),
          response.headers.get("x-content-type-options"),
        ]);
      }),
    },
  );
  await client.connect(transport);
  context.after(async () => client.close());

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [searchInventoryToolName, fetchInventoryItemToolName],
  );
  const fetched = await client.callTool({
    name: fetchInventoryItemToolName,
    arguments: {
      inventory_item_id: fixture.inventoryItemId,
      as_of: "2026-08-21",
    },
  });
  const output = fetchInventoryOutputSchema.parse(fetched.structuredContent);
  assert.equal(output.inventory_item.derived_status?.as_of, "2026-08-21");
  assert.ok(verifiedAssertions.length >= 2);
  assert.equal(verifiedAssertions.every((value) => value === ACCESS_ASSERTION), true);
  assert.ok(privateResponseHeaders.length >= 2);
  assert.equal(
    privateResponseHeaders.every(
      ([, contentType, cacheControl, contentTypeOptions]) =>
        cacheControl ===
          (contentType?.startsWith("text/event-stream") === true
            ? "no-store, no-transform"
            : "no-store") && contentTypeOptions === "nosniff",
    ),
    true,
  );
  assert.equal(
    privateResponseHeaders.some(
      ([method, contentType, cacheControl]) =>
        method === "POST" &&
        contentType?.startsWith("text/event-stream") === true &&
        cacheControl === "no-store, no-transform",
    ),
    true,
  );
});

test("read-only MCP keeps request capacity occupied until the underlying read settles", async (context) => {
  let markSearchStarted: (() => void) | undefined;
  const searchStarted = new Promise<void>((resolve) => {
    markSearchStarted = resolve;
  });
  let releaseSearch: ((items: readonly InventoryItem[]) => void) | undefined;
  const searchResult = new Promise<readonly InventoryItem[]>((resolve) => {
    releaseSearch = resolve;
  });
  class BlockingRepository extends SqliteInventoryRepository {
    findAllCalls = 0;

    override findAll(): Promise<readonly InventoryItem[]> {
      this.findAllCalls += 1;
      markSearchStarted?.();
      return searchResult;
    }
  }

  const repository = new BlockingRepository(":memory:");
  const application = new InventoryApplicationService(repository);
  const route = createReadOnlyMcpRoute(application, {
    publicOrigin: "https://127.0.0.1",
    verifyAccessJwt: async () => undefined,
    maximumConcurrentRequests: 1,
  });
  const httpServer = createServer(
    createCoreApiHandler(application, {
      customGptBearerToken: CUSTOM_GPT_TOKEN,
      actionBearerToken: ACTION_TOKEN,
      adminBearerToken: ADMIN_TOKEN,
      actionFileHosts: new Set(["files.example.test"]),
      readOnlyMcp: route,
    }),
  );
  await listen(httpServer);
  const address = httpServer.address() as AddressInfo;
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: "concurrency-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://127.0.0.1/mcp"),
    { fetch: mappedFetch(localOrigin, ACCESS_ASSERTION) },
  );
  await client.connect(transport);
  context.after(async () => {
    await client.close();
    await route.close();
    await closeServer(httpServer);
    repository.close();
  });

  const blockedSearch = client.callTool({
    name: searchInventoryToolName,
    arguments: {},
  });
  await searchStarted;
  const busy = await fetch(`${localOrigin}/mcp`, {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": ACCESS_ASSERTION,
      "content-type": "application/json",
    },
    body: "{}",
  });

  assert.equal(busy.status, 500);
  assert.deepEqual(await busy.json(), {
    error: {
      code: "INTERNAL_ERROR",
      message: "read-only MCP is temporarily busy",
    },
  });
  assert.equal(repository.findAllCalls, 1);
  assert.ok(releaseSearch);
  releaseSearch([]);
  const completed = await blockedSearch;
  assert.equal(completed.isError, undefined);
  assert.deepEqual(completed.structuredContent, {
    query: null,
    offset: 0,
    limit: 20,
    total: 0,
    next_offset: null,
    items: [],
  });
  const reusable = await client.callTool({
    name: searchInventoryToolName,
    arguments: {},
  });
  assert.equal(reusable.isError, undefined);
  assert.equal(repository.findAllCalls, 2);
});

test("read-only MCP returns a safe error when the search candidate cap is exceeded", async (context) => {
  class OversizedRepository extends SqliteInventoryRepository {
    override async findAll(): Promise<readonly InventoryItem[]> {
      return Array.from({ length: 1_001 }, (_, index) =>
        createInventoryItem({
          id: `oversized-${index.toString().padStart(4, "0")}`,
          lifecycleStatus: "unopened",
        }),
      );
    }
  }

  const repository = new OversizedRepository(":memory:");
  const application = new InventoryApplicationService(repository);
  const server = createReadOnlyInventoryMcpServer(application);
  const client = new Client({ name: "bounded-search-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
    repository.close();
  });

  const result = await client.callTool({
    name: searchInventoryToolName,
    arguments: { query: "oversized-1000" },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    code: "INTERNAL_ERROR",
    message: "inventory search exceeds the 1000-item safety limit",
  });
  assert.equal(JSON.stringify(result).includes("oversized-1000"), false);
});

test("read-only MCP constrains configurable result byte limits", (context) => {
  const repository = new SqliteInventoryRepository(":memory:");
  context.after(() => repository.close());
  const application = new InventoryApplicationService(repository);

  assert.throws(
    () =>
      createReadOnlyInventoryMcpServer(application, {
        maximumResultBytes: 511,
      }),
    /maximumResultBytes must be an integer between 512 and 262144/u,
  );
  assert.throws(
    () =>
      createReadOnlyMcpRoute(application, {
        publicOrigin: "https://127.0.0.1",
        verifyAccessJwt: async () => undefined,
        maximumResultBytes: 262_145,
      }),
    /maximumResultBytes must be an integer between 512 and 262144/u,
  );
  assert.throws(
    () =>
      createReadOnlyMcpRoute(application, {
        publicOrigin: "https://127.0.0.1",
        verifyAccessJwt: async () => undefined,
        maximumConcurrentRequests: 9,
      }),
    /maximumConcurrentRequests must be an integer between 1 and 8/u,
  );
});

test("read-only MCP rejects an oversized result before it reaches the wire", async (context) => {
  const fixture = await createInventoryFixture(context);
  const server = createReadOnlyInventoryMcpServer(fixture.application, {
    maximumResultBytes: 512,
  });
  const client = new Client({ name: "result-limit-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: fetchInventoryItemToolName,
    arguments: { inventory_item_id: fixture.inventoryItemId },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    code: "INTERNAL_ERROR",
    message: "read-only inventory result is too large",
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 512);
});

test("core API keeps the MCP path absent when the feature is disabled", async (context) => {
  const fixture = await createInventoryFixture(context);
  const server = createServer(
    createCoreApiHandler(fixture.application, {
      customGptBearerToken: CUSTOM_GPT_TOKEN,
      actionBearerToken: ACTION_TOKEN,
      adminBearerToken: ADMIN_TOKEN,
      actionFileHosts: new Set(["files.example.test"]),
    }),
  );
  await listen(server);
  const address = server.address() as AddressInfo;
  context.after(async () => closeServer(server));

  assert.equal((await fetch(`http://127.0.0.1:${address.port}/mcp`)).status, 404);
  assert.equal(
    (await fetch(`http://127.0.0.1:${address.port}/mcp/anything`)).status,
    404,
  );
});

async function createInventoryFixture(context: TestContext): Promise<{
  readonly application: InventoryApplicationService;
  readonly inventoryItemId: string;
}> {
  const repository = new SqliteInventoryRepository(":memory:");
  const application = new InventoryApplicationService(repository);
  const created = await application.createInventoryBatch({
    as_of: "2026-08-21",
    products: [
      {
        batch_ref: "read_product",
        name: "Remote serum",
        alias: "Purple Jar",
        category: "serum",
        size_label: "30 ml",
        image_asset_id: null,
        ingredient_list_text: "Aqua,\nGlycerin",
        shared_notes: "Shared note",
      },
    ],
    inventory_items: [
      {
        batch_ref: "read_bottle",
        product_ref: { kind: "new", batch_ref: "read_product" },
        lifecycle_status: "opened",
        opened_on: "2026-08-01",
        opened_on_accuracy: "exact",
        expires_on: "2027-12-31",
        pao_duration_months: 6,
        custom_notes: "Bottle note",
      },
    ],
  });
  const inventoryItemId = created.inventory_items[0]?.inventory_item_id;
  assert.ok(inventoryItemId !== undefined);
  context.after(() => repository.close());
  return { application, inventoryItemId };
}

function textJson(result: {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}): unknown {
  const first = result.content[0];
  assert.equal(first?.type, "text");
  assert.equal(typeof first.text, "string");
  return JSON.parse(first.text ?? "");
}

function mappedFetch(
  localOrigin: string,
  assertion: string,
  onResponse?: (request: Request, response: Response) => void,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const externalUrl = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("cf-access-jwt-assertion", assertion);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? await request.arrayBuffer() : undefined;
    const response = await fetch(
      `${localOrigin}${externalUrl.pathname}${externalUrl.search}`,
      {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: request.signal,
      redirect: "manual",
      },
    );
    onResponse?.(request, response);
    return response;
  };
}

function requestStatus(
  port: number,
  headers: Readonly<Record<string, string>>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from("{}");
    const request = makeHttpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          ...headers,
          "content-length": String(body.byteLength),
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

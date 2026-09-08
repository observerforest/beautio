import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { BeautioError } from "@beautio/domain";
import { createCustomGptReadRoute } from "../src/custom-gpt-read-route.ts";
import { customGptToken, readFixture } from "./custom-gpt-read-fixture.ts";

const search = "/api/actions/inventory/search";
const fetchItem = "/api/actions/inventory/fetch";

test("read quota rejects extra requests and recovers after successful and failed work", async (context) => {
  const fixture = await readFixture(context, { customGptReadLimits: { maximumConcurrentRequests: 1 } });
  const original = fixture.reads.searchInventory.bind(fixture.reads);
  for (const fail of [false, true]) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.reads.searchInventory = async (input) => {
      entered.resolve();
      await release.promise;
      if (fail) throw new Error("private provider exception");
      return original(input);
    };
    const first = fixture.post(search, {});
    try {
      await entered.promise;
      assert.equal((await fixture.post(search, {})).status, 503);
    } finally {
      release.resolve();
    }
    assert.equal((await first).status, fail ? 500 : 200);
    fixture.reads.searchInventory = original;
    assert.equal((await fixture.post(search, {})).status, 200);
  }
});

test("disconnect does not free a slot before the underlying read settles", async (context) => {
  const fixture = await readFixture(context, { customGptReadLimits: { maximumConcurrentRequests: 1 } });
  const original = fixture.reads.searchInventory.bind(fixture.reads);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  fixture.reads.searchInventory = async (input) => { entered.resolve(); await release.promise; return original(input); };
  const client = httpRequest(fixture.origin + search, {
    method: "POST", headers: { authorization: `Bearer ${customGptToken}`, "content-type": "application/json" },
  });
  client.on("error", () => undefined);
  client.end("{}");
  try {
    await entered.promise;
    const closed = new Promise<void>((resolve) => client.once("close", resolve));
    client.destroy();
    await closed;
    assert.equal((await fixture.post(search, {})).status, 503);
  } finally { release.resolve(); client.destroy(); }
  await nextTurn();
  fixture.reads.searchInventory = original;
  assert.equal((await fixture.post(search, {})).status, 200);
});

test("read response bounds count complete UTF-8 bytes and never send truncated success", async (context) => {
  const fixture = await readFixture(context, { customGptReadLimits: { maximumResultBytes: 1900 } });
  const original = fixture.reads.fetchInventoryItem.bind(fixture.reads);
  const output = await original({ inventory_item_id: "a-active" });
  assert.ok(output.inventory_item.product);
  const largeOutput = { ...output, inventory_item: { ...output.inventory_item,
    product: { ...output.inventory_item.product, shared_notes: "界".repeat(500) },
  } };
  assert.ok(JSON.stringify(largeOutput).length < 1900);
  assert.ok(Buffer.byteLength(JSON.stringify(largeOutput), "utf8") > 1900);
  fixture.reads.fetchInventoryItem = async () => largeOutput;
  const response = await fixture.post(fetchItem, { inventory_item_id: "a-active" });
  assert.equal(response.status, 422);
  const rejected = await response.text();
  assert.match(rejected, /RESPONSE_TOO_LARGE/);
  assert.match(rejected, /1900-byte/);
  assert.doesNotMatch(rejected, /inventory_item|界/);
  fixture.reads.fetchInventoryItem = original;
  assert.equal((await fixture.post(fetchItem, { inventory_item_id: "a-active" })).status, 200);
});

test("read output rejects unknown fields and errors never expose provider messages or refs", async (context) => {
  const fixture = await readFixture(context);
  const original = fixture.reads.searchInventory.bind(fixture.reads);
  fixture.reads.searchInventory = async (input) => ({ ...await original(input), storage_key: "private-test-path" });
  let response = await fixture.post(search, {});
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /storage_key|private-test/);
  for (const error of [new Error("private-test-stack"), new BeautioError("INVALID_INPUT", "private-test-message", "private-test-ref")]) {
    fixture.reads.searchInventory = async () => { throw error; };
    response = await fixture.post(search, {});
    assert.equal(response.status, error instanceof BeautioError ? 400 : 500);
    assert.doesNotMatch(await response.text(), /private-test|stack|ref/);
  }
});

test("invalid resource options cannot enlarge the maximum boundaries", async (context) => {
  const { reads } = await readFixture(context);
  for (const value of [0, 9, 1.5, Infinity, NaN]) assert.throws(() => createCustomGptReadRoute(reads, { maximumConcurrentRequests: value }));
  for (const value of [511, 100000, 262144, 512.5, Infinity, NaN]) assert.throws(() => createCustomGptReadRoute(reads, { maximumResultBytes: value }));
  assert.doesNotThrow(() => createCustomGptReadRoute(reads, { maximumConcurrentRequests: 8, maximumResultBytes: 99999 }));
});

test("read bodies reject wrong content type, invalid JSON and over 64 KiB without invoking reads", async (context) => {
  const fixture = await readFixture(context);
  let calls = 0;
  const original = fixture.reads.searchInventory.bind(fixture.reads);
  fixture.reads.searchInventory = async (input) => { calls++; return original(input); };
  for (const [contentType, body, expected] of [
    ["text/plain", "{}", 400], ["application/json", "{", 400],
    ["application/json", JSON.stringify({ query: "x".repeat(64 * 1024) }), 413],
  ] as const) {
    const response = await fetch(fixture.origin + search, {
      method: "POST", headers: { authorization: `Bearer ${customGptToken}`, "content-type": contentType }, body,
    });
    assert.equal(response.status, expected);
  }
  assert.equal(calls, 0);
  assert.equal((await fixture.post(search, {})).status, 200);
  assert.equal(calls, 1);
});

test("body deadline closes an unfinished request and restores the read slot", { timeout: 10000 }, async (context) => {
  const fixture = await readFixture(context, { writeBodyTimeoutMs: 300, customGptReadLimits: { maximumConcurrentRequests: 1 } });
  let calls = 0;
  const original = fixture.reads.searchInventory.bind(fixture.reads);
  fixture.reads.searchInventory = async (input) => { calls++; return original(input); };
  const arrived = new Promise<void>((resolve) => fixture.server.once("request", () => resolve()));
  const closed = Promise.withResolvers<void>();
  const pending = new Promise<{ status: number | undefined; connection: string | undefined }>((resolve, reject) => {
    const request = httpRequest(fixture.origin + search, {
      method: "POST", headers: { authorization: `Bearer ${customGptToken}`, "content-type": "application/json", "transfer-encoding": "chunked" },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode, connection: response.headers.connection }));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.once("close", () => closed.resolve());
    request.write("{");
    // Deliberately never send the end of the request body.
  });
  await arrived;
  assert.equal(calls, 0);
  assert.equal((await fixture.post(search, {})).status, 503);
  const result = await pending;
  await closed.promise;
  assert.equal(result.status, 400);
  assert.equal(result.connection, "close");
  assert.equal(calls, 0);
  assert.equal((await fixture.post(search, {})).status, 200);
  assert.equal(calls, 1);
});

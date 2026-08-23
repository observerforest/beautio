import assert from "node:assert/strict";
import test from "node:test";
import { parseApiHost } from "../src/api-host.ts";

test("API host defaults to loopback and accepts explicit container interfaces", () => {
  assert.equal(parseApiHost(undefined), "127.0.0.1");
  assert.equal(parseApiHost("0.0.0.0"), "0.0.0.0");
  assert.equal(parseApiHost(" :: "), "::");
  assert.equal(parseApiHost("localhost"), "localhost");
  assert.equal(parseApiHost("beautio-api.internal"), "beautio-api.internal");
});

test("API host rejects empty, URL-shaped, port-bearing, and malformed values", () => {
  for (const value of [
    "",
    "   ",
    "http://0.0.0.0",
    "0.0.0.0:8787",
    "[::]",
    "beautio_api",
    "-beautio.internal",
    "beautio-.internal",
    "beautio/internal",
    `${"a".repeat(64)}.internal`,
  ]) {
    assert.throws(
      () => parseApiHost(value),
      /BEAUTIO_API_HOST must be a valid non-empty host/,
      value,
    );
  }
});

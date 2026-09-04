import assert from "node:assert/strict";
import test from "node:test";
import { routeId } from "../src/path-segment.ts";

interface RouteConsumer {
  readonly name: string;
  readonly prefix: string;
  readonly suffix: string;
}

const CONSUMERS = [
  {
    name: "product with an empty suffix",
    prefix: "/api/admin/products/",
    suffix: "",
  },
  {
    name: "inventory facts",
    prefix: "/api/admin/inventory-items/",
    suffix: "/facts",
  },
  {
    name: "inventory custom notes",
    prefix: "/api/admin/inventory-items/",
    suffix: "/custom-notes",
  },
  {
    name: "inventory end use",
    prefix: "/api/admin/inventory-items/",
    suffix: "/end-use",
  },
  {
    name: "image content",
    prefix: "/api/image-assets/",
    suffix: "/content",
  },
] as const satisfies readonly RouteConsumer[];

function pathnameFor(consumer: RouteConsumer, rawSegment: string): string {
  return `${consumer.prefix}${rawSegment}${consumer.suffix}`;
}

function assertAcceptedByEveryConsumer(
  rawSegment: string,
  expected: string,
): void {
  for (const consumer of CONSUMERS) {
    assert.equal(
      routeId(
        pathnameFor(consumer, rawSegment),
        consumer.prefix,
        consumer.suffix,
      ),
      expected,
      consumer.name,
    );
  }
}

function assertRejectedByEveryConsumer(rawSegment: string): void {
  for (const consumer of CONSUMERS) {
    assert.equal(
      routeId(
        pathnameFor(consumer, rawSegment),
        consumer.prefix,
        consumer.suffix,
      ),
      null,
      consumer.name,
    );
  }
}

test("routeId accepts ordinary identifiers for all five route consumers", () => {
  const uuid = "7d6c06b1-d390-4a31-ae7d-360e5d931d43";
  assertAcceptedByEveryConsumer(uuid, uuid);
});

test("routeId decodes safe identifiers exactly once without trimming or Unicode normalization", () => {
  const nfc = "caf\u00e9";
  const nfd = "cafe\u0301";

  assertAcceptedByEveryConsumer(encodeURIComponent(nfc), nfc);
  assertAcceptedByEveryConsumer(encodeURIComponent(nfd), nfd);
  assertAcceptedByEveryConsumer("%20%20id%20%20", "  id  ");
  assertAcceptedByEveryConsumer("abc%25nothex", "abc%nothex");
});

test("routeId rejects encoded forward slashes and backslashes in either hex case", () => {
  for (const rawSegment of ["a%2fb", "a%2Fb", "a%5cb", "a%5Cb"]) {
    assertRejectedByEveryConsumer(rawSegment);
  }
});

test("routeId rejects double-encoded reserved or ambiguous sequences", () => {
  for (const rawSegment of [
    "a%252Fb",
    "a%255Cb",
    "a%252Eb",
    "a%2525b",
  ]) {
    assertRejectedByEveryConsumer(rawSegment);
  }
});

test("routeId rejects triple-encoded reserved sequences", () => {
  assertRejectedByEveryConsumer("a%25252Fb");
});

test("routeId rejects bare percent signs, malformed escapes, and invalid UTF-8", () => {
  for (const rawSegment of ["%", "%2", "%GG", "%E4%B8", "%C0%AF"]) {
    assertRejectedByEveryConsumer(rawSegment);
  }
});

test("routeId rejects C0, C1, and DEL control characters after decoding", () => {
  for (const control of ["\u0000", "\u001f", "\u007f", "\u0080", "\u009f"]) {
    assertRejectedByEveryConsumer(encodeURIComponent(control));
  }
});

test("routeId rejects dot segments directly without relying on URL normalization", () => {
  for (const rawSegment of [".", "..", "%2e", "%2E", "%2e%2e", "%2E%2E"]) {
    assertRejectedByEveryConsumer(rawSegment);
  }
});

test("routeId applies the raw-segment limit before decoding", () => {
  const exactly2048RawCodeUnits = `aa${"%41".repeat(682)}`;
  const exactly2049RawCodeUnits = "%41".repeat(683);

  assert.equal(exactly2048RawCodeUnits.length, 2_048);
  assertAcceptedByEveryConsumer(
    exactly2048RawCodeUnits,
    `aa${"A".repeat(682)}`,
  );
  assert.equal(exactly2049RawCodeUnits.length, 2_049);
  assertRejectedByEveryConsumer(exactly2049RawCodeUnits);
});

test("routeId enforces the decoded-segment limit inclusively", () => {
  assertAcceptedByEveryConsumer("a".repeat(1_024), "a".repeat(1_024));
  assertRejectedByEveryConsumer("a".repeat(1_025));
});

test("routeId counts percent-encoded multibyte Unicode against the raw limit", () => {
  const encodedCharacter = encodeURIComponent("界");
  const withinRawLimit = encodedCharacter.repeat(227);
  const beyondRawLimit = encodedCharacter.repeat(228);

  assert.equal(encodedCharacter.length, 9);
  assert.ok(withinRawLimit.length <= 2_048);
  assert.ok(beyondRawLimit.length > 2_048);
  assertAcceptedByEveryConsumer(withinRawLimit, "界".repeat(227));
  assertRejectedByEveryConsumer(beyondRawLimit);
});

test("routeId rejects empty, overlapping, mismatched, and trailing-slash shapes", () => {
  for (const consumer of CONSUMERS) {
    assert.equal(
      routeId(
        pathnameFor(consumer, ""),
        consumer.prefix,
        consumer.suffix,
      ),
      null,
      `${consumer.name}: empty segment`,
    );
    assert.equal(
      routeId(
        pathnameFor(consumer, "id"),
        `${consumer.prefix}wrong/`,
        consumer.suffix,
      ),
      null,
      `${consumer.name}: wrong prefix`,
    );
    assert.equal(
      routeId(
        pathnameFor(consumer, "id"),
        consumer.prefix,
        `${consumer.suffix}/wrong`,
      ),
      null,
      `${consumer.name}: wrong suffix`,
    );
    assert.equal(
      routeId(
        `${pathnameFor(consumer, "id")}/`,
        consumer.prefix,
        consumer.suffix,
      ),
      null,
      `${consumer.name}: trailing slash`,
    );
  }

  assert.equal(routeId("/api/id", "/api/id", "id"), null);
});

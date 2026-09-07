import assert from "node:assert/strict";
import test from "node:test";
import {
  consequentialCommandOperationIds,
  customGptCreateCommandInputSchema,
  customGptCreateCommandMaximumResponseBytes,
  customGptFetchOutputSchema,
  customGptImageCommandMaximumResponseBytes,
  customGptSearchOutputSchema,
  customGptUploadImagesCommandInputSchema,
} from "@beautio/contracts";
import { JSON_BODY_LIMIT } from "../src/body.ts";

const ACTION_CHARACTER_LIMIT = 100_000;
const STANDARD_ACTION_REQUEST_LIMIT_BYTES = 64 * 1024;
const WRITE_ACTION_RESPONSE_LIMIT_BYTES = 8 * 1024;
const READ_ACTION_RESPONSE_LIMIT_BYTES = 256 * 1024;

const standardRequestOperations = [
  "search_inventory",
  "fetch_inventory_item",
  "get_command_status",
  "revise_product_profile",
  "set_product_display_image",
  "correct_inventory_item_facts",
  "set_inventory_item_custom_notes",
  "record_product_opened",
  "end_inventory_item_use",
] as const;

// These are pure in-memory schema and serialization regressions for a known
// Actions transport compatibility gap, not Custom GPT Builder acceptance tests;
// they do not alter any runtime cap or business limit.
test("known Actions transport gap: a valid 25-Product, 100-bottle create can exceed 100000 characters below one MiB", () => {
  const ascii = customGptCreateCommandInputSchema.parse(createInput("a"));
  const cjk = customGptCreateCommandInputSchema.parse(createInput("界"));
  assert.equal(ascii.products.length, 25);
  assert.equal(ascii.inventory_items.length, 100);
  assert.equal(cjk.products.length, 25);
  assert.equal(cjk.inventory_items.length, 100);

  const asciiSize = serializedSize(ascii);
  const cjkSize = serializedSize(cjk);
  assert.ok(asciiSize.codePoints > ACTION_CHARACTER_LIMIT);
  assert.equal(asciiSize.codePoints, asciiSize.utf16CodeUnits);
  assert.equal(asciiSize.utf16CodeUnits, asciiSize.utf8Bytes);
  assert.ok(asciiSize.utf8Bytes < JSON_BODY_LIMIT);
  assert.equal(cjkSize.codePoints, asciiSize.codePoints);
  assert.equal(cjkSize.utf16CodeUnits, asciiSize.utf16CodeUnits);
  assert.ok(cjkSize.utf8Bytes > cjkSize.utf16CodeUnits);
  assert.ok(cjkSize.utf8Bytes < JSON_BODY_LIMIT);
});

test("known Actions transport gap: a valid runtime upload reference can exceed 100000 characters below one MiB", () => {
  const upload = customGptUploadImagesCommandInputSchema.parse({
    command_id: commandId(2),
    openaiFileIdRefs: [{
      name: `${"u".repeat(100_001)}.png`,
      id: "synthetic-file-1",
      mime_type: "image/png",
      download_link: "https://files.example.test/synthetic.png",
    }],
  });
  const size = serializedSize(upload);
  assert.ok(size.codePoints > ACTION_CHARACTER_LIMIT);
  assert.equal(size.codePoints, size.utf16CodeUnits);
  assert.equal(size.utf16CodeUnits, size.utf8Bytes);
  assert.ok(size.utf8Bytes < JSON_BODY_LIMIT);
});

test("known Actions transport gap: valid search and fetch outputs can exceed 100000 characters below 256 KiB", () => {
  const search = customGptSearchOutputSchema.parse({
    query: null,
    offset: 0,
    limit: 50,
    total: 50,
    next_offset: null,
    scope: "active",
    items: Array.from({ length: 50 }, (_, index) => ({
      inventory_item_id: `synthetic-bottle-${index}`,
      product_id: `synthetic-product-${index}`,
      product_name: "s".repeat(2_200),
      alias: null,
      brand: null,
      category: null,
      size_label: null,
      lifecycle_status: "unopened",
      opened_on: null,
      expires_on: null,
      usable_until: null,
      remaining_percent_estimate: null,
      has_image: false,
      derived_status: null,
    })),
  });
  const fetch = customGptFetchOutputSchema.parse({
    inventory_item: {
      inventory_item_id: "synthetic-bottle",
      product_id: "synthetic-product",
      product: {
        product_id: "synthetic-product",
        name: "f".repeat(100_100),
        alias: null,
        brand: null,
        category: null,
        size_label: null,
        pao_duration_months: null,
        ingredient_list_text: null,
        shared_notes: null,
        has_image: false,
        revision: 1,
      },
      lifecycle_status: "unopened",
      opened_on: null,
      opened_on_accuracy: null,
      expires_on: null,
      pao_duration_months: null,
      pao_deadline: null,
      pao_deadline_accuracy: null,
      usable_until: null,
      remaining_percent_estimate: null,
      custom_notes: null,
      derived_status: null,
      revision: 1,
    },
    display_image_matches_expected: null,
  });

  for (const [label, output] of [["search", search], ["fetch", fetch]] as const) {
    const size = serializedSize(output);
    assert.ok(size.codePoints > ACTION_CHARACTER_LIMIT, `${label} character count`);
    assert.equal(size.codePoints, size.utf16CodeUnits, `${label} ASCII code-point count`);
    assert.equal(size.utf16CodeUnits, size.utf8Bytes, `${label} ASCII byte count`);
    assert.ok(size.utf8Bytes < READ_ACTION_RESPONSE_LIMIT_BYTES, `${label} read byte limit`);
  }
});

test("known Actions transport gap: only strict sub-100000 and conservative byte-cap relationships are established locally", () => {
  const belowBoundary = serializedSize("x".repeat(99_997));
  const atBoundary = serializedSize("x".repeat(99_998));
  assert.deepEqual(
    [belowBoundary.codePoints, belowBoundary.utf16CodeUnits, belowBoundary.utf8Bytes],
    [99_999, 99_999, 99_999],
  );
  assert.deepEqual(
    [atBoundary.codePoints, atBoundary.utf16CodeUnits, atBoundary.utf8Bytes],
    [100_000, 100_000, 100_000],
  );
  assert.equal(belowBoundary.codePoints < ACTION_CHARACTER_LIMIT, true);
  assert.equal(atBoundary.codePoints < ACTION_CHARACTER_LIMIT, false);

  assert.equal(standardRequestOperations.length, 9);
  assert.equal(consequentialCommandOperationIds.length, 8);
  for (const operation of standardRequestOperations) {
    assert.ok(STANDARD_ACTION_REQUEST_LIMIT_BYTES < ACTION_CHARACTER_LIMIT, operation);
  }
  for (const operation of consequentialCommandOperationIds) {
    assert.ok(WRITE_ACTION_RESPONSE_LIMIT_BYTES < ACTION_CHARACTER_LIMIT, operation);
  }
  assert.equal(customGptCreateCommandMaximumResponseBytes, WRITE_ACTION_RESPONSE_LIMIT_BYTES);
  assert.equal(customGptImageCommandMaximumResponseBytes, WRITE_ACTION_RESPONSE_LIMIT_BYTES);

  // This arithmetic does not claim that the one MiB create/upload requests or
  // 256 KiB read responses are compatible, and it does not change either cap.
  assert.equal(JSON_BODY_LIMIT, 1024 * 1024);
  assert.equal(READ_ACTION_RESPONSE_LIMIT_BYTES, 256 * 1024);
});

function createInput(content: string) {
  const products = Array.from({ length: 25 }, (_, index) => ({
    batch_ref: `synthetic_product_${index}`,
    name: `Synthetic Product ${index}`,
    ingredient_list_text: content.repeat(5_000),
    shared_notes: content.repeat(1_000),
  }));
  return {
    command_id: commandId(1),
    as_of: "2026-09-07",
    products,
    inventory_items: Array.from({ length: 100 }, (_, index) => ({
      batch_ref: `synthetic_bottle_${index}`,
      product_ref: {
        kind: "new" as const,
        batch_ref: `synthetic_product_${index % products.length}`,
      },
      lifecycle_status: "unopened" as const,
      custom_notes: content.repeat(1_000),
    })),
  };
}

function commandId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function serializedSize(value: unknown): {
  readonly codePoints: number;
  readonly utf16CodeUnits: number;
  readonly utf8Bytes: number;
} {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("synthetic value is not JSON serializable");
  }
  return {
    codePoints: Array.from(serialized).length,
    utf16CodeUnits: serialized.length,
    utf8Bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

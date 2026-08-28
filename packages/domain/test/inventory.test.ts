import assert from "node:assert/strict";
import test from "node:test";
import {
  BeautioError,
  addCalendarMonthsClamped,
  createInventoryItem,
  createInventoryItemFromFacts,
  createProduct,
  deriveInventorySnapshot,
  openInventoryItem,
  parseIsoDate,
} from "../src/index.ts";

test("BD-DATA-001 positive 1: PAO is the earlier usable deadline", () => {
  const item = createInventoryItem({
    id: "night-queen-pao-first",
    lifecycleStatus: "unopened",
    expiresOn: "2028-01-01",
    paoDurationMonths: 12,
  });

  const result = openInventoryItem(
    item,
    parseIsoDate("2026-08-18", "opened_on"),
  );

  assert.equal(result.outcome, "opened");
  assert.equal(result.snapshot.paoDeadline, "2027-08-18");
  assert.equal(result.snapshot.usableUntil, "2027-08-18");
  assert.equal(result.snapshot.usabilityStatus, "usable");
  assert.deepEqual(result.snapshot.warnings, []);
});

test("BD-DATA-001 positive 2: packaging expiry is the earlier usable deadline", () => {
  const item = createInventoryItem({
    id: "night-queen-expiry-first",
    lifecycleStatus: "unopened",
    expiresOn: "2027-03-01",
    paoDurationMonths: 12,
  });

  const result = openInventoryItem(
    item,
    parseIsoDate("2026-08-18", "opened_on"),
  );

  assert.equal(result.snapshot.paoDeadline, "2027-08-18");
  assert.equal(result.snapshot.usableUntil, "2027-03-01");
});

test("BD-DATA-001 positive 3: unknown PAO does not block opening", () => {
  const item = createInventoryItem({
    id: "night-queen-unknown-pao",
    lifecycleStatus: "unopened",
    expiresOn: "2027-03-01",
    paoDurationMonths: null,
  });

  const result = openInventoryItem(
    item,
    parseIsoDate("2026-08-18", "opened_on"),
  );

  assert.equal(result.snapshot.paoDeadline, null);
  assert.equal(result.snapshot.usableUntil, "2027-03-01");
  assert.deepEqual(result.snapshot.warnings, ["pao_unknown"]);
});

test("BD-DATA-001 positive 4: an already expired item still records the opening fact", () => {
  const item = createInventoryItem({
    id: "night-queen-expired",
    lifecycleStatus: "unopened",
    expiresOn: "2026-08-17",
    paoDurationMonths: null,
  });

  const result = openInventoryItem(
    item,
    parseIsoDate("2026-08-18", "opened_on"),
  );

  assert.equal(result.item.lifecycleStatus, "opened");
  assert.equal(result.snapshot.usabilityStatus, "expired");
  assert.deepEqual(result.snapshot.warnings, [
    "already_expired",
    "pao_unknown",
  ]);
});

test("BD-DATA-001 positive 5: same-date retry is idempotent", () => {
  const unopened = createInventoryItem({
    id: "night-queen-idempotent",
    lifecycleStatus: "unopened",
    expiresOn: "2028-01-01",
    paoDurationMonths: 12,
  });
  const openedOn = parseIsoDate("2026-08-18", "opened_on");
  const first = openInventoryItem(unopened, openedOn);
  const retry = openInventoryItem(first.item, openedOn);

  assert.equal(retry.outcome, "already_opened");
  assert.strictEqual(retry.item, first.item);
  assert.deepEqual(retry.snapshot, first.snapshot);
});

test("month arithmetic clamps to the last real day", () => {
  assert.equal(
    addCalendarMonthsClamped(parseIsoDate("2027-01-31", "date"), 1),
    "2027-02-28",
  );
  assert.equal(
    addCalendarMonthsClamped(parseIsoDate("2028-01-31", "date"), 1),
    "2028-02-29",
  );
});

test("usable-until remains usable on the boundary date", () => {
  const item = createInventoryItem({
    id: "boundary-date",
    lifecycleStatus: "unopened",
    expiresOn: "2026-08-18",
    paoDurationMonths: null,
  });
  const result = openInventoryItem(
    item,
    parseIsoDate("2026-08-18", "opened_on"),
  );

  assert.equal(result.snapshot.usabilityStatus, "usable");
});

test("BD-DATA-001 negative 2: a different opening date conflicts", () => {
  const opened = createInventoryItem({
    id: "night-queen-conflict",
    lifecycleStatus: "opened",
    openedOn: "2026-08-18",
    expiresOn: "2028-01-01",
    paoDurationMonths: 12,
    paoDeadline: "2027-08-18",
    usableUntil: "2027-08-18",
  });

  assertBeautioError(
    () =>
      openInventoryItem(
        opened,
        parseIsoDate("2026-08-19", "opened_on"),
      ),
    "OPENED_ON_CONFLICT",
  );
});

test("BD-DATA-001 negative 3: finished and discarded items are terminal", () => {
  for (const lifecycleStatus of ["finished", "discarded"] as const) {
    const terminal = createInventoryItem({
      id: `night-queen-${lifecycleStatus}`,
      lifecycleStatus,
      expiresOn: "2028-01-01",
      paoDurationMonths: 12,
    });

    assertBeautioError(
      () =>
        openInventoryItem(
          terminal,
          parseIsoDate("2026-08-18", "opened_on"),
        ),
      "INVENTORY_ITEM_TERMINAL",
    );
  }
});

test("BD-DATA-001 negative 1: impossible calendar dates are invalid", () => {
  assertBeautioError(
    () => parseIsoDate("2026-02-30", "opened_on"),
    "INVALID_INPUT",
  );
  assertBeautioError(
    () =>
      createInventoryItem({
        id: "bottle-trailing-surrogate",
        lifecycleStatus: "unopened",
        customNotes: "invalid\ud800",
      }),
    "INVALID_INPUT",
  );
  assertBeautioError(
    () =>
      createProduct({
        id: "product-edge-control",
        name: "Serum",
        sharedNotes: "\u000bnot trim-safe\u000c",
      }),
    "INVALID_INPUT",
  );
});

test("BD-DATA-002 Product keeps genuinely missing shared facts as null", () => {
  const product = createProduct({ id: "product-minimal", name: "  Serum  " });

  assert.deepEqual(product, {
    id: "product-minimal",
    name: "Serum",
    alias: null,
    brand: null,
    category: null,
    sizeLabel: null,
    imageAssetId: null,
    imageRef: null,
    ingredientListText: null,
    sharedNotes: null,
  });
});

test("BD-DATA-004 normalizes Product shared text and bottle custom notes", () => {
  const product = createProduct({
    id: "product-with-text",
    name: "Serum",
    alias: "  Purple Jar  ",
    brand: "  Beautio Lab  ",
    ingredientListText: "  Water,\nGlycerin  ",
    sharedNotes: "  Reformulated package copy  ",
  });
  const item = createInventoryItem({
    id: "bottle-with-notes",
    lifecycleStatus: "finished",
    customNotes: "  Finished before travel  ",
  });

  assert.equal(product.ingredientListText, "Water,\nGlycerin");
  assert.equal(product.alias, "Purple Jar");
  assert.equal(product.brand, "Beautio Lab");
  assert.equal(product.sharedNotes, "Reformulated package copy");
  assert.equal(item.customNotes, "Finished before travel");
  assert.equal(
    createProduct({
      id: "product-empty-text",
      name: "Cream",
      ingredientListText: " \n ",
      sharedNotes: null,
    }).ingredientListText,
    null,
  );
  assert.equal(
    createInventoryItem({
      id: "bottle-empty-notes",
      lifecycleStatus: "unopened",
      customNotes: "   ",
    }).customNotes,
    null,
  );
});

test("Product aliases reject more than ten characters without truncation", () => {
  assert.throws(
    () =>
      createProduct({
        id: "product-alias-limit",
        name: "Serum",
        alias: "紫".repeat(11),
      }),
    (error: unknown) => {
      assert.ok(error instanceof BeautioError);
      assert.equal(error.code, "INVALID_INPUT");
      assert.equal(
        error.message,
        "product_alias must be at most 10 characters",
      );
      return true;
    },
  );
});

test("BD-DATA-004 rejects oversized private text without echoing it", () => {
  const oversizedIngredientText = "sensitive".repeat(626);

  assert.throws(
    () =>
      createProduct({
        id: "product-oversized",
        name: "Serum",
        ingredientListText: oversizedIngredientText,
      }),
    (error: unknown) => {
      assert.ok(error instanceof BeautioError);
      assert.equal(error.code, "INVALID_INPUT");
      assert.equal(error.message.includes(oversizedIngredientText), false);
      return true;
    },
  );
  assertBeautioError(
    () =>
      createInventoryItem({
        id: "bottle-oversized",
        lifecycleStatus: "unopened",
        customNotes: "x".repeat(1001),
      }),
    "INVALID_INPUT",
  );
  assertBeautioError(
    () =>
      createInventoryItem({
        id: "bottle-binary-notes",
        lifecycleStatus: "unopened",
        customNotes: "not binary\u0000text",
      }),
    "INVALID_INPUT",
  );
});

test("BD-DATA-004 facts and lifecycle transitions preserve custom notes", () => {
  const item = createInventoryItemFromFacts(
    { id: "noted-bottle", productId: "noted-product" },
    {
      lifecycleStatus: "unopened",
      openedOn: null,
      openedOnAccuracy: null,
      expiresOn: null,
      paoDurationMonths: 6,
      customNotes: "Keep this bottle upright",
    },
  );

  const opened = openInventoryItem(
    item,
    parseIsoDate("2026-08-20", "opened_on"),
  );

  assert.equal(opened.item.customNotes, "Keep this bottle upright");
  assert.equal(opened.snapshot.customNotes, "Keep this bottle upright");
});

test("BD-DATA-002 estimated opening accuracy flows into the PAO deadline", () => {
  const item = createInventoryItemFromFacts(
    { id: "estimated-bottle", productId: "estimated-product" },
    {
      lifecycleStatus: "opened",
      openedOn: "2026-08-01",
      openedOnAccuracy: "estimated",
      expiresOn: "2028-01-01",
      paoDurationMonths: 6,
    },
  );
  const snapshot = deriveInventorySnapshot(
    item,
    parseIsoDate("2026-08-19", "as_of"),
  );

  assert.equal(item.paoDeadline, "2027-02-01");
  assert.equal(snapshot.openedOnAccuracy, "estimated");
  assert.equal(snapshot.paoDeadlineAccuracy, "estimated");
});

test("BD-DATA-002 active lifecycle rejects incomplete or contradictory opening facts", () => {
  assertBeautioError(
    () =>
      createInventoryItemFromFacts(
        { id: "opened-without-accuracy", productId: "product-1" },
        {
          lifecycleStatus: "opened",
          openedOn: "2026-08-01",
          openedOnAccuracy: null,
          expiresOn: null,
          paoDurationMonths: null,
        },
      ),
    "INVALID_INPUT",
  );
  assertBeautioError(
    () =>
      createInventoryItemFromFacts(
        { id: "unopened-with-date", productId: "product-1" },
        {
          lifecycleStatus: "unopened",
          openedOn: "2026-08-01",
          openedOnAccuracy: "exact",
          expiresOn: null,
          paoDurationMonths: null,
        },
      ),
    "INVALID_INPUT",
  );
});

test("record_product_opened preserves prior accuracy on an already-opened item", () => {
  const opened = createInventoryItemFromFacts(
    { id: "already-exact", productId: "product-exact" },
    {
      lifecycleStatus: "opened",
      openedOn: "2026-08-18",
      openedOnAccuracy: "exact",
      expiresOn: null,
      paoDurationMonths: 12,
    },
  );

  const retry = openInventoryItem(
    opened,
    parseIsoDate("2026-08-18", "opened_on"),
  );

  assert.equal(retry.outcome, "already_opened");
  assert.equal(retry.item.openedOnAccuracy, "exact");
  assert.equal(retry.snapshot.paoDeadlineAccuracy, "exact");
});

function assertBeautioError(
  action: () => unknown,
  expectedCode: BeautioError["code"],
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof BeautioError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  BeautioError,
  addCalendarMonthsClamped,
  createInventoryItem,
  createInventoryItemFromFacts,
  createProduct,
  deriveInventorySnapshot,
  endInventoryItem,
  openInventoryItem,
  parseIsoDate,
  updateInventoryItemPao,
} from "../src/index.ts";

test("Product PAO validates durations and bottle recalculation preserves other direct facts", () => {
  for (const value of [0, -1, 1.5, 121, Number.NaN]) {
    assert.throws(() => createProduct({ id: "sample", name: "Sample", paoDurationMonths: value }), /integer from 1 through 120/u);
  }
  assert.equal(createProduct({ id: "sample", name: "Sample", paoDurationMonths: 12 }).paoDurationMonths, 12);
  const bottle = createInventoryItem({
    id: "sample", lifecycleStatus: "discarded", openedOn: "2026-01-31",
    expiresOn: "2026-02-15", paoDurationMonths: 12, customNotes: "Keep note",
  });
  const updated = updateInventoryItemPao(bottle, 1);
  assert.equal(updated.paoDeadline, "2026-02-28");
  assert.equal(updated.usableUntil, "2026-02-15");
  assert.equal(updated.lifecycleStatus, "discarded");
  assert.equal(updated.customNotes, "Keep note");
  assert.equal(updateInventoryItemPao(updated, null).paoDeadline, null);
  assert.equal(updateInventoryItemPao(updated, null).usableUntil, "2026-02-15");
});

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
    "exact",
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
    "estimated",
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
    "exact",
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
    "estimated",
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
  const first = openInventoryItem(unopened, openedOn, "exact");
  const retry = openInventoryItem(first.item, openedOn, "exact");

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
    "exact",
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
        "legacy_unknown",
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
          "exact",
        ),
      "INVENTORY_ITEM_TERMINAL",
    );
  }
});

test("end use records terminal snapshots while preserving prior bottle facts", () => {
  const opened = createInventoryItem({
    id: "end-use-domain",
    productId: "product-end-use",
    createdAt: "2026-07-01T00:00:00.000Z",
    lifecycleStatus: "opened",
    openedOn: "2026-08-01",
    openedOnAccuracy: "estimated",
    expiresOn: "2027-01-01",
    paoDurationMonths: 6,
    customNotes: "Keep this note",
  });

  const finished = endInventoryItem(opened, { lifecycleStatus: "finished" });
  const discarded = endInventoryItem(opened, {
    lifecycleStatus: "discarded",
    remainingPercentEstimate: 35,
  });
  const discardedUnknown = endInventoryItem(opened, {
    lifecycleStatus: "discarded",
    remainingPercentEstimate: null,
  });

  assert.equal(finished.lifecycleStatus, "finished");
  assert.equal(finished.remainingPercentEstimate, 0);
  assert.equal(discarded.lifecycleStatus, "discarded");
  assert.equal(discarded.remainingPercentEstimate, 35);
  assert.equal(discardedUnknown.remainingPercentEstimate, null);
  for (const terminal of [finished, discarded, discardedUnknown]) {
    assert.equal(terminal.productId, opened.productId);
    assert.equal(terminal.createdAt, opened.createdAt);
    assert.equal(terminal.openedOn, opened.openedOn);
    assert.equal(terminal.openedOnAccuracy, opened.openedOnAccuracy);
    assert.equal(terminal.expiresOn, opened.expiresOn);
    assert.equal(terminal.paoDeadline, opened.paoDeadline);
    assert.equal(terminal.usableUntil, opened.usableUntil);
    assert.equal(terminal.customNotes, opened.customNotes);
  }
  assert.equal(opened.lifecycleStatus, "opened");
  assert.equal(opened.remainingPercentEstimate, null);
  assert.equal(
    deriveInventorySnapshot(discarded, parseIsoDate("2026-09-01", "as_of"))
      .remainingPercentEstimate,
    35,
  );
});

test("end use rejects invalid remaining values and non-opened lifecycle states", () => {
  const opened = createInventoryItem({
    id: "strict-end-use",
    lifecycleStatus: "opened",
    openedOn: "2026-08-01",
  });
  for (const remainingPercentEstimate of [
    -1,
    101,
    12.5,
    Number.NaN,
  ]) {
    assertBeautioError(
      () =>
        endInventoryItem(opened, {
          lifecycleStatus: "discarded",
          remainingPercentEstimate,
        }),
      "INVALID_INPUT",
    );
  }

  assertBeautioError(
    () =>
      endInventoryItem(
        createInventoryItem({
          id: "unopened-end-use",
          lifecycleStatus: "unopened",
        }),
        { lifecycleStatus: "finished" },
      ),
    "INVALID_INPUT",
  );

  for (const lifecycleStatus of ["finished", "discarded"] as const) {
    assertBeautioError(
      () =>
        endInventoryItem(
          createInventoryItem({
            id: `repeat-${lifecycleStatus}`,
            lifecycleStatus,
            remainingPercentEstimate:
              lifecycleStatus === "finished" ? 0 : 25,
          }),
          { lifecycleStatus: "finished" },
        ),
      "INVENTORY_ITEM_TERMINAL",
    );
  }

  assert.equal(
    createInventoryItem({
      id: "legacy-finished-unknown",
      lifecycleStatus: "finished",
    }).remainingPercentEstimate,
    null,
  );
  assertBeautioError(
    () =>
      createInventoryItem({
        id: "invalid-finished-remaining",
        lifecycleStatus: "finished",
        remainingPercentEstimate: 1,
      }),
    "INVALID_INPUT",
  );
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
    paoDurationMonths: null,
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
    "exact",
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

test("record_product_opened is idempotent only for the same date and accuracy", () => {
  const accuracies = ["exact", "estimated", "legacy_unknown"] as const;
  for (const existingAccuracy of accuracies) {
    const opened = createInventoryItemFromFacts(
      { id: `already-${existingAccuracy}`, productId: "product-shared" },
      {
        lifecycleStatus: "opened",
        openedOn: "2026-08-18",
        openedOnAccuracy: existingAccuracy,
        expiresOn: null,
        paoDurationMonths: 12,
      },
    );
    const before = structuredClone(opened);

    const retry = openInventoryItem(
      opened,
      parseIsoDate("2026-08-18", "opened_on"),
      existingAccuracy,
    );
    assert.equal(retry.outcome, "already_opened");
    assert.strictEqual(retry.item, opened);
    assert.equal(retry.snapshot.paoDeadlineAccuracy, existingAccuracy);

    for (const requestedAccuracy of accuracies) {
      if (requestedAccuracy === existingAccuracy) {
        continue;
      }
      assertBeautioError(
        () =>
          openInventoryItem(
            opened,
            parseIsoDate("2026-08-18", "opened_on"),
            requestedAccuracy,
          ),
        "OPENED_ON_CONFLICT",
      );
      assert.deepEqual(opened, before);
    }

    assertBeautioError(
      () =>
        openInventoryItem(
          opened,
          parseIsoDate("2026-08-19", "opened_on"),
          existingAccuracy,
        ),
      "OPENED_ON_CONFLICT",
    );
    assert.deepEqual(opened, before);
  }
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

import assert from "node:assert/strict";
import test from "node:test";
import {
  inventoryListItemOutputSchema,
  type InventoryListItemOutput,
} from "@beautio/contracts";
import {
  accuracyLabel,
  canPreserveLegacyAccuracy,
  inventoryCardViews,
  lifecycleLabel,
  localDateForApi,
  managedImageAssetId,
  openedOnAccuracy,
  paoDeadlineAccuracy,
  productImageChoice,
  projectInventoryBrowse,
  summarizeInventory,
  type InventoryBrowseOptions,
  usabilityLabel,
  warningLabel,
} from "../src/view-model.ts";

test("inventory summary keeps lifecycle and usability counts independent", () => {
  const items: readonly InventoryListItemOutput[] = [
    createItem({ lifecycle_status: "opened", usability_status: "usable" }),
    createItem({ lifecycle_status: "unopened", usability_status: "unknown" }),
    createItem({
      lifecycle_status: "opened",
      usability_status: "usable",
      warnings: ["pao_unknown"],
    }),
  ];

  assert.deepEqual(summarizeInventory(items), {
    total: 3,
    opened: 2,
    usable: 2,
    attention: 2,
  });
});

test("the internal as_of value uses the browser-local calendar day", () => {
  assert.equal(localDateForApi(new Date(2026, 7, 18, 23, 59)), "2026-08-18");
  assert.throws(() => localDateForApi(new Date(Number.NaN)), RangeError);
});

test("one inventory item always produces one card with shared product facts", () => {
  const product = {
    product_id: "shared-product",
    name: "Example serum",
    category: "serum",
    size_label: "30 ml",
    image_asset_id: null,
    image_ref: "/fixtures/example-serum.webp",
    ingredient_list_text: "Water, Glycerin",
    shared_notes: null,
  } as const;
  const items: readonly InventoryListItemOutput[] = [
    createItem({
      inventory_item_id: "same-product-bottle-1",
      product_id: product.product_id,
      product,
      product_inventory_position: 1,
      product_inventory_count: 2,
      usable_until: "2027-01-31",
      usability_status: "usable",
    }),
    createItem({
      inventory_item_id: "same-product-bottle-2",
      product_id: product.product_id,
      product,
      product_inventory_position: 2,
      product_inventory_count: 2,
      usable_until: "2027-03-31",
      usability_status: "expired",
      warnings: ["already_expired"],
    }),
  ];

  assert.deepEqual(inventoryCardViews(items), [
    {
      inventoryItemId: "same-product-bottle-1",
      displayName: "Example serum",
      image: {
        kind: "legacy",
        imageRef: "/fixtures/example-serum.webp",
      },
      sizeLabel: "30 ml",
      bottleLabel: "第1瓶",
      usableUntilLabel: "可用至 2027-01-31",
      alerts: [],
      accessibleName:
        "Example serum，第1瓶，30 ml，可用至 2027-01-31，查看详情",
    },
    {
      inventoryItemId: "same-product-bottle-2",
      displayName: "Example serum",
      image: {
        kind: "legacy",
        imageRef: "/fixtures/example-serum.webp",
      },
      sizeLabel: "30 ml",
      bottleLabel: "第2瓶",
      usableUntilLabel: "可用至 2027-03-31",
      alerts: [{ label: "已过可用期", tone: "expired" }],
      accessibleName:
        "Example serum，第2瓶，30 ml，可用至 2027-03-31，已过可用期，查看详情",
    },
  ]);
});

test("a missing product stays explicit without an inferred name", () => {
  assert.deepEqual(inventoryCardViews([createItem({})])[0], {
    inventoryItemId: "inventory-test",
    displayName: "未记录产品名称",
    image: { kind: "none" },
    sizeLabel: "规格未记录",
    bottleLabel: null,
    usableUntilLabel: "可用期未知",
    alerts: [{ label: "期限未知", tone: "unknown" }],
    accessibleName:
      "未记录产品名称，规格未记录，可用期未知，期限未知，查看详情",
  });
});

test("terminal lifecycle stays visible as a compact card alert", () => {
  const view = inventoryCardViews([
    createItem({
      lifecycle_status: "discarded",
      usability_status: "usable",
      usable_until: "2027-01-31",
    }),
  ])[0];

  assert.deepEqual(view?.alerts, [{ label: "已弃置", tone: "terminal" }]);
});

test("contract labels remain explicit for every current state", () => {
  assert.equal(lifecycleLabel("unopened"), "未开封");
  assert.equal(lifecycleLabel("discarded"), "已弃置");
  assert.equal(usabilityLabel("expired"), "已过可用期");
  assert.match(warningLabel("pao_unknown"), /PAO/);
});

test("managed images and date accuracy remain explicit in the view model", () => {
  const item = createItem({
    lifecycle_status: "opened",
    opened_on: "2026-08-01",
    opened_on_accuracy: "estimated",
    pao_deadline: "2027-02-01",
    pao_deadline_accuracy: "estimated",
    usable_until: "2027-02-01",
    product_id: "product-one",
    product: {
      product_id: "product-one",
      name: "Example",
      category: null,
      size_label: null,
      image_asset_id: "asset-one",
      image_ref: "/legacy/example.webp",
      ingredient_list_text: null,
      shared_notes: "Shared note",
    },
  });

  assert.equal(managedImageAssetId(item), "asset-one");
  assert.deepEqual(productImageChoice(item), {
    kind: "managed",
    imageAssetId: "asset-one",
  });
  assert.deepEqual(inventoryCardViews([item])[0]?.image, {
    kind: "managed",
    imageAssetId: "asset-one",
  });
  assert.equal(
    inventoryCardViews([item])[0]?.usableUntilLabel,
    "可用至 2027-02-01（估算）",
  );
  assert.equal(openedOnAccuracy(item), "estimated");
  assert.equal(paoDeadlineAccuracy(item), "estimated");
  assert.equal(accuracyLabel("estimated"), "估算日期");
});

test("legacy accuracy can only survive an unchanged opened date", () => {
  const legacy = createItem({
    lifecycle_status: "opened",
    opened_on: "2026-08-01",
    opened_on_accuracy: "legacy_unknown",
  });

  assert.equal(
    canPreserveLegacyAccuracy(legacy, "opened", "2026-08-01"),
    true,
  );
  assert.equal(
    canPreserveLegacyAccuracy(legacy, "opened", "2026-08-02"),
    false,
  );
  assert.equal(
    canPreserveLegacyAccuracy(legacy, "unopened", null),
    false,
  );
  assert.equal(
    canPreserveLegacyAccuracy(
      createItem({
        lifecycle_status: "opened",
        opened_on: "2026-08-01",
        opened_on_accuracy: "exact",
      }),
      "opened",
      "2026-08-01",
    ),
    false,
  );
});

test("inventory browsing separates active and terminal archive states with source counts", () => {
  const items = [
    createItem({
      inventory_item_id: "opened",
      lifecycle_status: "opened",
      usability_status: "usable",
      product_id: "product-opened",
      product: createProduct("product-opened", { category: "精华" }),
    }),
    createItem({
      inventory_item_id: "unopened",
      lifecycle_status: "unopened",
      usability_status: "unknown",
      product_id: "product-unopened",
      product: createProduct("product-unopened", { category: "面霜" }),
    }),
    createItem({
      inventory_item_id: "finished",
      lifecycle_status: "finished",
      usability_status: "usable",
      product_id: "product-finished",
      product: createProduct("product-finished", { category: "洁面" }),
    }),
    createItem({
      inventory_item_id: "discarded",
      lifecycle_status: "discarded",
      usability_status: "expired",
      product_id: "product-discarded",
      product: createProduct("product-discarded", { category: "面膜" }),
    }),
  ] as const;

  const active = browse(items, { view: "active" });
  const archive = browse(items, { view: "archive", status: "opened" });

  assert.deepEqual(itemIds(active.items), ["opened", "unopened"]);
  assert.deepEqual(active.categoryChoices, ["精华", "面霜"]);
  assert.deepEqual(active.counts, {
    total: 4,
    active: 2,
    archive: 2,
    opened: 1,
    unopened: 1,
    attention: 1,
  });
  assert.deepEqual(itemIds(archive.items), ["discarded", "finished"]);
  assert.deepEqual(archive.categoryChoices, ["洁面", "面膜"]);
});

test("active status filters distinguish opened, unopened, attention, and all", () => {
  const items = [
    createItem({
      inventory_item_id: "opened-usable",
      lifecycle_status: "opened",
      usability_status: "usable",
    }),
    createItem({
      inventory_item_id: "opened-warning",
      lifecycle_status: "opened",
      usability_status: "usable",
      warnings: ["pao_unknown"],
    }),
    createItem({
      inventory_item_id: "unopened-unknown",
      lifecycle_status: "unopened",
      usability_status: "unknown",
    }),
  ] as const;

  assert.deepEqual(itemIds(browse(items, { status: "opened" }).items), [
    "opened-usable",
    "opened-warning",
  ]);
  assert.deepEqual(itemIds(browse(items, { status: "unopened" }).items), [
    "unopened-unknown",
  ]);
  assert.deepEqual(itemIds(browse(items, { status: "attention" }).items), [
    "opened-warning",
    "unopened-unknown",
  ]);
  assert.deepEqual(itemIds(browse(items, { status: "all" }).items), [
    "opened-usable",
    "opened-warning",
    "unopened-unknown",
  ]);
});

test("inventory query is a lowercase substring over only existing searchable facts", () => {
  const items = [
    createItem({
      inventory_item_id: "Bottle-ALPHA-42",
      lifecycle_status: "opened",
      usability_status: "usable",
      custom_notes: "Keep Upright",
      product_id: "product-alpha",
      product: createProduct("product-alpha", {
        name: "Cloud Serum",
        category: "Essence",
        size_label: "30 ML",
        shared_notes: "Night Routine",
        ingredient_list_text: "Water, NIACINAMIDE",
      }),
    }),
    createItem({
      inventory_item_id: "other-bottle",
      lifecycle_status: "opened",
      usability_status: "expired",
      expires_on: "2026-12-31",
      product_id: "product-other",
      product: createProduct("product-other", { name: "Other" }),
    }),
  ] as const;

  for (const query of [
    "cloud",
    "ESSEN",
    "30 m",
    "alpha-4",
    "upright",
    "routine",
    "niacina",
  ]) {
    assert.deepEqual(itemIds(browse(items, { query }).items), [
      "Bottle-ALPHA-42",
    ]);
  }
  assert.deepEqual(itemIds(browse(items, { query: "expired" }).items), []);
  assert.deepEqual(itemIds(browse(items, { query: "2026-12" }).items), []);
});

test("category filtering uses choices from the selected lifecycle view", () => {
  const items = [
    createItem({
      inventory_item_id: "serum-b",
      product_id: "product-serum-b",
      product: createProduct("product-serum-b", { category: "精华" }),
    }),
    createItem({
      inventory_item_id: "cream",
      product_id: "product-cream",
      product: createProduct("product-cream", { category: "面霜" }),
    }),
    createItem({
      inventory_item_id: "serum-a",
      product_id: "product-serum-a",
      product: createProduct("product-serum-a", { category: "精华" }),
    }),
    createItem({
      inventory_item_id: "missing-category",
      product_id: "product-missing-category",
      product: createProduct("product-missing-category", { category: null }),
    }),
  ] as const;

  const result = browse(items, { category: "精华" });

  assert.deepEqual(result.categoryChoices, ["精华", "面霜"]);
  assert.deepEqual(itemIds(result.items), ["serum-a", "serum-b"]);
});

test("deadline and name sorts put missing values last and use inventory ID ties", () => {
  const items = [
    createItem({
      inventory_item_id: "same-date-z",
      usable_until: "2027-01-01",
      product_id: "product-same-date-z",
      product: createProduct("product-same-date-z", { name: "Alpha" }),
    }),
    createItem({
      inventory_item_id: "missing",
      usable_until: null,
      product: null,
    }),
    createItem({
      inventory_item_id: "earliest",
      usable_until: "2026-12-31",
      product_id: "product-earliest",
      product: createProduct("product-earliest", { name: "beta" }),
    }),
    createItem({
      inventory_item_id: "same-date-a",
      usable_until: "2027-01-01",
      product_id: "product-same-date-a",
      product: createProduct("product-same-date-a", { name: "Alpha" }),
    }),
  ] as const;
  const snapshot = structuredClone(items);

  assert.deepEqual(
    itemIds(browse(items, { sort: "deadline-asc" }).items),
    ["earliest", "same-date-a", "same-date-z", "missing"],
  );
  assert.deepEqual(itemIds(browse(items, { sort: "name-asc" }).items), [
    "same-date-a",
    "same-date-z",
    "earliest",
    "missing",
  ]);
  assert.deepEqual(items, snapshot);
  assert.deepEqual(itemIds(items), [
    "same-date-z",
    "missing",
    "earliest",
    "same-date-a",
  ]);
});

test("inventory browsing returns contextual copy for empty source and empty results", () => {
  assert.equal(browse([], { view: "active" }).emptyCopy, "还没有库存记录。");
  assert.equal(
    browse([], { view: "archive" }).emptyCopy,
    "还没有已归档的库存。",
  );

  const items = [
    createItem({
      inventory_item_id: "one",
      lifecycle_status: "opened",
      usability_status: "usable",
      product_id: "product-one",
      product: createProduct("product-one", { name: "Cloud Serum" }),
    }),
  ] as const;
  assert.equal(
    browse(items, { query: "missing" }).emptyCopy,
    "没有找到匹配的库存。",
  );
  assert.equal(
    browse(items, { status: "unopened" }).emptyCopy,
    "没有符合当前筛选条件的库存。",
  );
  assert.equal(browse(items).emptyCopy, null);
});

function browse(
  items: readonly InventoryListItemOutput[],
  overrides: Partial<InventoryBrowseOptions> = {},
) {
  return projectInventoryBrowse(items, {
    view: "active",
    status: "all",
    query: "",
    category: null,
    sort: "name-asc",
    ...overrides,
  });
}

function itemIds(items: readonly InventoryListItemOutput[]): readonly string[] {
  return items.map((item) => item.inventory_item_id);
}

function createProduct(
  productId: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    product_id: productId,
    name: "Example",
    category: null,
    size_label: null,
    image_asset_id: null,
    image_ref: null,
    ingredient_list_text: null,
    shared_notes: null,
    ...overrides,
  };
}

function createItem(
  overrides: Readonly<Record<string, unknown>>,
): InventoryListItemOutput {
  return inventoryListItemOutputSchema.parse({
    inventory_item_id: "inventory-test",
    lifecycle_status: "unopened",
    opened_on: null,
    opened_on_accuracy: null,
    expires_on: null,
    pao_duration_months: null,
    pao_deadline: null,
    pao_deadline_accuracy: null,
    usable_until: null,
    usability_status: "unknown",
    warnings: [],
    custom_notes: null,
    product_id: null,
    product: null,
    product_inventory_position: null,
    product_inventory_count: null,
    ...overrides,
  });
}

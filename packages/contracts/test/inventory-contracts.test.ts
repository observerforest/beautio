import assert from "node:assert/strict";
import test from "node:test";
import {
  createInventoryBatchInputSchema,
  fetchInventoryInputSchema,
  fetchInventoryOutputSchema,
  searchInventoryInputSchema,
  searchInventoryOutputSchema,
  setProductDisplayImageInputSchema,
  setProductDisplayImageOutputSchema,
  updateInventoryItemCustomNotesInputSchema,
  updateInventoryItemCustomNotesOutputSchema,
  updateInventoryItemFactsInputSchema,
  uploadProductImagesMcpInputSchema,
  uploadProductImagesOutputSchema,
} from "../src/index.ts";

test("BD-DATA-005 search input is strict, normalized, and bounded", () => {
  assert.deepEqual(
    searchInventoryInputSchema.parse({ query: "  Serum  " }),
    {
      query: "Serum",
      offset: 0,
      limit: 20,
    },
  );
  assert.deepEqual(
    searchInventoryInputSchema.parse({ offset: 4, limit: 50 }),
    { offset: 4, limit: 50 },
  );

  for (const input of [
    { query: "   " },
    { query: "q".repeat(201) },
    { offset: -1 },
    { offset: 1.5 },
    { limit: 0 },
    { limit: 51 },
    { as_of: "2026-02-30" },
    { extra: true },
  ]) {
    assert.equal(searchInventoryInputSchema.safeParse(input).success, false);
  }
});

test("BD-DATA-005 fetch input accepts an omitted date and rejects unknown keys", () => {
  assert.deepEqual(
    fetchInventoryInputSchema.parse({ inventory_item_id: "  bottle-1  " }),
    { inventory_item_id: "bottle-1" },
  );
  assert.deepEqual(
    fetchInventoryInputSchema.parse({
      inventory_item_id: "bottle-1",
      as_of: "2026-08-21",
    }),
    { inventory_item_id: "bottle-1", as_of: "2026-08-21" },
  );
  assert.equal(
    fetchInventoryInputSchema.safeParse({
      inventory_item_id: "bottle-1",
      as_of: "2026-08-21",
      include_image: true,
    }).success,
    false,
  );
});

test("BD-DATA-005 fetch output exposes image presence without managed or legacy references", () => {
  const output = {
    inventory_item: {
      inventory_item_id: "bottle-1",
      product_id: "product-1",
      product: {
        product_id: "product-1",
        name: "Serum",
        category: "serum",
        size_label: "30 ml",
        ingredient_list_text: "Water, Glycerin",
        shared_notes: "Shared note",
        has_image: true,
      },
      lifecycle_status: "opened",
      opened_on: "2026-08-20",
      opened_on_accuracy: "estimated",
      expires_on: null,
      pao_duration_months: 12,
      pao_deadline: "2027-08-20",
      pao_deadline_accuracy: "estimated",
      usable_until: "2027-08-20",
      custom_notes: "Bottle note",
      derived_status: null,
    },
  };

  assert.equal(fetchInventoryOutputSchema.safeParse(output).success, true);
  assert.equal(
    fetchInventoryOutputSchema.safeParse({
      ...output,
      inventory_item: {
        ...output.inventory_item,
        product: {
          ...output.inventory_item.product,
          image_asset_id: "private-asset",
        },
      },
    }).success,
    false,
  );
  assert.equal(
    fetchInventoryOutputSchema.safeParse({
      ...output,
      inventory_item: {
        ...output.inventory_item,
        product: {
          ...output.inventory_item.product,
          image_ref: "/legacy/private.jpg",
        },
      },
    }).success,
    false,
  );
});

test("BD-DATA-005 search output keeps long text out of result summaries", () => {
  const output = {
    query: "serum",
    offset: 0,
    limit: 20,
    total: 1,
    next_offset: null,
    items: [
      {
        inventory_item_id: "bottle-1",
        product_id: "product-1",
        product_name: "Serum",
        category: "serum",
        size_label: "30 ml",
        lifecycle_status: "unopened",
        opened_on: null,
        expires_on: null,
        usable_until: null,
        has_image: false,
        derived_status: {
          as_of: "2026-08-21",
          usability_status: "unknown",
          warnings: ["pao_unknown"],
        },
      },
    ],
  };

  assert.equal(searchInventoryOutputSchema.safeParse(output).success, true);
  assert.equal(
    searchInventoryOutputSchema.safeParse({ ...output, query: null }).success,
    true,
  );
  assert.equal(
    searchInventoryOutputSchema.safeParse({ ...output, query: "   " }).success,
    false,
  );
  assert.equal(
    searchInventoryOutputSchema.safeParse({
      ...output,
      items: [
        {
          ...output.items[0],
          ingredient_list_text: "must not be in a summary",
        },
      ],
    }).success,
    false,
  );
});

test("BD-DATA-002 batch contract accepts the frozen minimal Product shape", () => {
  const parsed = createInventoryBatchInputSchema.parse({
    as_of: "2026-08-19",
    products: [{ batch_ref: "product_1", name: "  Serum  " }],
    inventory_items: [
      {
        batch_ref: "bottle_1",
        product_ref: { kind: "new", batch_ref: "product_1" },
        lifecycle_status: "unopened",
      },
    ],
  });

  assert.equal(parsed.products[0]?.name, "Serum");
  assert.equal(parsed.products[0]?.category, undefined);
});

test("BD-DATA-002 write contracts reject unknown keys and derived fields", () => {
  const batch = {
    as_of: "2026-08-19",
    products: [{ batch_ref: "product_1", name: "Serum" }],
    inventory_items: [
      {
        batch_ref: "bottle_1",
        product_ref: { kind: "new", batch_ref: "product_1" },
        lifecycle_status: "unopened",
        usable_until: "2027-01-01",
      },
    ],
  };
  assert.equal(createInventoryBatchInputSchema.safeParse(batch).success, false);

  assert.equal(
    updateInventoryItemFactsInputSchema.safeParse({
      as_of: "2026-08-19",
      lifecycle_status: "opened",
      opened_on: "2026-08-01",
      opened_on_accuracy: "estimated",
      expires_on: null,
      pao_duration_months: 12,
      pao_deadline: "2027-08-01",
    }).success,
    false,
  );
});

test("BD-DATA-002 bounds and sentinel text are rejected", () => {
  assert.equal(
    createInventoryBatchInputSchema.safeParse({
      as_of: "2026-08-19",
      products: [{ batch_ref: "product_1", name: "未知" }],
      inventory_items: [
        {
          batch_ref: "bottle_1",
          product_ref: { kind: "new", batch_ref: "product_1" },
          lifecycle_status: "unopened",
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    createInventoryBatchInputSchema.safeParse({
      as_of: "2026-08-19",
      products: [],
      inventory_items: Array.from({ length: 101 }, (_, index) => ({
        batch_ref: `bottle_${index}`,
        product_ref: { kind: "existing", product_id: "product-existing" },
        lifecycle_status: "unopened",
      })),
    }).success,
    false,
  );
});

test("BD-DATA-002 stdio upload contract is strict and bounded", () => {
  assert.equal(
    uploadProductImagesMcpInputSchema.safeParse({
      images: [{ client_ref: "front_1", file_path: "/tmp/front.png" }],
    }).success,
    true,
  );
  assert.equal(
    uploadProductImagesMcpInputSchema.safeParse({
      images: [
        {
          client_ref: "front 1",
          file_path: "/tmp/front.png",
          extra: true,
        },
      ],
    }).success,
    false,
  );
});

test("BD-DATA-002 upload output rejects an empty image asset ID", () => {
  assert.equal(
    uploadProductImagesOutputSchema.safeParse({
      assets: [
        {
          source_ref: "front_1",
          image_asset_id: " ",
          media_type: "image/jpeg",
          byte_size: 3,
          expires_at: "2026-08-21T00:00:00.000Z",
        },
      ],
    }).success,
    false,
  );
});

test("Product display image contract normalizes opaque IDs and rejects unknown fields", () => {
  assert.deepEqual(
    setProductDisplayImageInputSchema.parse({
      product_id: "  product-shared  ",
      image_asset_id: "  image-asset-new  ",
    }),
    {
      product_id: "product-shared",
      image_asset_id: "image-asset-new",
    },
  );

  assert.equal(
    setProductDisplayImageInputSchema.safeParse({
      product_id: "product-shared",
      image_asset_id: "image-asset-new",
      inventory_item_id: "bottle-1",
    }).success,
    false,
  );
  assert.equal(
    setProductDisplayImageInputSchema.safeParse({
      product_id: " ",
      image_asset_id: "image-asset-new",
    }).success,
    false,
  );
});

test("Product display image output contract is strict", () => {
  const output = {
    product: {
      product_id: "product-shared",
      name: "Shared serum",
      category: "serum",
      size_label: "30 ml",
      image_asset_id: "image-asset-new",
      image_ref: null,
      ingredient_list_text: null,
      shared_notes: null,
    },
  };

  assert.equal(setProductDisplayImageOutputSchema.safeParse(output).success, true);
  assert.equal(
    setProductDisplayImageOutputSchema.safeParse({
      ...output,
      inventory_item_id: "bottle-1",
    }).success,
    false,
  );
});

test("BD-DATA-004 batch text fields preserve content and normalize missing values", () => {
  const parsed = createInventoryBatchInputSchema.parse({
    as_of: "2026-08-20",
    products: [
      {
        batch_ref: "product_1",
        name: "Serum",
        ingredient_list_text: "  Water,\nGlycerin  ",
        shared_notes: "   ",
      },
    ],
    inventory_items: [
      {
        batch_ref: "bottle_1",
        product_ref: { kind: "new", batch_ref: "product_1" },
        lifecycle_status: "unopened",
        custom_notes: "  Keep upright  ",
      },
    ],
  });

  assert.equal(parsed.products[0]?.ingredient_list_text, "Water,\nGlycerin");
  assert.equal(parsed.products[0]?.shared_notes, null);
  assert.equal(parsed.inventory_items[0]?.custom_notes, "Keep upright");
});

test("BD-DATA-004 text boundaries are strict without truncation or Product patching", () => {
  const batch = (ingredientListText: string, customNotes: string) => ({
    as_of: "2026-08-20",
    products: [
      {
        batch_ref: "product_1",
        name: "Serum",
        ingredient_list_text: ingredientListText,
        shared_notes: "s".repeat(1000),
      },
    ],
    inventory_items: [
      {
        batch_ref: "bottle_1",
        product_ref: { kind: "new", batch_ref: "product_1" },
        lifecycle_status: "unopened",
        custom_notes: customNotes,
      },
    ],
  });

  assert.equal(
    createInventoryBatchInputSchema.safeParse(
      batch("i".repeat(5000), "n".repeat(1000)),
    ).success,
    true,
  );
  assert.equal(
    createInventoryBatchInputSchema.safeParse(
      batch("i".repeat(5001), "n".repeat(1000)),
    ).success,
    false,
  );
  assert.equal(
    createInventoryBatchInputSchema.safeParse(
      batch("i".repeat(5000), "n".repeat(1001)),
    ).success,
    false,
  );
  assert.equal(
    createInventoryBatchInputSchema.safeParse({
      as_of: "2026-08-20",
      products: [],
      inventory_items: [
        {
          batch_ref: "bottle_1",
          product_ref: {
            kind: "existing",
            product_id: "product-existing",
            shared_notes: "must not patch",
          },
          lifecycle_status: "unopened",
        },
      ],
    }).success,
    false,
  );
});

test("BD-DATA-004 custom notes update contract is nullable, normalized, and narrow", () => {
  assert.deepEqual(
    updateInventoryItemCustomNotesInputSchema.parse({
      custom_notes: "  One bottle only  ",
    }),
    { custom_notes: "One bottle only" },
  );
  assert.deepEqual(
    updateInventoryItemCustomNotesInputSchema.parse({ custom_notes: "   " }),
    { custom_notes: null },
  );
  assert.deepEqual(
    updateInventoryItemCustomNotesInputSchema.parse({
      custom_notes: "  unknown  ",
    }),
    { custom_notes: "unknown" },
    "free-form notes have no undocumented sentinel-word rejection",
  );
  assert.equal(
    updateInventoryItemCustomNotesInputSchema.safeParse({
      custom_notes: "not binary\u0000text",
    }).success,
    false,
  );
  assert.equal(
    updateInventoryItemCustomNotesInputSchema.safeParse({
      custom_notes: "unpaired \ud800 text",
    }).success,
    false,
  );
  assert.equal(
    updateInventoryItemCustomNotesInputSchema.safeParse({
      custom_notes: "trailing surrogate\ud800",
    }).success,
    false,
  );
  assert.equal(
    updateInventoryItemCustomNotesInputSchema.safeParse({
      custom_notes: "\u000btrim must not hide controls\u000c",
    }).success,
    false,
  );
  assert.equal(
    updateInventoryItemCustomNotesInputSchema.safeParse({
      custom_notes: null,
      lifecycle_status: "opened",
    }).success,
    false,
  );
  assert.equal(
    updateInventoryItemCustomNotesInputSchema.safeParse({}).success,
    false,
  );
  assert.equal(
    updateInventoryItemCustomNotesOutputSchema.safeParse({
      inventory_item: {
        inventory_item_id: "bottle-1",
        custom_notes: null,
      },
    }).success,
    true,
  );
  assert.equal(
    updateInventoryItemCustomNotesOutputSchema.safeParse({
      inventory_item: {
        inventory_item_id: "bottle-1",
        custom_notes: "bad\u0000output",
      },
    }).success,
    false,
  );
});

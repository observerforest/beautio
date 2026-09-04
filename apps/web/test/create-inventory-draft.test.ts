import assert from "node:assert/strict";
import test from "node:test";
import { inventoryListItemOutputSchema, type InventoryListItemOutput } from "@beautio/contracts";
import { AdminApiError } from "../src/admin-api.ts";
import { refreshCreatedInventorySnapshot } from "../src/features/inventory/refresh-created-inventory.ts";
import {
  buildCreateInventoryInput,
  emptyCreateInventoryDraft,
  existingInventoryProducts,
  isConfirmedCreateRejection,
  type CreateInventoryDraft,
  type ExistingInventoryProduct,
} from "../src/features/inventory/create-inventory-draft.ts";

const AS_OF = "2026-08-31";

test("manual draft defaults to one unopened bottle without inferred Product facts", () => {
  const blank = emptyCreateInventoryDraft();
  assert.equal(blank.quantity, "1");
  assert.equal(blank.lifecycle, "unopened");
  assert.equal(blank.accuracy, "");
  const built = validInput({ name: " Example serum " });
  assert.equal(built.as_of, AS_OF);
  assert.equal(built.products.length, 1);
  assert.equal(built.products[0]?.name, "Example serum");
  assert.equal(built.products[0]?.brand, null);
  assert.equal(built.products[0]?.alias, null);
  assert.equal(built.products[0]?.ingredient_list_text, null);
  assert.equal(built.products[0]?.image_asset_id, null);
  assert.equal(built.products[0]?.pao_duration_months, null);
  assert.equal(built.inventory_items.length, 1);
  assert.equal(built.inventory_items[0]?.opened_on, null);
  assert.equal(built.inventory_items[0]?.opened_on_accuracy, null);
  assert.equal(Object.hasOwn(built.inventory_items[0] ?? {}, "pao_duration_months"), false);
});

test("quantity creates bottles of one new Product with distinct request references", () => {
  const built = validInput({ name: "Example", quantity: "100", pao: "12", customNotes: "same batch" });
  assert.equal(built.products.length, 1);
  assert.equal(built.products[0]?.pao_duration_months, 12);
  assert.equal(built.inventory_items.length, 100);
  assert.equal(new Set(built.inventory_items.map((item) => item.batch_ref)).size, 100);
  for (const bottle of built.inventory_items) {
    assert.deepEqual(bottle.product_ref, { kind: "new", batch_ref: built.products[0]?.batch_ref });
    assert.equal(bottle.custom_notes, "same batch");
    assert.equal(Object.hasOwn(bottle, "pao_duration_months"), false);
  }
});

test("quantity rejects empty, fractional, exponential, signed and out-of-range drafts", () => {
  for (const quantity of ["", " ", "0", "-1", "+1", "1.5", "101", "1e2", "0x10", "Infinity", "1 2"]) {
    const result = build({ quantity });
    assert.equal(result.ok, false, quantity);
    if (!result.ok) assert.equal(result.field, "quantity");
  }
  assert.equal(validInput({ quantity: " 2 " }).inventory_items.length, 2);
});

test("alias accepts ten characters and rejects excess without truncating the draft", () => {
  const alias = "甲乙丙丁戊己庚辛壬癸";
  assert.equal(validInput({ alias }).products[0]?.alias, alias);
  const draft = { ...emptyCreateInventoryDraft(), name: "Example", alias: `${alias}子` };
  const result = buildCreateInventoryInput(draft, [], AS_OF);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.field, "alias");
  assert.equal(draft.alias, `${alias}子`);
  assert.equal(validInput({ alias: ` ${alias} ` }).products[0]?.alias, alias);
});

test("Product selection deduplicates by product_id without collapsing names or sizes", () => {
  const small = product("product-small", "30 ml");
  const large = product("product-large", "60 ml");
  const choices = existingInventoryProducts([
    inventoryItem(small), inventoryItem(small), inventoryItem(large, "finished"), inventoryItem(null),
  ]);
  assert.equal(choices.length, 2);
  assert.deepEqual(choices.map((choice) => choice.product_id), ["product-small", "product-large"]);
  assert.deepEqual(choices.map((choice) => choice.size_label), ["30 ml", "60 ml"]);
});

test("existing Product mode never sends shared edits from a previously filled new Product draft", () => {
  const selected = product("existing", "30 ml");
  const built = validInput({
    mode: "existing", productId: selected.product_id, quantity: "2", name: "Different name",
    alias: "far too long to save", brand: "Different brand", size: "100 ml",
    ingredients: "Unrelated", sharedNotes: "Unrelated", customNotes: "Bottle only", pao: "invalid old draft",
  }, [selected]);
  assert.deepEqual(built.products, []);
  assert.equal(built.inventory_items.length, 2);
  for (const bottle of built.inventory_items) {
    assert.deepEqual(bottle.product_ref, { kind: "existing", product_id: "existing" });
    assert.equal(bottle.custom_notes, "Bottle only");
    assert.equal(Object.hasOwn(bottle, "pao_duration_months"), false);
  }
});

test("existing Product creation inherits known or unknown Product PAO without copying a bottle value", () => {
  for (const pao_duration_months of [null, 12]) {
    const selected = { ...product("existing", "30 ml"), pao_duration_months };
    const built = validInput({ mode: "existing", productId: "existing", pao: "6" }, [selected]);
    assert.deepEqual(built.products, []);
    assert.equal(Object.hasOwn(built.inventory_items[0] ?? {}, "pao_duration_months"), false);
  }
});

test("existing Product selection must still be present in the current snapshot", () => {
  for (const productId of ["", "missing"]) {
    const result = build({ mode: "existing", productId }, [product("other", "30 ml")]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.field, "productId");
  }
});

test("opened bottles require a real date and explicit exact or estimated accuracy", () => {
  const missingDate = build({ lifecycle: "opened", accuracy: "exact" });
  assert.equal(missingDate.ok, false);
  if (!missingDate.ok) assert.equal(missingDate.field, "openedOn");
  const missingAccuracy = build({ lifecycle: "opened", openedOn: "2026-08-30" });
  assert.equal(missingAccuracy.ok, false);
  if (!missingAccuracy.ok) assert.equal(missingAccuracy.field, "accuracy");
  for (const accuracy of ["exact", "estimated"] as const) {
    const built = validInput({ lifecycle: "opened", openedOn: "2024-02-29", accuracy });
    assert.equal(built.inventory_items[0]?.opened_on, "2024-02-29");
    assert.equal(built.inventory_items[0]?.opened_on_accuracy, accuracy);
  }
});

test("invalid opening and expiry calendar dates fail before a request can be built", () => {
  for (const date of ["2026-02-29", "2026-13-01", "2026-04-31", "31/08/2026"]) {
    const opened = build({ lifecycle: "opened", openedOn: date, accuracy: "exact" });
    assert.equal(opened.ok, false, date);
    if (!opened.ok) assert.equal(opened.field, "openedOn");
    const expiry = build({ expiresOn: date });
    assert.equal(expiry.ok, false, date);
    if (!expiry.ok) assert.equal(expiry.field, "expiresOn");
  }
});

test("unopened mode clears stale opening facts and does not infer an opening date", () => {
  const built = validInput({ lifecycle: "unopened", openedOn: "2026-08-30", accuracy: "estimated" });
  assert.equal(built.inventory_items[0]?.opened_on, null);
  assert.equal(built.inventory_items[0]?.opened_on_accuracy, null);
});

test("shared Product PAO accepts blank or integers from one to 120 without number coercion", () => {
  assert.equal(validInput({ pao: " " }).products[0]?.pao_duration_months, null);
  assert.equal(validInput({ pao: "1" }).products[0]?.pao_duration_months, 1);
  assert.equal(validInput({ pao: "120" }).products[0]?.pao_duration_months, 120);
  for (const pao of ["0", "121", "1.2", "1e2", "-1"]) {
    const result = build({ pao });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.field, "pao");
  }
});

test("text normalization preserves internal lines and rejects unknown fact sentinels", () => {
  const built = validInput({ ingredients: " Water\nGlycerin ", sharedNotes: " \n ", customNotes: " Line one\nLine two " });
  assert.equal(built.products[0]?.ingredient_list_text, "Water\nGlycerin");
  assert.equal(built.products[0]?.shared_notes, null);
  assert.equal(built.inventory_items[0]?.custom_notes, "Line one\nLine two");
  for (const [field, value] of [["name", "unknown"], ["brand", "未知"], ["category", "n/a"], ["size", "待补充"]] as const) {
    const result = build({ [field]: value });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.field, field);
  }
});

test("notes and ingredient bounds and control-character rules are checked before upload", () => {
  for (const [field, maximum] of [["ingredients", 5_000], ["sharedNotes", 1_000], ["customNotes", 1_000]] as const) {
    assert.equal(build({ [field]: "a".repeat(maximum) }).ok, true);
    for (const value of ["a".repeat(maximum + 1), "has\u0000control"]) {
      const result = build({ [field]: value });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.field, field);
    }
  }
});

test("only structured non-timeout 4xx responses are classified as confirmed rejections", () => {
  assert.equal(isConfirmedCreateRejection(new AdminApiError(400, "INVALID_INPUT", "Invalid")), true);
  assert.equal(isConfirmedCreateRejection(new AdminApiError(404, "PRODUCT_NOT_FOUND", "Missing")), true);
  for (const failure of [
    new TypeError("Failed to fetch"), new SyntaxError("Invalid JSON"), new DOMException("Aborted", "AbortError"),
    new AdminApiError(500, "INTERNAL_ERROR", "Failed"),
    new AdminApiError(503, "HTTP_ERROR", "Unavailable"),
    new AdminApiError(0, "INVALID_RESPONSE", "Malformed response"),
    new AdminApiError(408, "TIMEOUT", "Timeout"),
    new AdminApiError(400, "HTTP_ERROR", "Unstructured rejection"),
  ]) assert.equal(isConfirmedCreateRejection(failure), false);
});

test("post-create refresh drains an older GET before confirming the second read", async () => {
  const first = Promise.withResolvers<boolean>();
  const second = Promise.withResolvers<boolean>();
  const calls: Array<boolean | undefined> = [];
  let settled = false;
  const refreshing = refreshCreatedInventorySnapshot((showLoading) => {
    calls.push(showLoading);
    return calls.length === 1 ? first.promise : second.promise;
  }).then((result) => { settled = true; return result; });
  assert.deepEqual(calls, [false]);
  first.resolve(true);
  await Promise.resolve();
  assert.deepEqual(calls, [false, false]);
  assert.equal(settled, false, "the first success cannot confirm new inventory");
  second.resolve(false);
  assert.equal(await refreshing, false, "only the second read determines success");
});

test("post-create refresh still performs a new read when the older one failed", async () => {
  for (const firstThrows of [false, true]) {
    const operations: string[] = [];
    const result = await refreshCreatedInventorySnapshot(async (showLoading) => {
      assert.equal(showLoading, false);
      operations.push("GET inventory");
      if (operations.length === 1) {
        if (firstThrows) throw new TypeError("Older read failed");
        return false;
      }
      return true;
    });
    assert.equal(result, true);
    assert.deepEqual(operations, ["GET inventory", "GET inventory"]);
  }
});

test("post-create refresh returns false for a rejected second read without retrying writes", async () => {
  const operations: string[] = [];
  const result = await refreshCreatedInventorySnapshot(async () => {
    operations.push("GET inventory");
    if (operations.length === 2) throw new TypeError("Fresh read failed");
    return true;
  });
  assert.equal(result, false);
  assert.deepEqual(operations, ["GET inventory", "GET inventory"]);
});

function build(overrides: Partial<CreateInventoryDraft> = {}, products: readonly ExistingInventoryProduct[] = []) {
  return buildCreateInventoryInput({ ...emptyCreateInventoryDraft(), name: "Example", ...overrides }, products, AS_OF);
}

function validInput(overrides: Partial<CreateInventoryDraft> = {}, products: readonly ExistingInventoryProduct[] = []) {
  const result = build(overrides, products);
  if (!result.ok) assert.fail(result.message);
  return result.input;
}

function product(productId: string, size: string): ExistingInventoryProduct {
  return {
    product_id: productId, name: "Example serum", alias: null, brand: null, category: null,
    size_label: size, pao_duration_months: null, image_asset_id: null, image_ref: null, ingredient_list_text: null, shared_notes: null,
  };
}

function inventoryItem(selectedProduct: ExistingInventoryProduct | null, lifecycle: "unopened" | "finished" = "unopened"): InventoryListItemOutput {
  return inventoryListItemOutputSchema.parse({
    inventory_item_id: "inventory-example", created_at: null, lifecycle_status: lifecycle,
    opened_on: null, opened_on_accuracy: null, expires_on: null, pao_duration_months: null,
    pao_deadline: null, pao_deadline_accuracy: null, usable_until: null,
    remaining_percent_estimate: null, usability_status: "unknown",
    warnings: [], custom_notes: null, product_id: selectedProduct?.product_id ?? null,
    product: selectedProduct, product_inventory_position: null, product_inventory_count: null,
  });
}

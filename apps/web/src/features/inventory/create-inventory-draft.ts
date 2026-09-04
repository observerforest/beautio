import {
  createInventoryBatchInputSchema,
  isoDateSchema,
  productAliasMaximumLength,
  type CreateInventoryBatchInput,
  type InventoryListItemOutput,
} from "@beautio/contracts";
import { AdminApiError } from "../../admin-api.ts";
import { normalizeOptionalEditorText } from "../../text-fields.ts";
import { parsePaoDuration } from "./models/pao-model.ts";

export type ExistingInventoryProduct = NonNullable<InventoryListItemOutput["product"]>;

export interface CreateInventoryDraft {
  readonly mode: "new" | "existing";
  readonly productId: string;
  readonly name: string;
  readonly alias: string;
  readonly brand: string;
  readonly category: string;
  readonly size: string;
  readonly ingredients: string;
  readonly sharedNotes: string;
  readonly quantity: string;
  readonly lifecycle: "unopened" | "opened";
  readonly openedOn: string;
  readonly accuracy: "" | "exact" | "estimated";
  readonly expiresOn: string;
  readonly pao: string;
  readonly customNotes: string;
}

export type CreateInventoryDraftResult =
  | { readonly ok: true; readonly input: CreateInventoryBatchInput }
  | { readonly ok: false; readonly field: keyof CreateInventoryDraft; readonly message: string };

/**
 * Starts a blank manual-entry draft without inferring Product or opening facts.
 *
 * @returns A new Product draft for one unopened bottle, with optional facts empty.
 */
export function emptyCreateInventoryDraft(): CreateInventoryDraft {
  return {
    mode: "new", productId: "", name: "", alias: "", brand: "", category: "",
    size: "", ingredients: "", sharedNotes: "", quantity: "1", lifecycle: "unopened",
    openedOn: "", accuracy: "", expiresOn: "", pao: "", customNotes: "",
  };
}

/**
 * Collects selectable Products from the actual inventory snapshot, including archives.
 *
 * @param items - Unfiltered inventory rows; missing Product joins are not invented.
 * @returns One Product per product_id, preserving snapshot order and separate variants.
 */
export function existingInventoryProducts(
  items: readonly InventoryListItemOutput[],
): readonly ExistingInventoryProduct[] {
  const products = new Map<string, ExistingInventoryProduct>();
  for (const item of items) {
    if (item.product !== null && !products.has(item.product.product_id)) {
      products.set(item.product.product_id, item.product);
    }
  }
  return [...products.values()];
}

/**
 * Validates a manual draft and constructs one Product reference shared by 1–100 bottles.
 * The batch references only correlate this request; they are not idempotency keys.
 *
 * @param draft - Uncoerced field values retained while typing, including IME composition.
 * @param products - Products actually present in the current inventory snapshot.
 * @param asOf - Explicit browser-local YYYY-MM-DD date for server derivation.
 * @returns Valid API input or a localized-source field error; existing Products never receive shared edits.
 */
export function buildCreateInventoryInput(
  draft: CreateInventoryDraft,
  products: readonly ExistingInventoryProduct[],
  asOf: string,
): CreateInventoryDraftResult {
  const fail = (field: keyof CreateInventoryDraft, message: string): CreateInventoryDraftResult => ({ ok: false, field, message });
  if (draft.mode === "new") {
    if (draft.name.trim().length === 0) return fail("name", "产品名称不能为空。");
    if ((normalizeOptionalEditorText(draft.alias)?.length ?? 0) > productAliasMaximumLength) {
      return fail("alias", "产品别名最多 10 个字符，请缩短后再保存。");
    }
  } else if (!products.some((product) => product.product_id === draft.productId)) {
    return fail("productId", "请选择当前库存中的已有产品。");
  }

  const quantity = boundedInteger(draft.quantity, 100);
  if (quantity === undefined) return fail("quantity", "瓶数必须是 1–100 的整数。");
  const pao = draft.mode === "new" ? parsePaoDuration(draft.pao) : null;
  if (pao === undefined) return fail("pao", "PAO 必须是 1–120 的整数，或留空。");
  if (draft.lifecycle === "opened") {
    if (draft.openedOn.length === 0) return fail("openedOn", "已开封库存必须填写开封日期。");
    if (!isoDateSchema.safeParse(draft.openedOn).success) return fail("openedOn", "请填写有效的开封日期。");
    if (draft.accuracy !== "exact" && draft.accuracy !== "estimated") {
      return fail("accuracy", "请选择准确日期或估算日期。");
    }
  }
  if (draft.expiresOn.length > 0 && !isoDateSchema.safeParse(draft.expiresOn).success) {
    return fail("expiresOn", "请填写有效的包装过期日，或留空。");
  }

  const productRef = draft.mode === "new"
    ? { kind: "new" as const, batch_ref: "new_product" }
    : { kind: "existing" as const, product_id: draft.productId };
  const input = {
    as_of: asOf,
    products: draft.mode === "new" ? [{
      batch_ref: "new_product",
      name: draft.name.trim(),
      alias: normalizeOptionalEditorText(draft.alias),
      brand: normalizeOptionalEditorText(draft.brand),
      category: normalizeOptionalEditorText(draft.category),
      size_label: normalizeOptionalEditorText(draft.size),
      pao_duration_months: pao,
      ingredient_list_text: normalizeOptionalEditorText(draft.ingredients),
      shared_notes: normalizeOptionalEditorText(draft.sharedNotes),
      image_asset_id: null,
    }] : [],
    inventory_items: Array.from({ length: quantity }, (_, index) => ({
      batch_ref: `bottle_${index + 1}`,
      product_ref: productRef,
      lifecycle_status: draft.lifecycle,
      opened_on: draft.lifecycle === "opened" ? draft.openedOn : null,
      opened_on_accuracy: draft.lifecycle === "opened" && draft.accuracy !== "" ? draft.accuracy : null,
      expires_on: draft.expiresOn || null,
      custom_notes: normalizeOptionalEditorText(draft.customNotes),
    })),
  };
  const parsed = createInventoryBatchInputSchema.safeParse(input);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.at(-1);
    const errors: Readonly<Record<string, readonly [keyof CreateInventoryDraft, string]>> = {
      name: ["name", "请填写已确认的产品名称，最多 200 个字符。"],
      alias: ["alias", "请填写已确认的产品别名，或留空。"],
      brand: ["brand", "品牌最多 100 个字符；无法确认时请留空。"],
      category: ["category", "品类最多 100 个字符；无法确认时请留空。"],
      size_label: ["size", "规格最多 100 个字符；无法确认时请留空。"],
      ingredient_list_text: ["ingredients", "成分表最多 5000 个字符，且不能包含不支持的控制字符。"],
      shared_notes: ["sharedNotes", "共享备注最多 1000 个字符，且不能包含不支持的控制字符。"],
      custom_notes: ["customNotes", "单瓶备注最多 1000 个字符，且不能包含不支持的控制字符。"],
    };
    const detail = typeof field === "string" ? errors[field] : undefined;
    return detail === undefined ? fail("name", "请检查输入的产品与单瓶资料。") : fail(...detail);
  }
  return { ok: true, input: parsed.data };
}

/**
 * Distinguishes explicit server rejections from uncertain non-idempotent create outcomes.
 *
 * @param error - Failure thrown after beginning the create call, not the image upload.
 * @returns True only for a structured 4xx rejection other than a timeout; transport,
 * malformed responses, unstructured HTTP errors, and 5xx must not be resubmitted automatically.
 */
export function isConfirmedCreateRejection(error: unknown): boolean {
  return error instanceof AdminApiError
    && error.status >= 400 && error.status < 500 && error.status !== 408
    && error.code !== "HTTP_ERROR";
}

function boundedInteger(value: string, maximum: number): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : undefined;
}

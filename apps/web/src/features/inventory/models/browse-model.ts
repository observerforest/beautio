/**
 * 定义 inventory 页面浏览状态，并把完整库存投影成确定性的筛选与排序结果。
 * Defines inventory browsing state and projects complete inventory into deterministic filtered and sorted results.
 */
import type { InventoryListItemOutput } from "@beautio/contracts";
import { inventoryItemNeedsAttention } from "./status-model.ts";

export type InventoryCollectionView = "active" | "archive";

export type InventoryStatusFilter =
  | "all"
  | "opened"
  | "unopened"
  | "attention";

export type InventorySortOption = "deadline-asc" | "name-asc";

export interface InventoryBrowseOptions {
  readonly view: InventoryCollectionView;
  readonly status: InventoryStatusFilter;
  readonly query: string;
  readonly category: string | null;
  readonly sort: InventorySortOption;
}

export interface InventoryBrowseCounts {
  readonly total: number;
  readonly active: number;
  readonly archive: number;
  readonly opened: number;
  readonly unopened: number;
  readonly attention: number;
}

export interface InventoryBrowseProjection {
  readonly items: readonly InventoryListItemOutput[];
  readonly counts: InventoryBrowseCounts;
  readonly categoryChoices: readonly string[];
  readonly emptyCopy: string | null;
}

/**
 * 把完整的 Core API 库存投影成一个客户端浏览视图。
 * Projects the complete Core API inventory into one client-side browsing view.
 *
 * @param items - 现有 Core API 契约返回的完整库存列表。 / Complete inventory list returned by the existing Core API contract.
 * @param options - 生命周期视图、活跃状态筛选、搜索词、分类和确定性排序。 / Lifecycle view, active-state filter, query, category, and deterministic sort.
 * @returns 筛选结果、来源计数、当前生命周期视图的分类选项和有上下文的空状态文案。 / Filtered items plus source counts, categories for the selected lifecycle view, and contextual empty copy.
 *
 * 该函数绝不修改输入。活跃视图包含未开封和已开封库存；归档视图包含已用完和已弃置库存。
 * 状态筛选只应用于活跃视图。缺失期限和名称排在已记录值之后。
 * The function never mutates the input. Active contains unopened and opened items;
 * archive contains finished and discarded items. The status filter only applies to
 * the active view. Missing deadlines and names sort after recorded values.
 */
export function projectInventoryBrowse(
  items: readonly InventoryListItemOutput[],
  options: InventoryBrowseOptions,
): InventoryBrowseProjection {
  const viewItems = items.filter((item) => itemBelongsToView(item, options.view));
  const normalizedQuery = options.query.trim().toLowerCase();
  const filteredItems = viewItems
    .filter(
      (item) =>
        options.view === "archive" ||
        options.status === "all" ||
        itemMatchesStatus(item, options.status),
    )
    .filter(
      (item) =>
        options.category === null || item.product?.category === options.category,
    )
    .filter(
      (item) =>
        normalizedQuery.length === 0 || itemMatchesQuery(item, normalizedQuery),
    )
    .sort(inventoryComparator(options.sort));

  return {
    items: filteredItems,
    counts: inventoryBrowseCounts(items),
    categoryChoices: inventoryCategoryChoices(viewItems),
    emptyCopy: inventoryBrowseEmptyCopy(
      viewItems.length,
      filteredItems.length,
      options.view,
      normalizedQuery,
    ),
  };
}

function itemBelongsToView(
  item: InventoryListItemOutput,
  view: InventoryCollectionView,
): boolean {
  const isActive =
    item.lifecycle_status === "unopened" || item.lifecycle_status === "opened";
  return view === "active" ? isActive : !isActive;
}

function itemMatchesStatus(
  item: InventoryListItemOutput,
  status: Exclude<InventoryStatusFilter, "all">,
): boolean {
  if (status === "attention") {
    return inventoryItemNeedsAttention(item);
  }
  return item.lifecycle_status === status;
}

function itemMatchesQuery(
  item: InventoryListItemOutput,
  normalizedQuery: string,
): boolean {
  const product = item.product;
  const searchableValues = [
    product?.name,
    product?.category,
    product?.size_label,
    item.inventory_item_id,
    item.custom_notes,
    product?.shared_notes,
    product?.ingredient_list_text,
  ];

  return searchableValues.some(
    (value) =>
      value !== null &&
      value !== undefined &&
      value.toLowerCase().includes(normalizedQuery),
  );
}

function inventoryComparator(
  sort: InventorySortOption,
): (left: InventoryListItemOutput, right: InventoryListItemOutput) => number {
  return (left, right) => {
    const primary =
      sort === "deadline-asc"
        ? compareNullableText(left.usable_until, right.usable_until)
        : compareNullableText(
            left.product?.name ?? null,
            right.product?.name ?? null,
          );
    return primary !== 0
      ? primary
      : compareText(left.inventory_item_id, right.inventory_item_id);
  };
}

function compareNullableText(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return compareText(left.toLowerCase(), right.toLowerCase());
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function inventoryBrowseCounts(
  items: readonly InventoryListItemOutput[],
): InventoryBrowseCounts {
  return items.reduce<InventoryBrowseCounts>(
    (counts, item) => {
      const isActive = itemBelongsToView(item, "active");
      return {
        total: counts.total + 1,
        active: counts.active + (isActive ? 1 : 0),
        archive: counts.archive + (isActive ? 0 : 1),
        opened:
          counts.opened + (item.lifecycle_status === "opened" ? 1 : 0),
        unopened:
          counts.unopened + (item.lifecycle_status === "unopened" ? 1 : 0),
        attention:
          counts.attention +
          (isActive && inventoryItemNeedsAttention(item) ? 1 : 0),
      };
    },
    { total: 0, active: 0, archive: 0, opened: 0, unopened: 0, attention: 0 },
  );
}

function inventoryCategoryChoices(
  items: readonly InventoryListItemOutput[],
): readonly string[] {
  return [...new Set(
    items.flatMap((item) =>
      item.product?.category === null || item.product?.category === undefined
        ? []
        : [item.product.category],
    ),
  )].sort(compareText);
}

function inventoryBrowseEmptyCopy(
  viewItemCount: number,
  filteredItemCount: number,
  view: InventoryCollectionView,
  normalizedQuery: string,
): string | null {
  if (filteredItemCount > 0) return null;
  if (viewItemCount === 0) {
    return view === "active" ? "还没有库存记录。" : "还没有已归档的库存。";
  }
  return normalizedQuery.length > 0
    ? "没有找到匹配的库存。"
    : "没有符合当前筛选条件的库存。";
}

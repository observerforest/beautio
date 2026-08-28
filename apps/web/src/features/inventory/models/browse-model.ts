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

/**
 * 判断库存记录是否属于指定的生命周期视图。
 * Determines whether an inventory item belongs to the requested lifecycle view.
 *
 * @param item - 待分类的库存记录。 / Inventory item to classify.
 * @param view - 目标活跃或归档视图。 / Target active or archive view.
 * @returns 未开封和已开封记录属于活跃视图；其他生命周期属于归档视图。 / True when unopened or opened items target the active view, or any other lifecycle targets the archive view.
 */
function itemBelongsToView(
  item: InventoryListItemOutput,
  view: InventoryCollectionView,
): boolean {
  const isActive =
    item.lifecycle_status === "unopened" || item.lifecycle_status === "opened";
  return view === "active" ? isActive : !isActive;
}

/**
 * 判断库存记录是否匹配一个具体的活跃状态筛选器。
 * Determines whether an inventory item matches one concrete active-state filter.
 *
 * @param item - 待检查的库存记录。 / Inventory item to inspect.
 * @param status - 已排除“全部”的状态筛选器。 / Status filter with the all option excluded.
 * @returns 关注筛选器使用统一的风险判断；其他筛选器直接匹配生命周期。 / Whether the attention predicate or lifecycle value matches the requested filter.
 */
function itemMatchesStatus(
  item: InventoryListItemOutput,
  status: Exclude<InventoryStatusFilter, "all">,
): boolean {
  if (status === "attention") {
    return inventoryItemNeedsAttention(item);
  }
  return item.lifecycle_status === status;
}

/**
 * 在库存标识、产品资料和备注字段中执行不区分大小写的包含搜索。
 * Performs a case-insensitive substring search across inventory identity, product facts, and note fields.
 *
 * @param item - 待搜索的库存记录。 / Inventory item to search.
 * @param normalizedQuery - 已由调用方去除首尾空白并转为小写的非空搜索词。 / Non-empty query already trimmed and lowercased by the caller.
 * @returns 任一已记录的可搜索字段包含搜索词时返回 true。 / True when any recorded searchable field contains the query.
 */
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

/**
 * 为选定的库存排序方式构造确定性比较器。
 * Builds a deterministic comparator for the selected inventory sort mode.
 *
 * @param sort - 期限升序或名称升序。 / Deadline-ascending or name-ascending sort mode.
 * @returns 缺失主排序值排在末尾、主值相同时以库存 ID 决胜的比较器。 / A comparator that places missing primary values last and breaks primary ties by inventory ID.
 */
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

/**
 * 比较两个可空文本值，并把缺失值稳定地排在已记录值之后。
 * Compares nullable text values while consistently placing missing values after recorded values.
 *
 * @param left - 左侧可空文本。 / Nullable text on the left.
 * @param right - 右侧可空文本。 / Nullable text on the right.
 * @returns 左值靠前时为 -1、相等时为 0、靠后时为 1；非空比较不区分大小写。 / -1 when left sorts first, 0 when equal, or 1 when right sorts first; non-null comparison is case-insensitive.
 */
function compareNullableText(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return compareText(left.toLowerCase(), right.toLowerCase());
}

/**
 * 使用 JavaScript 字符串顺序比较两个文本值。
 * Compares two text values using JavaScript string ordering.
 *
 * @param left - 左侧文本。 / Text on the left.
 * @param right - 右侧文本。 / Text on the right.
 * @returns 左值靠前时为 -1、完全相等时为 0、靠后时为 1；不执行本地化排序。 / -1 when left sorts first, 0 when equal, or 1 when right sorts first; no locale-aware collation is performed.
 */
function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * 从完整库存源计算浏览导航所需的各类计数。
 * Computes the browse-navigation counts from the complete inventory source.
 *
 * @param items - 未经当前视图、搜索或分类筛选的完整库存列表。 / Complete inventory list before view, query, or category filtering.
 * @returns 总数、活跃数、归档数、开封数、未开封数以及仅限活跃库存的关注数。 / Total, active, archive, opened, unopened, and active-only attention counts.
 */
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

/**
 * 提取当前生命周期视图中可用的唯一产品分类。
 * Extracts the unique product categories available in the current lifecycle view.
 *
 * @param items - 已限定到当前生命周期视图的库存列表。 / Inventory items already limited to the current lifecycle view.
 * @returns 去除缺失值和完全重复值后按确定性文本顺序排列的分类。 / Categories with missing and exactly duplicated values removed, sorted by deterministic text order.
 */
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

/**
 * 根据当前视图是否有来源数据以及搜索是否生效选择空状态文案。
 * Selects empty-state copy from source availability and active query context.
 *
 * @param viewItemCount - 应用搜索和状态筛选前，当前生命周期视图中的记录数。 / Number of items in the lifecycle view before query and status filtering.
 * @param filteredItemCount - 应用全部浏览条件后的记录数。 / Number of items after all browse conditions are applied.
 * @param view - 当前活跃或归档视图。 / Current active or archive view.
 * @param normalizedQuery - 已去除首尾空白并转为小写的搜索词。 / Trimmed and lowercased query.
 * @returns 有结果时返回 null；否则返回视图为空、搜索无结果或筛选无结果文案。 / Null when results exist; otherwise copy for an empty view, unmatched query, or unmatched filters.
 */
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

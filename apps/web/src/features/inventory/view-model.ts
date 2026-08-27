/**
 * 把 Core API 的库存事实转换为 inventory 页面可以直接消费的显示模型。
 * Transforms Core API inventory facts into presentation models consumed directly by the inventory UI.
 *
 * 本模块只负责筛选、排序、汇总、卡片投影与界面文案；不执行网络请求、持久化或 React 渲染。
 * This module only filters, sorts, summarizes, projects cards, and supplies interface copy; it performs no network requests, persistence, or React rendering.
 */
import type {
  InventoryListItemOutput,
  InventoryStateOutput,
} from "@beautio/contracts";

type OpenedOnAccuracy = NonNullable<
  InventoryStateOutput["opened_on_accuracy"]
>;

export interface InventorySummary {
  readonly total: number;
  readonly opened: number;
  readonly usable: number;
  readonly attention: number;
}

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

export interface InventoryCardView {
  readonly inventoryItemId: string;
  readonly displayName: string;
  readonly image: ProductImageChoice;
  readonly sizeLabel: string;
  readonly bottleLabel: string | null;
  readonly usableUntilLabel: string;
  readonly alerts: readonly InventoryCardAlert[];
  readonly accessibleName: string;
}

export type ProductImageChoice =
  | { readonly kind: "managed"; readonly imageAssetId: string }
  | { readonly kind: "legacy"; readonly imageRef: string }
  | { readonly kind: "none" };

export interface InventoryCardAlert {
  readonly label: string;
  readonly tone: "expired" | "unknown" | "terminal";
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

/**
 * 为每一条具体库存记录创建且只创建一个紧凑卡片投影。
 * Creates exactly one compact card projection for every concrete inventory item.
 *
 * @param items - Core API 返回的单条库存记录。 / Individual inventory items returned by the Core API.
 * @returns 顺序和数量不变的卡片投影，不按 Product 合并，也不推测名称。 / Card projections in the same order and count, without product grouping or inferred names.
 */
export function inventoryCardViews(
  items: readonly InventoryListItemOutput[],
): readonly InventoryCardView[] {
  return items.map((item) => {
    const displayName = item.product?.name ?? "未记录产品名称";
    const sizeLabel = item.product?.size_label ?? "规格未记录";
    const bottleLabel =
      item.product_inventory_count !== null &&
      item.product_inventory_count > 1 &&
      item.product_inventory_position !== null
        ? `第${item.product_inventory_position}瓶`
        : null;
    const usableUntilLabel =
      item.usable_until === null
        ? "可用期未知"
        : `可用至 ${item.usable_until}${usableUntilAccuracySuffix(item)}`;
    const alerts = inventoryCardAlerts(item);
    const accessibleParts = [displayName];
    if (bottleLabel !== null) {
      accessibleParts.push(bottleLabel);
    }
    accessibleParts.push(sizeLabel, usableUntilLabel);
    for (const alert of alerts) {
      if (!accessibleParts.includes(alert.label)) {
        accessibleParts.push(alert.label);
      }
    }
    accessibleParts.push("查看详情");

    return {
      inventoryItemId: item.inventory_item_id,
      displayName,
      image: productImageChoice(item),
      sizeLabel,
      bottleLabel,
      usableUntilLabel,
      alerts,
      accessibleName: accessibleParts.join("，"),
    };
  });
}

/**
 * 选择浏览器获准渲染的唯一 Product 图片来源。
 * Selects the one product image source the browser is allowed to render.
 *
 * @param item - Product 可能包含受管图片和旧版图片事实的库存记录。 / Inventory item whose Product may contain managed and legacy image facts.
 * @returns 优先返回受管 ImageAsset，否则返回未经改写的旧版引用；两者都没有时返回 none。 / Managed ImageAsset first, otherwise the unchanged legacy reference, otherwise none.
 */
export function productImageChoice(
  item: InventoryListItemOutput,
): ProductImageChoice {
  const imageAssetId = managedImageAssetId(item);
  if (imageAssetId !== null) {
    return { kind: "managed", imageAssetId };
  }
  const imageRef = item.product?.image_ref ?? null;
  return imageRef === null
    ? { kind: "none" }
    : { kind: "legacy", imageRef };
}

function usableUntilAccuracySuffix(item: InventoryListItemOutput): string {
  if (
    item.usable_until === null ||
    item.usable_until !== item.pao_deadline
  ) {
    return "";
  }
  if (item.pao_deadline_accuracy === "estimated") {
    return "（估算）";
  }
  if (item.pao_deadline_accuracy === "legacy_unknown") {
    return "（准确性未记录）";
  }
  return "";
}

/**
 * 读取服务端管理的 Product 图片标识，不解释其内部格式。
 * Reads the server-managed product image identifier without interpreting its format.
 *
 * @param item - Product 可能带有受管图片的库存记录。 / Inventory item whose Product may have a managed image.
 * @returns 不透明的 ImageAsset 标识；没有受管图片时返回 null。 / The opaque ImageAsset identifier, or null when no managed image exists.
 */
export function managedImageAssetId(
  item: InventoryListItemOutput,
): string | null {
  return item.product?.image_asset_id ?? null;
}

/**
 * 从库存契约读取开封日期准确性。
 * Reads an opening-date accuracy value from the inventory contract.
 *
 * @param item - 管理端读取模型返回的库存记录。 / Inventory item returned by the management read model.
 * @returns 已存储的准确性分类；没有开封日期时返回 null。 / The stored accuracy classification, or null when no opening date exists.
 */
export function openedOnAccuracy(
  item: InventoryListItemOutput,
): OpenedOnAccuracy | null {
  return item.opened_on_accuracy;
}

/**
 * 从库存契约读取派生的 PAO 截止日期准确性。
 * Reads a derived PAO deadline accuracy value from the inventory contract.
 *
 * @param item - 管理端读取模型返回的库存记录。 / Inventory item returned by the management read model.
 * @returns 继承得到的截止日期准确性；没有 PAO 截止日期时返回 null。 / The inherited deadline accuracy, or null when no PAO deadline exists.
 */
export function paoDeadlineAccuracy(
  item: InventoryListItemOutput,
): OpenedOnAccuracy | null {
  return item.pao_deadline_accuracy;
}

/**
 * 判断提交时是否可以保留未改变的历史准确性标记。
 * Determines whether an unchanged historical accuracy marker may be submitted.
 *
 * @param item - 正在编辑的已持久化库存记录。 / Persisted inventory item being edited.
 * @param lifecycleStatus - 待提交的生命周期值。 / Candidate editable lifecycle value.
 * @param openedOn - 待提交的开封日期。 / Candidate opening date.
 * @returns 仅当旧版库存已经开封且日期保持不变时返回 true。 / True only for an already-opened legacy item whose date remains unchanged.
 */
export function canPreserveLegacyAccuracy(
  item: InventoryListItemOutput,
  lifecycleStatus: "unopened" | "opened",
  openedOn: string | null,
): boolean {
  return (
    lifecycleStatus === "opened" &&
    item.lifecycle_status === "opened" &&
    openedOnAccuracy(item) === "legacy_unknown" &&
    openedOn === item.opened_on
  );
}

/**
 * 把准确性契约值转换为明确的中文界面文案。
 * Converts an accuracy contract value to explicit Chinese interface copy.
 *
 * @param accuracy - 已存储的准确、估算、旧版或缺失准确性值。 / Stored exact, estimated, legacy, or absent accuracy value.
 * @returns 不会把估算日期表述成确认日期的标签。 / A label that does not present estimates as confirmed dates.
 */
export function accuracyLabel(accuracy: OpenedOnAccuracy | null): string {
  return {
    exact: "准确日期",
    estimated: "估算日期",
    legacy_unknown: "历史记录，准确性未记录",
    null: "未记录",
  }[accuracy ?? "null"];
}

function inventoryCardAlerts(
  item: InventoryListItemOutput,
): readonly InventoryCardAlert[] {
  const alerts: InventoryCardAlert[] = [];

  if (
    item.lifecycle_status === "finished" ||
    item.lifecycle_status === "discarded"
  ) {
    alerts.push({
      label: lifecycleLabel(item.lifecycle_status),
      tone: "terminal",
    });
  }

  if (item.usability_status === "expired") {
    alerts.push({ label: "已过可用期", tone: "expired" });
  } else if (item.usability_status === "unknown") {
    alerts.push({ label: "期限未知", tone: "unknown" });
  }

  return alerts;
}

/**
 * 按浏览器本地日历格式化 Core API 契约要求的日期。
 * Formats a valid browser-local calendar date for the explicit Core API contract.
 *
 * @param date - 使用本地年、月、日的有效 Date。 / A valid Date whose local year, month, and day should be used.
 * @returns 不经过 UTC 转换、补齐零位的 YYYY-MM-DD 值。 / A zero-padded YYYY-MM-DD value without converting through UTC.
 * @throws {RangeError} Date 无效时抛出。 / Thrown when the Date is invalid.
 */
export function localDateForApi(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("A valid local date is required.");
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 在不修改输入数据的前提下，统计库存摘要中展示的各类状态。
 * Counts the states shown in the inventory summary without mutating input data.
 *
 * @param items - 只读 Core API 返回的库存投影。 / Inventory projections returned by the read-only Core API.
 * @returns 全部、已开封、可用和需要关注的库存数量。 / Counts for all items, opened items, usable items, and items needing attention.
 */
export function summarizeInventory(
  items: readonly InventoryStateOutput[],
): InventorySummary {
  return items.reduce<InventorySummary>(
    (summary, item) => ({
      total: summary.total + 1,
      opened: summary.opened + (item.lifecycle_status === "opened" ? 1 : 0),
      usable: summary.usable + (item.usability_status === "usable" ? 1 : 0),
      attention:
        summary.attention +
        (inventoryItemNeedsAttention(item) ? 1 : 0),
    }),
    { total: 0, opened: 0, usable: 0, attention: 0 },
  );
}

function inventoryItemNeedsAttention(item: InventoryStateOutput): boolean {
  return item.usability_status !== "usable" || item.warnings.length > 0;
}

/**
 * 把生命周期契约值转换为简洁的中文界面文案。
 * Converts a lifecycle contract value to concise Chinese interface copy.
 *
 * @param status - Core API 返回的稳定生命周期状态。 / Stable lifecycle status from the Core API.
 * @returns 对应的用户可见标签。 / The corresponding user-facing label.
 */
export function lifecycleLabel(
  status: InventoryStateOutput["lifecycle_status"],
): string {
  return {
    unopened: "未开封",
    opened: "已开封",
    finished: "已用完",
    discarded: "已弃置",
  }[status];
}

/**
 * 把可用性契约值转换为简洁的中文界面文案。
 * Converts a usability contract value to concise Chinese interface copy.
 *
 * @param status - Core API 返回的派生可用性状态。 / Derived usability status from the Core API.
 * @returns 对应的用户可见标签。 / The corresponding user-facing label.
 */
export function usabilityLabel(
  status: InventoryStateOutput["usability_status"],
): string {
  return {
    usable: "可用",
    expired: "已过可用期",
    unknown: "暂时未知",
  }[status];
}

/**
 * 把警告契约值转换为解释性的中文界面文案。
 * Converts a warning contract value to explanatory Chinese interface copy.
 *
 * @param warning - Core API 返回的稳定警告代码。 / Stable warning code from the Core API.
 * @returns 对警告条件的直接说明。 / A direct explanation of the warning condition.
 */
export function warningLabel(
  warning: InventoryStateOutput["warnings"][number],
): string {
  return {
    already_expired: "在所选日期已经超过可用期限",
    pao_unknown: "没有 PAO（月数）记录，无法计算开封后期限",
  }[warning];
}

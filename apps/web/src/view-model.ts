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
 * Projects the complete Core API inventory into one client-side browsing view.
 *
 * @param items - Complete inventory list returned by the existing Core API contract.
 * @param options - Lifecycle view, active-state filter, query, category, and deterministic sort.
 * @returns Filtered items plus source counts, categories for the selected lifecycle view, and contextual empty copy.
 *
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
 * Creates exactly one compact card projection for every concrete inventory item.
 *
 * @param items - Individual inventory items returned by the Core API.
 * @returns Card projections in the same order and count, without product grouping or inferred names.
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
 * Selects the one product image source the browser is allowed to render.
 *
 * @param item - Inventory item whose Product may contain managed and legacy image facts.
 * @returns Managed ImageAsset first, otherwise the unchanged legacy reference, otherwise none.
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
 * Reads the server-managed product image identifier without interpreting its format.
 *
 * @param item - Inventory item whose Product may have a managed image.
 * @returns The opaque ImageAsset identifier, or null when no managed image exists.
 */
export function managedImageAssetId(
  item: InventoryListItemOutput,
): string | null {
  return item.product?.image_asset_id ?? null;
}

/**
 * Reads an opening-date accuracy value from the inventory contract.
 *
 * @param item - Inventory item returned by the management read model.
 * @returns The stored accuracy classification, or null when no opening date exists.
 */
export function openedOnAccuracy(
  item: InventoryListItemOutput,
): OpenedOnAccuracy | null {
  return item.opened_on_accuracy;
}

/**
 * Reads a derived PAO deadline accuracy value from the inventory contract.
 *
 * @param item - Inventory item returned by the management read model.
 * @returns The inherited deadline accuracy, or null when no PAO deadline exists.
 */
export function paoDeadlineAccuracy(
  item: InventoryListItemOutput,
): OpenedOnAccuracy | null {
  return item.pao_deadline_accuracy;
}

/**
 * Determines whether an unchanged historical accuracy marker may be submitted.
 *
 * @param item - Persisted inventory item being edited.
 * @param lifecycleStatus - Candidate editable lifecycle value.
 * @param openedOn - Candidate opening date.
 * @returns True only for an already-opened legacy item whose date remains unchanged.
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
 * Converts an accuracy contract value to explicit Chinese interface copy.
 *
 * @param accuracy - Stored exact, estimated, legacy, or absent accuracy value.
 * @returns A label that does not present estimates as confirmed dates.
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
 * Formats a valid browser-local calendar date for the explicit Core API contract.
 *
 * @param date - A valid Date whose local year, month, and day should be used.
 * @returns A zero-padded YYYY-MM-DD value without converting through UTC.
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
 * Counts the states shown in the inventory summary without mutating input data.
 *
 * @param items - Inventory projections returned by the read-only Core API.
 * @returns Counts for all items, opened items, usable items, and items needing attention.
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
 * Converts a lifecycle contract value to concise Chinese interface copy.
 *
 * @param status - Stable lifecycle status from the Core API.
 * @returns The corresponding user-facing label.
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
 * Converts a usability contract value to concise Chinese interface copy.
 *
 * @param status - Derived usability status from the Core API.
 * @returns The corresponding user-facing label.
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
 * Converts a warning contract value to explanatory Chinese interface copy.
 *
 * @param warning - Stable warning code from the Core API.
 * @returns A direct explanation of the warning condition.
 */
export function warningLabel(
  warning: InventoryStateOutput["warnings"][number],
): string {
  return {
    already_expired: "在所选日期已经超过可用期限",
    pao_unknown: "没有 PAO（月数）记录，无法计算开封后期限",
  }[warning];
}

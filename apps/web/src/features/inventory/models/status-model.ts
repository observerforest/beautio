/**
 * 汇总 inventory 状态，并把生命周期、可用性与警告契约转换为界面标签。
 * Summarizes inventory state and converts lifecycle, usability, and warning contracts into interface labels.
 */
import type { InventoryStateOutput } from "@beautio/contracts";

export interface InventorySummary {
  readonly total: number;
  readonly opened: number;
  readonly usable: number;
  readonly attention: number;
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

/**
 * 判断库存状态是否需要页面提醒用户关注。
 * Determines whether an inventory state needs user attention in the interface.
 *
 * @param item - 包含可用性状态和稳定警告代码的库存状态。 / Inventory state containing usability status and stable warning codes.
 * @returns 库存不可用或至少包含一个警告时返回 true。 / True when the inventory is not usable or contains at least one warning.
 */
export function inventoryItemNeedsAttention(
  item: InventoryStateOutput,
): boolean {
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

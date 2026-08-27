/**
 * 把单条库存事实转换为卡片与无障碍文案所需的显示模型。
 * Transforms individual inventory facts into presentation models for cards and accessible copy.
 */
import type { InventoryListItemOutput } from "@beautio/contracts";
import { productImageChoice, type ProductImageChoice } from "./image-model.ts";
import { lifecycleLabel } from "./status-model.ts";

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

export interface InventoryCardAlert {
  readonly label: string;
  readonly tone: "expired" | "unknown" | "terminal";
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

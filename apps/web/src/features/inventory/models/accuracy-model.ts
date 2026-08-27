/**
 * 解释 inventory 日期准确性契约，并约束旧版准确性标记的保留条件。
 * Interprets inventory date-accuracy contracts and constrains preservation of legacy accuracy markers.
 */
import type {
  InventoryListItemOutput,
  InventoryStateOutput,
} from "@beautio/contracts";

type OpenedOnAccuracy = NonNullable<
  InventoryStateOutput["opened_on_accuracy"]
>;

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

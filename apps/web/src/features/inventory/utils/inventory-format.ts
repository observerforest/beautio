import { AdminApiError, type OpenedOnAccuracy } from "../../../admin-api.ts";
import { accuracyLabel } from "../models/accuracy-model.ts";

/**
 * 显示可选的已记录事实，不虚构替代值。
 * Displays an optional recorded fact without inventing a substitute.
 *
 * @param value - 已记录文本或 null。 / Recorded text or null.
 * @returns 已记录值，或明确的缺失标签。 / The recorded value or an explicit missing label.
 */
export function displayValue(value: string | null): string {
  return value ?? "未记录";
}

/**
 * 将已记录日期与其证据精度一起格式化。
 * Formats a recorded date together with its evidence accuracy.
 *
 * @param value - 已记录的 YYYY-MM-DD 日期或 null。 / Recorded YYYY-MM-DD date or null.
 * @param accuracy - 精确、估算、旧版或缺失的证据标记。 / Exact, estimated, legacy, or absent evidence marker.
 * @param translate - Optional interface-copy translator; user-entered values are never translated.
 * @returns 明确的日期与精度文案，或缺失标签。 / Explicit date and accuracy copy, or a missing label.
 */
export function dateWithAccuracy(
  value: string | null,
  accuracy: OpenedOnAccuracy | null,
  translate: (source: string) => string = (source) => source,
): string {
  return value === null
    ? translate("未记录")
    : `${value} (${translate(accuracyLabel(accuracy))})`;
}

/**
 * 将预期内的浏览器与 Admin API 故障转换为安全的界面文案。
 * Converts expected browser and Admin API failures to safe interface copy.
 *
 * @param error - 未知的拒绝值。 / Unknown rejected value.
 * @returns 面向用户且绝不包含 Admin 凭证的文案。 / User-facing copy that never includes an Admin credential.
 */
export function inventoryErrorMessage(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  if (error instanceof TypeError) {
    return "无法连接 Beautio 服务，请确认服务正在运行。";
  }
  return "发生了未知错误，请稍后再试。";
}

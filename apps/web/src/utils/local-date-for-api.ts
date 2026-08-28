/**
 * 按浏览器本地日历格式化 API 契约要求的日期。
 * Formats a valid browser-local calendar date for an API contract.
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

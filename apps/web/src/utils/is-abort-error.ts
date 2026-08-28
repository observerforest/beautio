/**
 * 判断未知拒绝值是否为浏览器主动取消操作产生的 AbortError。
 * Determines whether an unknown rejection is an AbortError from a browser cancellation.
 *
 * @param error - 未知的拒绝值。 / Unknown rejected value.
 * @returns 该值是否为 DOM AbortError。 / Whether the value is a DOM AbortError.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Normalizes optional text entered in a management form.
 *
 * @param value - Current browser control value.
 * @returns Trimmed text, or null when the control contains only whitespace.
 */
export function normalizeOptionalEditorText(value: string): string | null {
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

/**
 * Formats a live character counter using the same string length observed by inputs.
 *
 * @param value - Current browser control value.
 * @param maximum - Positive maximum configured on the control.
 * @returns A compact current-length and maximum label.
 */
export function textCharacterCountLabel(
  value: string,
  maximum: number,
): string {
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new RangeError("A positive character limit is required.");
  }
  return `${value.length} / ${maximum}`;
}

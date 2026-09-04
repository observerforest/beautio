import type { InventoryListItemOutput } from "@beautio/contracts";

export interface InventoryPaoScope {
  readonly productMonths: number | null;
  readonly bottleMonths: number | null;
  readonly bottleEditable: boolean;
  readonly missingProduct: boolean;
  readonly hasHistoricalDifference: boolean;
}

/**
 * Reads the shared Product duration separately from the bottle's effective snapshot.
 *
 * @param item - Actual inventory response; a missing Product is never inferred from a bottle.
 * @returns Scope and discrepancy flags. Only a genuinely unlinked bottle can edit its own
 * PAO; linked bottles preserve their effective snapshot, including legacy differences.
 */
export function inventoryPaoScope(item: InventoryListItemOutput): InventoryPaoScope {
  const productMonths = item.product?.pao_duration_months ?? null;
  return {
    productMonths,
    bottleMonths: item.pao_duration_months,
    bottleEditable: item.product_id === null && item.product === null,
    missingProduct: item.product_id !== null && item.product === null,
    hasHistoricalDifference: item.product !== null && item.pao_duration_months !== productMonths,
  };
}

/**
 * Validates a PAO field without converting exponent, fractional, or signed drafts.
 *
 * @param value - Current unmodified field text.
 * @returns Null for blank, an integer from 1 through 120, or undefined for invalid input.
 */
export function parsePaoDuration(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const months = Number(trimmed);
  return Number.isInteger(months) && months >= 1 && months <= 120 ? months : undefined;
}

/**
 * Formats a recorded PAO duration without substituting a bottle value for a missing Product value.
 *
 * @param months - Explicit recorded duration, or null when unknown.
 * @param locale - Interface language used for the month unit.
 * @param translate - Interface translator used for the missing-value label.
 * @returns A localized month count or an explicit unrecorded label.
 */
export function paoDurationLabel(
  months: number | null,
  locale: "en" | "zh-CN",
  translate: (source: string) => string,
): string {
  return months === null ? translate("未记录") : locale === "en" ? `${months} months` : `${months} 个月`;
}

/**
 * Preserves an existing linked bottle's effective PAO when sending the legacy full-facts PUT.
 *
 * @param item - Current inventory snapshot, including shared Product scope.
 * @param draft - PAO text editable only for genuinely unlinked inventory.
 * @returns The exact existing bottle value for linked inventory, or a validated unlinked draft.
 */
export function paoForBottleUpdate(item: InventoryListItemOutput, draft: string): number | null | undefined {
  return inventoryPaoScope(item).bottleEditable ? parsePaoDuration(draft) : item.pao_duration_months;
}

/**
 * Includes shared PAO only when its normalized value has actually changed.
 *
 * @param currentMonths - Recorded Product duration at editor opening.
 * @param nextMonths - Validated duration requested by the user, or null to clear it.
 * @returns An optional Product update field. Unchanged values are omitted so an unrelated
 * Product edit does not incidentally reconcile historical bottle durations.
 */
export function changedProductPao(
  currentMonths: number | null,
  nextMonths: number | null,
): { readonly pao_duration_months?: number | null } {
  return currentMonths === nextMonths ? {} : { pao_duration_months: nextMonths };
}

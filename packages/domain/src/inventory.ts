import {
  addCalendarMonthsClamped,
  parseNullableDate,
  type IsoDate,
} from "./dates.ts";
import { BeautioError } from "./errors.ts";
import {
  customNotesMaximumLength,
  ingredientListTextMaximumLength,
  normalizeNullableText,
  normalizeOptionalText,
  requireText,
  sharedNotesMaximumLength,
} from "./text.ts";

export const lifecycleStatuses = [
  "unopened",
  "opened",
  "finished",
  "discarded",
] as const;

export const usabilityStatuses = ["usable", "expired", "unknown"] as const;

export const inventoryWarnings = ["already_expired", "pao_unknown"] as const;

export const openedOnAccuracies = [
  "exact",
  "estimated",
  "legacy_unknown",
] as const;

export const imageMediaTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const imageAssetStatuses = [
  "staging",
  "temporary",
  "linked",
  "pending_cleanup",
] as const;

export type LifecycleStatus = (typeof lifecycleStatuses)[number];
export type UsabilityStatus = (typeof usabilityStatuses)[number];
export type InventoryWarning = (typeof inventoryWarnings)[number];
export type OpenedOnAccuracy = (typeof openedOnAccuracies)[number];
export type ImageMediaType = (typeof imageMediaTypes)[number];
export type ImageAssetStatus = (typeof imageAssetStatuses)[number];

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly sizeLabel: string | null;
  readonly imageAssetId: string | null;
  readonly imageRef: string | null;
  readonly ingredientListText: string | null;
  readonly sharedNotes: string | null;
}

export interface InventoryItem {
  readonly id: string;
  readonly productId: string | null;
  readonly lifecycleStatus: LifecycleStatus;
  readonly openedOn: IsoDate | null;
  readonly openedOnAccuracy: OpenedOnAccuracy | null;
  readonly expiresOn: IsoDate | null;
  readonly paoDurationMonths: number | null;
  readonly paoDeadline: IsoDate | null;
  readonly usableUntil: IsoDate | null;
  readonly customNotes: string | null;
}

export interface InventorySnapshot {
  readonly inventoryItemId: string;
  readonly lifecycleStatus: LifecycleStatus;
  readonly openedOn: IsoDate | null;
  readonly openedOnAccuracy: OpenedOnAccuracy | null;
  readonly expiresOn: IsoDate | null;
  readonly paoDurationMonths: number | null;
  readonly paoDeadline: IsoDate | null;
  readonly paoDeadlineAccuracy: OpenedOnAccuracy | null;
  readonly usableUntil: IsoDate | null;
  readonly usabilityStatus: UsabilityStatus;
  readonly warnings: readonly InventoryWarning[];
  readonly customNotes: string | null;
}

export interface ImageAsset {
  readonly id: string;
  readonly storageKey: string;
  readonly mediaType: ImageMediaType;
  readonly byteSize: number;
  readonly status: ImageAssetStatus;
  readonly productId: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface OpenInventoryResult {
  readonly outcome: "opened" | "already_opened";
  readonly item: InventoryItem;
  readonly snapshot: InventorySnapshot & {
    readonly lifecycleStatus: "opened";
    readonly openedOn: IsoDate;
  };
}

export interface EditableInventoryFacts {
  readonly lifecycleStatus: "unopened" | "opened";
  readonly openedOn: string | null;
  readonly openedOnAccuracy: OpenedOnAccuracy | null;
  readonly expiresOn: string | null;
  readonly paoDurationMonths: number | null;
  readonly customNotes?: string | null;
}

/**
 * Creates a validated inventory item for persistence or deterministic tests.
 *
 * @param input - Initial inventory facts. Missing PAO or expiry remains unknown.
 * @returns A normalized inventory item with derived initial usable-until data.
 */
export function createInventoryItem(input: {
  readonly id: string;
  readonly productId?: string | null;
  readonly lifecycleStatus: LifecycleStatus;
  readonly openedOn?: string | null;
  readonly openedOnAccuracy?: OpenedOnAccuracy | null;
  readonly expiresOn?: string | null;
  readonly paoDurationMonths?: number | null;
  readonly paoDeadline?: string | null;
  readonly usableUntil?: string | null;
  readonly customNotes?: string | null;
}): InventoryItem {
  const id = input.id.trim();
  if (id.length === 0) {
    throw new BeautioError("INVALID_INPUT", "inventory_item_id is required");
  }

  const productId = normalizeOptionalText(input.productId, "product_id");

  const openedOn = parseNullableDate(input.openedOn, "opened_on");
  const openedOnAccuracy =
    openedOn === null
      ? normalizeMissingAccuracy(input.openedOnAccuracy)
      : (input.openedOnAccuracy ?? "legacy_unknown");
  const expiresOn = parseNullableDate(input.expiresOn, "expires_on");
  const paoDeadline = parseNullableDate(input.paoDeadline, "pao_deadline");
  const explicitUsableUntil = parseNullableDate(
    input.usableUntil,
    "usable_until",
  );
  const paoDurationMonths = input.paoDurationMonths ?? null;
  const customNotes = normalizeNullableText(
    input.customNotes,
    "custom_notes",
    customNotesMaximumLength,
  );

  if (
    paoDurationMonths !== null &&
    (!Number.isInteger(paoDurationMonths) ||
      paoDurationMonths < 1 ||
      paoDurationMonths > 120)
  ) {
    throw new BeautioError(
      "INVALID_INPUT",
      "pao_duration_months must be an integer from 1 through 120",
    );
  }

  if (input.lifecycleStatus === "opened" && openedOn === null) {
    throw new BeautioError(
      "INVALID_INPUT",
      "opened inventory requires opened_on",
    );
  }

  if (input.lifecycleStatus === "unopened" && openedOn !== null) {
    throw new BeautioError(
      "INVALID_INPUT",
      "unopened inventory cannot have opened_on",
    );
  }

  if (openedOn === null && openedOnAccuracy !== null) {
    throw new BeautioError(
      "INVALID_INPUT",
      "opened_on_accuracy requires opened_on",
    );
  }

  return {
    id,
    productId,
    lifecycleStatus: input.lifecycleStatus,
    openedOn,
    openedOnAccuracy,
    expiresOn,
    paoDurationMonths,
    paoDeadline,
    usableUntil: explicitUsableUntil ?? minimumKnownDate(expiresOn, paoDeadline),
    customNotes,
  };
}

/**
 * Creates validated product information that may be shared by many bottles.
 *
 * @param input - Product identity and shared display facts.
 * @returns A normalized Product entity with explicitly nullable size and image references.
 */
export function createProduct(input: {
  readonly id: string;
  readonly name: string;
  readonly category?: string | null;
  readonly sizeLabel?: string | null;
  readonly imageAssetId?: string | null;
  readonly imageRef?: string | null;
  readonly ingredientListText?: string | null;
  readonly sharedNotes?: string | null;
}): Product {
  return {
    id: requireText(input.id, "product_id"),
    name: requireText(input.name, "product_name"),
    category: normalizeOptionalText(input.category, "product_category"),
    sizeLabel: normalizeOptionalText(input.sizeLabel, "size_label"),
    imageAssetId: normalizeOptionalText(input.imageAssetId, "image_asset_id"),
    imageRef: normalizeOptionalText(input.imageRef, "image_ref"),
    ingredientListText: normalizeNullableText(
      input.ingredientListText,
      "ingredient_list_text",
      ingredientListTextMaximumLength,
    ),
    sharedNotes: normalizeNullableText(
      input.sharedNotes,
      "shared_notes",
      sharedNotesMaximumLength,
    ),
  };
}

/**
 * Builds inventory state from editable direct facts and derives all deadlines.
 *
 * @param identity - Server-owned inventory and Product identifiers.
 * @param facts - Caller-supplied direct facts after contract validation.
 * @returns A validated item whose PAO and usable deadlines are recalculated.
 */
export function createInventoryItemFromFacts(
  identity: { readonly id: string; readonly productId: string },
  facts: EditableInventoryFacts,
): InventoryItem {
  const openedOn = parseNullableDate(facts.openedOn, "opened_on");
  const expiresOn = parseNullableDate(facts.expiresOn, "expires_on");
  const paoDurationMonths = facts.paoDurationMonths;

  if (
    paoDurationMonths !== null &&
    (!Number.isInteger(paoDurationMonths) ||
      paoDurationMonths < 1 ||
      paoDurationMonths > 120)
  ) {
    throw new BeautioError(
      "INVALID_INPUT",
      "pao_duration_months must be an integer from 1 through 120",
    );
  }

  if (facts.lifecycleStatus === "unopened") {
    if (openedOn !== null || facts.openedOnAccuracy !== null) {
      throw new BeautioError(
        "INVALID_INPUT",
        "unopened inventory cannot have opening facts",
      );
    }
  } else if (openedOn === null || facts.openedOnAccuracy === null) {
    throw new BeautioError(
      "INVALID_INPUT",
      "opened inventory requires opened_on and opened_on_accuracy",
    );
  }

  const paoDeadline =
    openedOn === null || paoDurationMonths === null
      ? null
      : addCalendarMonthsClamped(openedOn, paoDurationMonths);

  return createInventoryItem({
    id: identity.id,
    productId: identity.productId,
    lifecycleStatus: facts.lifecycleStatus,
    openedOn,
    openedOnAccuracy: facts.openedOnAccuracy,
    expiresOn,
    paoDurationMonths,
    paoDeadline,
    usableUntil: minimumKnownDate(expiresOn, paoDeadline),
    customNotes: facts.customNotes ?? null,
  });
}

/**
 * Applies the record-opened domain transition without persistence concerns.
 *
 * @param item - Current inventory state.
 * @param openedOn - Explicit date supplied by the caller.
 * @returns The new state and a snapshot evaluated on the opening date.
 */
export function openInventoryItem(
  item: InventoryItem,
  openedOn: IsoDate,
): OpenInventoryResult {
  if (
    item.lifecycleStatus === "finished" ||
    item.lifecycleStatus === "discarded"
  ) {
    throw new BeautioError(
      "INVENTORY_ITEM_TERMINAL",
      `inventory item is ${item.lifecycleStatus} and cannot be opened`,
    );
  }

  if (item.lifecycleStatus === "opened") {
    if (item.openedOn !== openedOn) {
      throw new BeautioError(
        "OPENED_ON_CONFLICT",
        "inventory item is already opened on a different date",
      );
    }

    return {
      outcome: "already_opened",
      item,
      snapshot: asOpenedSnapshot(deriveInventorySnapshot(item, openedOn)),
    };
  }

  const paoDeadline =
    item.paoDurationMonths === null
      ? null
      : addCalendarMonthsClamped(openedOn, item.paoDurationMonths);
  const usableUntil = minimumKnownDate(item.expiresOn, paoDeadline);
  const openedItem: InventoryItem = {
    ...item,
    lifecycleStatus: "opened",
    openedOn,
    openedOnAccuracy: "legacy_unknown",
    paoDeadline,
    usableUntil,
  };

  return {
    outcome: "opened",
    item: openedItem,
    snapshot: asOpenedSnapshot(
      deriveInventorySnapshot(openedItem, openedOn),
    ),
  };
}

/**
 * Derives reproducible usability and warning data for an explicit date.
 *
 * @param item - Persisted inventory facts and derived lifecycle deadlines.
 * @param asOf - Explicit comparison date supplied by the caller.
 * @returns A read model that keeps lifecycle and usability separate.
 */
export function deriveInventorySnapshot(
  item: InventoryItem,
  asOf: IsoDate,
): InventorySnapshot {
  const usabilityStatus =
    item.usableUntil === null
      ? "unknown"
      : item.usableUntil < asOf
        ? "expired"
        : "usable";
  const warnings: InventoryWarning[] = [];

  if (usabilityStatus === "expired") {
    warnings.push("already_expired");
  }
  if (item.paoDurationMonths === null) {
    warnings.push("pao_unknown");
  }

  return {
    inventoryItemId: item.id,
    lifecycleStatus: item.lifecycleStatus,
    openedOn: item.openedOn,
    openedOnAccuracy: item.openedOnAccuracy,
    expiresOn: item.expiresOn,
    paoDurationMonths: item.paoDurationMonths,
    paoDeadline: item.paoDeadline,
    paoDeadlineAccuracy:
      item.paoDeadline === null ? null : item.openedOnAccuracy,
    usableUntil: item.usableUntil,
    usabilityStatus,
    warnings,
    customNotes: item.customNotes,
  };
}

function normalizeMissingAccuracy(
  value: OpenedOnAccuracy | null | undefined,
): null {
  if (value !== null && value !== undefined) {
    throw new BeautioError(
      "INVALID_INPUT",
      "opened_on_accuracy requires opened_on",
    );
  }
  return null;
}

function minimumKnownDate(
  first: IsoDate | null,
  second: IsoDate | null,
): IsoDate | null {
  if (first === null) {
    return second;
  }
  if (second === null) {
    return first;
  }
  return first < second ? first : second;
}

function asOpenedSnapshot(
  snapshot: InventorySnapshot,
): InventorySnapshot & {
  readonly lifecycleStatus: "opened";
  readonly openedOn: IsoDate;
} {
  if (snapshot.lifecycleStatus !== "opened" || snapshot.openedOn === null) {
    throw new Error("opened transition produced an invalid snapshot");
  }
  return {
    ...snapshot,
    lifecycleStatus: "opened",
    openedOn: snapshot.openedOn,
  };
}

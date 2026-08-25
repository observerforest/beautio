import {
  BeautioError,
  type InventoryItem,
  type Product,
} from "@beautio/domain";

export function assertProductMatches(
  existing: Product,
  incoming: Product,
): void {
  if (
    existing.name !== incoming.name ||
    existing.category !== incoming.category ||
    existing.sizeLabel !== incoming.sizeLabel ||
    existing.imageAssetId !== incoming.imageAssetId ||
    existing.imageRef !== incoming.imageRef ||
    existing.ingredientListText !== incoming.ingredientListText ||
    existing.sharedNotes !== incoming.sharedNotes
  ) {
    throw importConflict("product", incoming.id);
  }
}

export function assertInventoryMatches(
  existing: InventoryItem,
  incoming: InventoryItem,
): void {
  if (
    existing.productId !== incoming.productId ||
    existing.lifecycleStatus !== incoming.lifecycleStatus ||
    existing.openedOn !== incoming.openedOn ||
    existing.openedOnAccuracy !== incoming.openedOnAccuracy ||
    existing.expiresOn !== incoming.expiresOn ||
    existing.paoDurationMonths !== incoming.paoDurationMonths ||
    existing.paoDeadline !== incoming.paoDeadline ||
    existing.usableUntil !== incoming.usableUntil ||
    existing.customNotes !== incoming.customNotes
  ) {
    throw importConflict("inventory item", incoming.id);
  }
}

export function mapSqliteConflict(
  error: unknown,
  message: string,
): BeautioError {
  if (error instanceof BeautioError) {
    return error;
  }
  if (isSqliteConstraintError(error)) {
    return new BeautioError("BATCH_CONFLICT", message);
  }
  return new BeautioError("INTERNAL_ERROR", "database write failed");
}

function importConflict(entityName: string, id: string): BeautioError {
  return new BeautioError(
    "INVALID_INPUT",
    `${entityName} ${id} already exists with different data`,
  );
}

function isSqliteConstraintError(
  error: unknown,
): error is { readonly errcode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    typeof error.errcode === "number" &&
    (error.errcode & 0xff) === 19
  );
}

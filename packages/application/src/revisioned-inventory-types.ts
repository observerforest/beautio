import type { EntityRevision, InventoryItem, Product } from "@beautio/domain";
import type { InventoryFactsPatch, ProductProfilePatch } from "@beautio/contracts";

export interface VersionedProduct {
  readonly product: Product;
  readonly revision: EntityRevision;
}

export interface VersionedInventoryItem {
  readonly item: InventoryItem;
  readonly revision: EntityRevision;
  readonly product: VersionedProduct | null;
}

export interface ReviseProductProfilePersistenceInput {
  readonly productId: string;
  readonly expectedRevision: EntityRevision;
  readonly patch: ProductProfilePatch;
}

export interface CorrectInventoryItemFactsPersistenceInput {
  readonly inventoryItemId: string;
  readonly expectedRevision: EntityRevision;
  readonly patch: InventoryFactsPatch;
}

export class RevisionError extends Error {
  readonly code: "REVISION_CONFLICT" | "REVISION_STORE_FAILURE";

  /**
   * Reports a stable revision failure without returning stored facts or tokens.
   * @param code - Conflict or unavailable revision metadata.
   * @param message - Safe explanation of the failed operation.
   */
  constructor(code: RevisionError["code"], message: string) {
    super(message);
    this.name = "RevisionError";
    this.code = code;
  }
}

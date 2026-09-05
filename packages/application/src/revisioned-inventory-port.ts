import type {
  CorrectInventoryItemFactsPersistenceInput,
  ReviseProductProfilePersistenceInput,
  VersionedInventoryItem,
  VersionedProduct,
} from "./revisioned-inventory-types.ts";

export interface RevisionedInventoryRepository {
  /**
   * Reads an item, its Product and their versions from one database snapshot.
   * @param inventoryItemId - Exact existing inventory identifier.
   * @returns A consistent versioned snapshot, or null when the item is absent.
   */
  findVersionedInventoryItem(inventoryItemId: string): Promise<VersionedInventoryItem | null>;

  /**
   * Checks a Product version and applies a narrow patch in one transaction.
   * @param input - Target, expected revision and strictly parsed profile fields.
   * @returns The committed Product and revision; conflict leaves all facts unchanged.
   */
  reviseProductProfile(input: ReviseProductProfilePersistenceInput): Promise<VersionedProduct>;

  /**
   * Checks a bottle version and corrects direct facts without a lifecycle transition.
   * @param input - Target, expected revision and strictly parsed direct facts.
   * @returns The committed consistent snapshot; every failure rolls back the transaction.
   */
  correctInventoryItemFacts(input: CorrectInventoryItemFactsPersistenceInput): Promise<VersionedInventoryItem>;
}

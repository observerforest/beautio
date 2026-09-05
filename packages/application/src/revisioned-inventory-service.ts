import {
  correctInventoryItemFactsInputSchema, inventoryItemIdSchema, productIdSchema,
  reviseProductProfileInputSchema, versionedReadOptionsSchema,
  type VersionedInventoryOutput, type VersionedProductOutput,
} from "@beautio/contracts";
import { BeautioError, parseIsoDate } from "@beautio/domain";
import { parseInput } from "./input-parsing.ts";
import { toInventoryReadModelOutput, toReadInventoryProductOutput } from "./output-mappers.ts";
import type { RevisionedInventoryRepository } from "./revisioned-inventory-port.ts";
import type { VersionedInventoryItem } from "./revisioned-inventory-types.ts";

export class RevisionedInventoryService {
  readonly #repository: RevisionedInventoryRepository;

  /**
   * Composes strict application commands over an atomic version-aware repository.
   * @param repository - Persistence that checks versions and writes in one transaction.
   */
  constructor(repository: RevisionedInventoryRepository) { this.#repository = repository; }

  /**
   * Reads facts and versions for a later confirmed edit.
   * @param inventoryItemId - Exact inventory identifier.
   * @param options - Optional explicit date for derived status; no implicit clock.
   * @returns Safe facts and matching revisions without managed image identifiers.
   */
  async fetchInventoryItem(inventoryItemId: string, options: unknown = {}): Promise<VersionedInventoryOutput> {
    const id = parseInput(inventoryItemIdSchema, inventoryItemId);
    const input = parseInput(versionedReadOptionsSchema, options);
    const snapshot = await this.#repository.findVersionedInventoryItem(id);
    if (snapshot === null) throw new BeautioError("INVENTORY_ITEM_NOT_FOUND", "inventory item does not exist");
    return toVersionedInventoryOutput(snapshot, input.as_of);
  }

  /**
   * Applies only supplied Product fields against a required expected revision.
   * @param productId - Exact shared Product identifier.
   * @param untrustedInput - Strict partial profile and server-issued expected revision.
   * @returns Committed public Product facts and its resulting version.
   */
  async reviseProductProfile(productId: string, untrustedInput: unknown): Promise<VersionedProductOutput> {
    const id = parseInput(productIdSchema, productId);
    const { expected_revision, ...patch } = parseInput(reviseProductProfileInputSchema, untrustedInput);
    const committed = await this.#repository.reviseProductProfile({ productId: id, expectedRevision: expected_revision, patch: Object.freeze(patch) });
    return { ...toReadInventoryProductOutput(committed.product), revision: committed.revision };
  }

  /**
   * Corrects direct bottle facts without accepting a lifecycle transition.
   * @param inventoryItemId - Exact existing active bottle identifier.
   * @param untrustedInput - Strict partial direct facts and expected revision.
   * @returns Committed safe facts and versions, without an implicitly derived status.
   */
  async correctInventoryItemFacts(inventoryItemId: string, untrustedInput: unknown): Promise<VersionedInventoryOutput> {
    const id = parseInput(inventoryItemIdSchema, inventoryItemId);
    const { expected_revision, ...patch } = parseInput(correctInventoryItemFactsInputSchema, untrustedInput);
    const committed = await this.#repository.correctInventoryItemFacts({ inventoryItemId: id, expectedRevision: expected_revision, patch: Object.freeze(patch) });
    return toVersionedInventoryOutput(committed);
  }
}

function toVersionedInventoryOutput(snapshot: VersionedInventoryItem, asOf?: string): VersionedInventoryOutput {
  const output = toInventoryReadModelOutput(snapshot.item, snapshot.product?.product ?? null, asOf === undefined ? null : parseIsoDate(asOf, "as_of"));
  return {
    ...output,
    revision: snapshot.revision,
    product: snapshot.product === null ? null : {
      ...toReadInventoryProductOutput(snapshot.product.product), revision: snapshot.product.revision,
    },
  };
}

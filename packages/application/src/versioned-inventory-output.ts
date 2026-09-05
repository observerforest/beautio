import type { VersionedInventoryOutput } from "@beautio/contracts";
import { parseIsoDate } from "@beautio/domain";
import { toInventoryReadModelOutput, toReadInventoryProductOutput } from "./output-mappers.ts";
import type { VersionedInventoryItem } from "./revisioned-inventory-types.ts";

/**
 * Projects one coherent versioned snapshot without exposing managed image identifiers.
 *
 * @param snapshot - Bottle, shared Product and revisions read in one repository transaction.
 * @param asOf - Optional explicit comparison date; omitted dates do not use a clock.
 * @returns Public facts, matching revisions and optional derived status.
 */
export function toVersionedInventoryOutput(snapshot: VersionedInventoryItem, asOf?: string): VersionedInventoryOutput {
  const output = toInventoryReadModelOutput(snapshot.item, snapshot.product?.product ?? null, asOf === undefined ? null : parseIsoDate(asOf, "as_of"));
  return {
    ...output,
    revision: snapshot.revision,
    product: snapshot.product === null ? null : {
      ...toReadInventoryProductOutput(snapshot.product.product), revision: snapshot.product.revision,
    },
  };
}

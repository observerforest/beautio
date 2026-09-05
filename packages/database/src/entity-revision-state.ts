import { RevisionError } from "@beautio/application";
import { parseEntityRevision, type EntityRevision } from "@beautio/domain";
export { maximumEntityRevision } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";

export type RevisionEntityKind = "product" | "inventory_item";

/**
 * Verifies the singleton clock without manufacturing replacement metadata.
 *
 * @param database - Connection inside the caller's schema or snapshot transaction.
 * @param requireCapacity - Whether one more safe revision must remain available.
 * @returns The stored high-water mark; malformed or missing state fails closed.
 */
export function readRevisionClock(
  database: DatabaseSync,
  requireCapacity: boolean,
): number {
  const rows = database.prepare("SELECT singleton, high_water FROM revision_clock").all();
  const row = rows[0];
  if (
    rows.length !== 1 || row === undefined || row.singleton !== 1 ||
    typeof row.high_water !== "number" ||
    !Number.isSafeInteger(row.high_water) || row.high_water < 0 ||
    (requireCapacity && row.high_water === Number.MAX_SAFE_INTEGER)
  ) {
    throw revisionStoreFailure();
  }
  return row.high_water;
}

/**
 * Reads an existing entity's revision within the caller's consistent snapshot.
 *
 * @param database - Connection inside a transaction that already read the entity.
 * @param kind - Entity table discriminator.
 * @param id - Existing entity identifier.
 * @returns A safe revision bounded by the intact persistent clock.
 */
export function readEntityRevision(
  database: DatabaseSync,
  kind: RevisionEntityKind,
  id: string,
): EntityRevision {
  const highWater = readRevisionClock(database, false);
  const row = database.prepare(
    "SELECT revision FROM entity_revisions WHERE entity_kind = ? AND entity_id = ?",
  ).get(kind, id);
  if (
    row === undefined || typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) || row.revision < 1 ||
    row.revision > highWater
  ) {
    throw revisionStoreFailure();
  }
  return parseEntityRevision(row.revision);
}

/**
 * Creates the stable error used when revision persistence cannot be trusted.
 *
 * @returns A metadata failure without SQLite statements or stored values.
 */
export function revisionStoreFailure(): RevisionError {
  return new RevisionError("REVISION_STORE_FAILURE", "entity revision storage is unavailable");
}

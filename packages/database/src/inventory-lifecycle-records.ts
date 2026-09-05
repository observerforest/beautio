import type {
  InventoryItemCustomNotesPersistenceInput, RecordProductOpenedPersistenceInput, RecordProductOpenedPersistenceResult,
} from "@beautio/application";
import { BeautioError, endInventoryItem, openInventoryItem, updateInventoryItemPao, type InventoryItem } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { readInventoryItem, readProduct, updateInventoryRow } from "./records.ts";

/**
 * Opens the current bottle, preserving the existing PAO inheritance and idempotence rules.
 * @param database - Connection whose caller owns the synchronous write transaction.
 * @param input - Exact target, opening date and accuracy.
 * @returns Verified opening facts before transaction commit.
 */
export function recordProductOpenedInTransaction(database: DatabaseSync, input: RecordProductOpenedPersistenceInput): RecordProductOpenedPersistenceResult {
  let current = requireItem(database, input.inventoryItemId);
  if (current.lifecycleStatus === "unopened" && current.paoDurationMonths === null && current.productId !== null) {
    current = updateInventoryItemPao(current, readProduct(database, current.productId)?.paoDurationMonths ?? null);
  }
  const transition = openInventoryItem(current, input.openedOn, input.openedOnAccuracy);
  if (transition.outcome === "opened") updateInventoryRow(database, transition.item);
  const persisted = readInventoryItem(database, input.inventoryItemId);
  if (persisted === null || persisted.lifecycleStatus !== "opened" || persisted.openedOn !== input.openedOn || persisted.openedOnAccuracy !== input.openedOnAccuracy) {
    throw new BeautioError("INTERNAL_ERROR", "database write could not be verified");
  }
  return { outcome: transition.outcome, item: persisted };
}

/**
 * Ends the current stored bottle using the existing domain transition.
 * @param database - Connection whose caller owns transaction settlement.
 * @param candidate - Target identity, intended terminal status and remaining snapshot.
 * @returns Verified terminal bottle before commit; active or repeated terminal requests fail.
 */
export function endInventoryItemInTransaction(
  database: DatabaseSync,
  candidate: Pick<InventoryItem, "id" | "lifecycleStatus" | "remainingPercentEstimate">,
): InventoryItem {
  const current = requireItem(database, candidate.id);
  let terminal: InventoryItem;
  if (candidate.lifecycleStatus === "finished") terminal = endInventoryItem(current, { lifecycleStatus: "finished" });
  else if (candidate.lifecycleStatus === "discarded") terminal = endInventoryItem(current, { lifecycleStatus: "discarded", remainingPercentEstimate: candidate.remainingPercentEstimate });
  else throw new BeautioError("INVALID_INPUT", "end-use persistence requires a terminal inventory item");
  updateInventoryRow(database, terminal);
  const persisted = readInventoryItem(database, candidate.id);
  if (persisted === null) throw new BeautioError("INTERNAL_ERROR", "ended inventory item could not be re-read");
  return persisted;
}

/**
 * Changes only custom notes, including on terminal bottles.
 * @param database - Connection whose caller owns the synchronous write transaction.
 * @param input - Exact target and normalized nullable notes.
 * @returns Bottle readback before commit; missing targets fail without committed writes.
 */
export function updateInventoryItemCustomNotesInTransaction(database: DatabaseSync, input: InventoryItemCustomNotesPersistenceInput): InventoryItem {
  const result = database.prepare("UPDATE inventory_items SET custom_notes = ? WHERE id = ?").run(input.customNotes, input.inventoryItemId);
  if (result.changes !== 1) throw new BeautioError("INVENTORY_ITEM_NOT_FOUND", `inventory item ${input.inventoryItemId} does not exist`);
  const persisted = readInventoryItem(database, input.inventoryItemId);
  if (persisted === null) throw new BeautioError("INTERNAL_ERROR", "updated inventory item could not be re-read");
  return persisted;
}

function requireItem(database: DatabaseSync, id: string): InventoryItem {
  const item = readInventoryItem(database, id);
  if (item === null) throw new BeautioError("INVENTORY_ITEM_NOT_FOUND", `inventory item ${id} does not exist`);
  return item;
}

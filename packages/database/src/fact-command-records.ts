import {
  RevisionError, createSafeCommandResult,
  type FactCommandMutation, type FactCommandPersistenceResult,
} from "@beautio/application";
import { parseFactCommandSuccessResult, type FactCommandFailureCode, type FactCommandOperationId, type FactCommandSuccessResult } from "@beautio/contracts";
import { BeautioError, parseIsoDate } from "@beautio/domain";
import type { DatabaseSync } from "node:sqlite";
import { readEntityRevision, readRevisionClock, revisionStoreFailure } from "./entity-revision-state.ts";
import { endInventoryItemInTransaction, recordProductOpenedInTransaction, updateInventoryItemCustomNotesInTransaction } from "./inventory-lifecycle-records.ts";
import { correctInventoryItemFactsInTransaction, reviseProductProfileInTransaction } from "./revisioned-inventory-transactions.ts";

const rejectionCodes: Readonly<Record<FactCommandOperationId, readonly FactCommandFailureCode[]>> = {
  revise_product_profile: ["PRODUCT_NOT_FOUND", "REVISION_CONFLICT", "INVALID_INPUT"],
  correct_inventory_item_facts: ["INVENTORY_ITEM_NOT_FOUND", "REVISION_CONFLICT", "INVENTORY_ITEM_TERMINAL", "INVALID_INPUT"],
  set_inventory_item_custom_notes: ["INVENTORY_ITEM_NOT_FOUND"],
  record_product_opened: ["INVENTORY_ITEM_NOT_FOUND", "INVENTORY_ITEM_TERMINAL", "OPENED_ON_CONFLICT", "INVALID_INPUT"],
  end_inventory_item_use: ["INVENTORY_ITEM_NOT_FOUND", "INVENTORY_ITEM_TERMINAL", "INVALID_INPUT"],
};

/**
 * Executes one fact command and issues a rejection only after verified complete rollback.
 * @param database - Open connection outside any transaction; the command owner is already persisted.
 * @param command - One normalized supported mutation without command identity or arbitrary SQL.
 * @returns Minimal committed receipt or a whitelisted, rollback-proven business rejection.
 */
export function executeFactCommandRecord(database: DatabaseSync, command: FactCommandMutation): FactCommandPersistenceResult {
  try { database.exec("BEGIN IMMEDIATE"); } catch { throw revisionStoreFailure(); }
  let validatingResult = false;
  try {
    readRevisionClock(database, true);
    const candidate = executeMutation(database, command);
    validatingResult = true;
    const result = parseFactCommandSuccessResult(command.operationId, candidate);
    if (result === null) throw revisionStoreFailure();
    createSafeCommandResult(result);
    database.exec("COMMIT");
    return { outcome: "succeeded", result };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { throw revisionStoreFailure(); }
    if (!validatingResult && (error instanceof BeautioError || error instanceof RevisionError)) {
      const code = rejectionCodes[command.operationId].find((candidate) => candidate === error.code);
      if (code !== undefined) return { outcome: "known_failure", failureCode: code };
    }
    throw revisionStoreFailure();
  }
}

function executeMutation(database: DatabaseSync, command: FactCommandMutation): FactCommandSuccessResult {
  switch (command.operationId) {
    case "revise_product_profile": {
      const { expected_revision, ...patch } = command.input;
      const result = reviseProductProfileInTransaction(database, { productId: command.targetId, expectedRevision: expected_revision, patch });
      return { product_id: result.product.id, revision: result.revision, outcome: "updated" };
    }
    case "correct_inventory_item_facts": {
      const { expected_revision, ...patch } = command.input;
      const result = correctInventoryItemFactsInTransaction(database, { inventoryItemId: command.targetId, expectedRevision: expected_revision, patch });
      return { inventory_item_id: result.item.id, revision: result.revision, outcome: "updated" };
    }
    case "set_inventory_item_custom_notes": {
      const item = updateInventoryItemCustomNotesInTransaction(database, { inventoryItemId: command.targetId, customNotes: command.input.custom_notes });
      return { inventory_item_id: item.id, revision: readEntityRevision(database, "inventory_item", item.id), outcome: "updated" };
    }
    case "record_product_opened": {
      const result = recordProductOpenedInTransaction(database, {
        inventoryItemId: command.targetId, openedOn: parseIsoDate(command.input.opened_on, "opened_on"), openedOnAccuracy: command.input.opened_on_accuracy,
      });
      return { inventory_item_id: result.item.id, revision: readEntityRevision(database, "inventory_item", result.item.id), outcome: result.outcome };
    }
    case "end_inventory_item_use": {
      const remaining = command.input.lifecycle_status === "finished" ? 0 : command.input.remaining_percent_estimate;
      const item = endInventoryItemInTransaction(database, {
        id: command.targetId, lifecycleStatus: command.input.lifecycle_status,
        remainingPercentEstimate: remaining,
      });
      if (item.lifecycleStatus !== command.input.lifecycle_status || item.remainingPercentEstimate !== remaining) {
        throw revisionStoreFailure();
      }
      return { inventory_item_id: item.id, revision: readEntityRevision(database, "inventory_item", item.id), outcome: item.lifecycleStatus };
    }
  }
}

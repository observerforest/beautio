import {
  inventoryFactsPatchSchema, productProfilePatchSchema,
  type InventoryFactsPatch, type ProductProfilePatch,
} from "@beautio/contracts";
import {
  BeautioError, createInventoryItem, createProduct, updateInventoryItemPao,
  type InventoryItem, type Product,
} from "@beautio/domain";
import { parseInput } from "./input-parsing.ts";

/**
 * Merges a strict profile patch into the transaction's current Product.
 * @param existing - Product read after acquiring the database write transaction.
 * @param patch - Confirmed profile fields; missing values preserve existing facts.
 * @returns A domain-validated Product with image identity preserved.
 */
export function mergeProductProfilePatch(existing: Product, patch: ProductProfilePatch): Product {
  const input = parseInput(productProfilePatchSchema, patch);
  return createProduct({
    ...existing,
    name: input.name === undefined ? existing.name : input.name,
    alias: input.alias === undefined ? existing.alias : input.alias,
    brand: input.brand === undefined ? existing.brand : input.brand,
    category: input.category === undefined ? existing.category : input.category,
    sizeLabel: input.size_label === undefined ? existing.sizeLabel : input.size_label,
    paoDurationMonths: input.pao_duration_months === undefined ? existing.paoDurationMonths : input.pao_duration_months,
    ingredientListText: input.ingredient_list_text === undefined ? existing.ingredientListText : input.ingredient_list_text,
    sharedNotes: input.shared_notes === undefined ? existing.sharedNotes : input.shared_notes,
  });
}

/**
 * Corrects active bottle facts while retaining lifecycle, notes and identity.
 * @param existing - Bottle read inside the transaction, including legacy accuracy.
 * @param patch - Explicit corrections; a new date also requires explicit known accuracy.
 * @returns Validated bottle facts with deadlines recalculated by the domain.
 */
export function mergeInventoryFactsPatch(existing: InventoryItem, patch: InventoryFactsPatch): InventoryItem {
  const input = parseInput(inventoryFactsPatchSchema, patch);
  if (existing.lifecycleStatus === "finished" || existing.lifecycleStatus === "discarded") {
    throw new BeautioError("INVENTORY_ITEM_TERMINAL", "terminal inventory facts cannot be corrected");
  }
  const openedOn = input.opened_on === undefined ? existing.openedOn : input.opened_on;
  if (openedOn !== existing.openedOn && input.opened_on_accuracy !== "exact" && input.opened_on_accuracy !== "estimated") {
    throw new BeautioError("INVALID_INPUT", "a changed opening date requires explicit exact or estimated accuracy");
  }
  const accuracy = input.opened_on_accuracy === undefined ? existing.openedOnAccuracy : input.opened_on_accuracy;
  if (existing.lifecycleStatus === "opened" && accuracy === null) {
    throw new BeautioError("INVALID_INPUT", "opened inventory requires opening accuracy");
  }
  const merged = createInventoryItem({
    ...existing,
    openedOn,
    openedOnAccuracy: accuracy,
    expiresOn: input.expires_on === undefined ? existing.expiresOn : input.expires_on,
  });
  return updateInventoryItemPao(
    merged,
    input.pao_duration_months === undefined ? existing.paoDurationMonths : input.pao_duration_months,
  );
}

import type {
  CustomGptCorrectInventoryItemFactsInput, CustomGptRecordProductOpenedInput,
  CustomGptReviseProductProfileInput, CustomGptSetInventoryItemCustomNotesInput,
  FactCommandFailureCode, FactCommandSuccessResult, EndInventoryItemInput,
} from "@beautio/contracts";

export type FactCommandMutation =
  | { readonly operationId: "revise_product_profile"; readonly targetId: string; readonly input: Omit<CustomGptReviseProductProfileInput, "command_id"> }
  | { readonly operationId: "correct_inventory_item_facts"; readonly targetId: string; readonly input: Omit<CustomGptCorrectInventoryItemFactsInput, "command_id"> }
  | { readonly operationId: "set_inventory_item_custom_notes"; readonly targetId: string; readonly input: Omit<CustomGptSetInventoryItemCustomNotesInput, "command_id"> }
  | { readonly operationId: "record_product_opened"; readonly targetId: string; readonly input: Omit<CustomGptRecordProductOpenedInput, "command_id"> }
  | { readonly operationId: "end_inventory_item_use"; readonly targetId: string; readonly input: EndInventoryItemInput };

export type FactCommandPersistenceResult =
  | { readonly outcome: "succeeded"; readonly result: FactCommandSuccessResult }
  | { readonly outcome: "known_failure"; readonly failureCode: FactCommandFailureCode };

export interface FactCommandRepository {
  /**
   * Executes one narrow fact mutation in a single synchronous business transaction.
   * @param command - Normalized operation, exact target and immutable business input.
   * @returns Committed minimal result or a rejection proven by successful full rollback.
   * Unknown failures, failed rollback and uncertain commits must throw, never return rejection.
   */
  executeFactCommand(command: FactCommandMutation): Promise<FactCommandPersistenceResult>;
}

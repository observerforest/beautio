import {
  customGptCommandStatusOutputSchema,
  customGptFetchInputSchema,
  customGptFetchOutputSchema,
  customGptSearchInputSchema,
  customGptSearchOutputSchema,
  getCommandStatusInputSchema,
  parseCustomGptCommandSuccessResult,
  type CustomGptCommandStatusOutput,
  type CustomGptFetchOutput,
  type CustomGptSearchOutput,
} from "@beautio/contracts";
import { BeautioError } from "@beautio/domain";
import type { CommandExecutionService } from "./command-execution-service.ts";
import { parseInput } from "./input-parsing.ts";
import type { InventoryApplicationService } from "./inventory-service.ts";
import type { RevisionedInventoryRepository } from "./revisioned-inventory-port.ts";
import { toVersionedInventoryOutput } from "./versioned-inventory-output.ts";

export class CustomGptReadService {
  readonly #application: Pick<InventoryApplicationService, "searchInventory">;
  readonly #repository: Pick<RevisionedInventoryRepository, "findVersionedInventoryItem">;
  readonly #commands: Pick<CommandExecutionService, "find">;

  /**
   * Composes authenticated read actions from dependencies with no write capabilities.
   *
   * @param application - Existing bounded search behavior with explicit scope support.
   * @param repository - One-snapshot versioned reads used for image comparisons.
   * @param commands - Read-only command lookup whose principal is fixed by the service.
   */
  constructor(
    application: Pick<InventoryApplicationService, "searchInventory">,
    repository: Pick<RevisionedInventoryRepository, "findVersionedInventoryItem">,
    commands: Pick<CommandExecutionService, "find">,
  ) {
    this.#application = application;
    this.#repository = repository;
    this.#commands = commands;
  }

  /**
   * Searches active inventory by default using the existing shared search rules.
   *
   * @param untrustedInput - Strict query, pagination, optional date and explicit scope.
   * @returns Validated compact summaries with filtered totals and the selected scope.
   */
  async searchInventory(untrustedInput: unknown): Promise<CustomGptSearchOutput> {
    const { scope, ...input } = parseInput(customGptSearchInputSchema, untrustedInput);
    const result = await this.#application.searchInventory(input, { scope });
    return customGptSearchOutputSchema.parse({ ...result, scope });
  }

  /**
   * Fetches safe versioned facts and compares a candidate image in the same snapshot.
   *
   * @param untrustedInput - Bottle ID, optional comparison date and optional candidate image ID.
   * @returns Public facts and a nullable match result without the current image identity.
   */
  async fetchInventoryItem(untrustedInput: unknown): Promise<CustomGptFetchOutput> {
    const input = parseInput(customGptFetchInputSchema, untrustedInput);
    const snapshot = await this.#repository.findVersionedInventoryItem(input.inventory_item_id);
    if (snapshot === null) {
      throw new BeautioError("INVENTORY_ITEM_NOT_FOUND", "inventory item does not exist");
    }
    return customGptFetchOutputSchema.parse({
      inventory_item: toVersionedInventoryOutput(snapshot, input.as_of),
      display_image_matches_expected: input.expected_image_asset_id === undefined
        ? null
        : snapshot.product?.product.imageAssetId === input.expected_image_asset_id,
    });
  }

  /**
   * Reads a command's stored status without claiming, repairing or replaying it.
   *
   * @param untrustedInput - Strict supported operation and canonical command UUID.
   * @returns Status and allowlisted command receipts; absence makes no claim about past effects.
   */
  async getCommandStatus(untrustedInput: unknown): Promise<CustomGptCommandStatusOutput> {
    const input = parseInput(getCommandStatusInputSchema, untrustedInput);
    const command = await this.#commands.find({ operationId: input.operation_id, commandId: input.command_id });
    return customGptCommandStatusOutputSchema.parse({
      operation_id: input.operation_id,
      command_id: input.command_id,
      status: command?.status ?? "not_found",
      created_at: command?.createdAt ?? null,
      completed_at: command?.completedAt ?? null,
      failure_code: command?.status === "failed" ? command.failure?.code ?? null : null,
      result: command?.status === "succeeded" ? parseCustomGptCommandSuccessResult(input.operation_id, command.result) : null,
    });
  }
}

import {
  customGptFactCommandOutputSchema, parseFactCommandSuccessResult,
  type CustomGptFactCommandOutput, type FactCommandFailureCode, type FactCommandOperationId,
} from "@beautio/contracts";
import { BeautioError } from "@beautio/domain";
import type { CommandExecutionService } from "./command-execution-service.ts";
import { CommandExecutionError } from "./command-execution-types.ts";
import type { FactCommandRepository } from "./fact-command-port.ts";
import { prepareFactCommandValue, type PreparedFactCommandValue } from "./fact-command-preparation.ts";

declare const preparedFactCommandBrand: unique symbol;
export interface PreparedFactCommand { readonly [preparedFactCommandBrand]: true }

const failureMessages: Readonly<Record<FactCommandFailureCode, string>> = {
  PRODUCT_NOT_FOUND: "The Product does not exist.",
  INVENTORY_ITEM_NOT_FOUND: "The inventory item does not exist.",
  REVISION_CONFLICT: "The entity changed after the confirmed revision.",
  INVENTORY_ITEM_TERMINAL: "The inventory item is already terminal.",
  OPENED_ON_CONFLICT: "The inventory item has different opening facts.",
  INVALID_INPUT: "The confirmed facts are not valid for the current inventory state.",
};

export class CustomGptFactWriteService {
  readonly #repository: FactCommandRepository;
  readonly #commands: Pick<CommandExecutionService, "execute">;
  readonly #prepared = new WeakMap<PreparedFactCommand, PreparedFactCommandValue>();

  /**
   * Composes confirmed fact writes with durable command ownership and replay.
   * @param repository - Narrow transaction boundary that proves any returned rejection.
   * @param commands - Durable executor; callers must hold the HTTP exclusive gate during execution.
   */
  constructor(repository: FactCommandRepository, commands: Pick<CommandExecutionService, "execute">) {
    this.#repository = repository;
    this.#commands = commands;
  }

  /**
   * Validates and freezes a command before entering the exclusive write gate.
   * @param operationId - Operation selected by the authenticated fixed route.
   * @param targetId - Separately validated path target, included in the payload hash.
   * @param input - Unknown JSON body including its canonical command UUID.
   * @returns An opaque, same-instance, single-use handle with no persistence side effects.
   */
  prepare(operationId: FactCommandOperationId, targetId: string, input: unknown): PreparedFactCommand {
    const value = prepareFactCommandValue(operationId, targetId, input);
    const handle = Object.freeze({}) as PreparedFactCommand;
    this.#prepared.set(handle, value);
    return handle;
  }

  /**
   * Claims, attempts and settles a prepared command once while the caller holds the gate.
   * @param prepared - Unconsumed handle from this instance; no request cancellation is passed to effects.
   * @returns Strict minimal status; unknown effect or settlement failures throw without retrying.
   */
  async executePrepared(prepared: PreparedFactCommand): Promise<CustomGptFactCommandOutput> {
    const value = this.#prepared.get(prepared);
    if (value === undefined) throw new BeautioError("INVALID_INPUT", "prepared fact command is unavailable");
    this.#prepared.delete(prepared);
    let effectStarted = false;
    const execution = await this.#commands.execute({
      operationId: value.mutation.operationId, commandId: value.commandId, payload: value.payload,
    }, async () => {
      effectStarted = true;
      // A thrown business error has no rollback receipt and is deliberately unknown.
      const result = await this.#repository.executeFactCommand(value.mutation);
      if (result.outcome === "known_failure") {
        return { outcome: "known_failure", failure: { code: result.failureCode, message: failureMessages[result.failureCode] } };
      }
      return { outcome: "succeeded", result: requireMatchingResult(value, result.result) };
    }).catch((error: unknown) => {
      if (!effectStarted && error instanceof CommandExecutionError &&
        (error.code === "COMMAND_PAYLOAD_CONFLICT" || error.code === "COMMAND_STORE_BUSY")) throw error;
      throw new CommandExecutionError("COMMAND_STORE_FAILURE", "command outcome is unknown; inspect status and inventory before any new confirmation");
    });
    const record = execution.execution;
    const result = record.status === "succeeded" ? requireMatchingResult(value, record.result) : null;
    return customGptFactCommandOutputSchema.parse({
      operation_id: value.mutation.operationId, command_id: value.commandId, status: record.status,
      created_at: record.createdAt, completed_at: record.completedAt,
      failure_code: record.status === "failed" ? record.failure?.code ?? null : null, result,
    });
  }
}

function requireMatchingResult(value: PreparedFactCommandValue, result: unknown) {
  const parsed = parseFactCommandSuccessResult(value.mutation.operationId, result);
  const target = parsed === null ? null : "product_id" in parsed ? parsed.product_id : parsed.inventory_item_id;
  if (parsed === null || target !== value.mutation.targetId) {
    throw new CommandExecutionError("COMMAND_STORE_FAILURE", "stored fact command result is unavailable");
  }
  return parsed;
}

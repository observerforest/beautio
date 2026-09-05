import {
  canonicalUuidSchema, createCommandFailureCodeSchema, createCommandSuccessResultSchema, customGptCreateCommandOutputSchema,
  type CreateCommandFailureCode, type CustomGptCreateCommandOutput,
} from "@beautio/contracts";
import { BeautioError, parseNullableIsoInstant, type IsoInstant } from "@beautio/domain";
import { randomUUID } from "node:crypto";
import { createKnownCommandFailure } from "./canonical-json.ts";
import type { CommandExecutionService } from "./command-execution-service.ts";
import { CommandExecutionError, type CommandExecutionView } from "./command-execution-types.ts";
import type { CreateCommandRepository } from "./create-command-port.ts";
import { prepareCreateCommandValue, type PreparedCreateCommandValue } from "./create-command-preparation.ts";

declare const preparedCreateCommandBrand: unique symbol;
export interface PreparedCreateCommand { readonly [preparedCreateCommandBrand]: true }
export interface CustomGptCreateCommandServiceOptions {
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

const failureMessages: Readonly<Record<CreateCommandFailureCode, string>> = {
  PRODUCT_NOT_FOUND: "A referenced Product does not exist.",
  INVALID_INPUT: "The confirmed batch is not valid for the current Product facts.",
  IMAGE_ASSET_NOT_FOUND: "A referenced image is unavailable.",
  IMAGE_ASSET_EXPIRED: "A referenced image has expired.",
  BATCH_CONFLICT: "A referenced image cannot be associated with this batch.",
};

export class CustomGptCreateCommandService {
  readonly #repository: CreateCommandRepository;
  readonly #commands: Pick<CommandExecutionService, "claim" | "completeKnownFailure">;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #prepared = new WeakMap<PreparedCreateCommand, PreparedCreateCommandValue>();

  /**
   * Composes durable ownership with an atomic batch-and-success persistence boundary.
   * @param repository - Narrow port that commits business rows and their receipt together.
   * @param commands - Existing claim and rollback-proven failure settlement operations.
   * @param options - Trusted synchronous clock and UUID generator; neither is invoked by prepare.
   */
  constructor(repository: CreateCommandRepository, commands: Pick<CommandExecutionService, "claim" | "completeKnownFailure">, options: CustomGptCreateCommandServiceOptions = {}) {
    this.#repository = repository;
    this.#commands = commands;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  /**
   * Prepares a strictly validated create request before acquiring the exclusive gate.
   * @param input - Unknown JSON body including command_id and the unchanged batch fields.
   * @returns A same-instance, single-use handle with no reads, claims or generated IDs.
   */
  prepare(input: unknown): PreparedCreateCommand {
    const value = prepareCreateCommandValue(input);
    const handle = Object.freeze({}) as PreparedCreateCommand;
    this.#prepared.set(handle, value);
    return handle;
  }

  /**
   * Claims once and atomically creates rows plus their success receipt inside the caller's gate.
   * @param prepared - Unconsumed handle; request cancellation must not interrupt an owned effect.
   * @returns Minimal command state; unknown failures never retry, regenerate IDs or settle failed.
   */
  async executePrepared(prepared: PreparedCreateCommand): Promise<CustomGptCreateCommandOutput> {
    const value = this.#prepared.get(prepared);
    if (value === undefined) throw new BeautioError("INVALID_INPUT", "prepared create command is unavailable");
    this.#prepared.delete(prepared);
    let claim;
    try {
      claim = await this.#commands.claim({ operationId: "create_inventory_batch", commandId: value.commandId, payload: value.payload });
    } catch (error) {
      if (error instanceof CommandExecutionError && (error.code === "COMMAND_PAYLOAD_CONFLICT" || error.code === "COMMAND_STORE_BUSY")) throw error;
      throw unknownCreateOutcome();
    }
    try {
      if (claim.outcome !== "claimed") return toOutput(value, claim.execution);
      const now = this.currentTimestamp();
      const generated = new Set<string>();
      const generate = () => {
        const id = canonicalUuidSchema.parse(this.#idGenerator());
        if (generated.has(id)) throw unknownCreateOutcome();
        generated.add(id);
        return id;
      };
      const productIds = value.input.products.map(generate);
      const inventoryItemIds = value.input.inventory_items.map(generate);
      const result = await this.#repository.executeCreateCommand({
        claim: claim.claim, input: value.input, productIds, inventoryItemIds, now,
        completionClock: () => this.currentTimestamp(),
      });
      if (result.outcome === "known_failure") {
        const code = createCommandFailureCodeSchema.parse(result.failureCode);
        const execution = await this.#commands.completeKnownFailure(claim.claim, createKnownCommandFailure({ code, message: failureMessages[code] }));
        return toOutput(value, execution);
      }
      const { key, payloadSha256, ...state } = result.record;
      if (key.principal !== claim.claim.key.principal || key.operationId !== "create_inventory_batch" ||
        key.commandId !== value.commandId || payloadSha256 !== value.payload.sha256) throw unknownCreateOutcome();
      const receipt = createCommandSuccessResultSchema.parse(state.result);
      if (receipt.inventory_item_ids.some((id, index) => id !== inventoryItemIds[index]) || receipt.inventory_item_ids.length !== inventoryItemIds.length) throw unknownCreateOutcome();
      return toOutput(value, { ...state, operationId: key.operationId, commandId: key.commandId });
    } catch { throw unknownCreateOutcome(); }
  }

  private currentTimestamp(): IsoInstant {
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw unknownCreateOutcome();
    const timestamp = parseNullableIsoInstant(now.toISOString(), "command timestamp");
    if (timestamp === null) throw unknownCreateOutcome();
    return timestamp;
  }
}

function toOutput(value: PreparedCreateCommandValue, record: CommandExecutionView): CustomGptCreateCommandOutput {
  if (record.operationId !== "create_inventory_batch" || record.commandId !== value.commandId) throw unknownCreateOutcome();
  const result = record.status === "succeeded" ? createCommandSuccessResultSchema.parse(record.result) : null;
  if (result !== null && result.inventory_item_ids.length !== value.input.inventory_items.length) throw unknownCreateOutcome();
  return customGptCreateCommandOutputSchema.parse({
    operation_id: "create_inventory_batch", command_id: value.commandId, status: record.status,
    created_at: record.createdAt, completed_at: record.completedAt,
    failure_code: record.status === "failed" ? record.failure?.code ?? null : null, result,
  });
}

function unknownCreateOutcome(): CommandExecutionError {
  return new CommandExecutionError("COMMAND_STORE_FAILURE", "command outcome is unknown; inspect status and inventory before any new confirmation");
}

import {
  commandIdSchema,
  consequentialCommandOperationIdSchema,
  type ConsequentialCommandOperationId,
} from "@beautio/contracts";
import { parseNullableIsoInstant, type IsoInstant } from "@beautio/domain";
import {
  createKnownCommandFailure,
  createSafeCommandResult,
} from "./canonical-json.ts";
import type { CommandExecutionRepository } from "./command-execution-port.ts";
import {
  CommandExecutionError,
  type CanonicalCommandPayload,
  type CommandExecutionKey,
  type CommandExecutionRecord,
  type CommandExecutionView,
  type CommandPayloadSha256,
  type KnownCommandFailure,
  type SafeCommandResult,
} from "./command-execution-types.ts";

const CUSTOM_GPT_PRINCIPAL = "custom_gpt" as const;
declare const claimedCommandExecutionBrand: unique symbol;

export interface ClaimCommandExecutionInput {
  readonly operationId: ConsequentialCommandOperationId;
  readonly commandId: unknown;
  readonly payload: CanonicalCommandPayload;
}

export interface FindCommandExecutionInput {
  readonly operationId: ConsequentialCommandOperationId;
  readonly commandId: unknown;
}

export interface ClaimedCommandExecution {
  readonly key: CommandExecutionKey;
  readonly payloadSha256: CommandPayloadSha256;
  readonly [claimedCommandExecutionBrand]: true;
}

export type ClaimCommandExecutionResult =
  | { readonly outcome: "claimed"; readonly claim: ClaimedCommandExecution }
  | { readonly outcome: "in_progress"; readonly execution: CommandExecutionView }
  | { readonly outcome: "succeeded"; readonly execution: CommandExecutionView }
  | { readonly outcome: "failed"; readonly execution: CommandExecutionView };

export type CommandEffectResult =
  | { readonly outcome: "succeeded"; readonly result: unknown }
  | { readonly outcome: "known_failure"; readonly failure: unknown };

export type ExecuteCommandResult = Exclude<
  ClaimCommandExecutionResult,
  { readonly outcome: "claimed" }
>;

export class CommandExecutionService {
  readonly #repository: CommandExecutionRepository;
  readonly #clock: () => Date;

  /**
   * Creates the application state machine for authenticated Custom GPT commands.
   *
   * @param repository - Persistence port providing atomic claim and terminal CAS.
   * @param clock - Injectable wall clock used only for durable audit timestamps.
   */
  constructor(
    repository: CommandExecutionRepository,
    clock: () => Date = () => new Date(),
  ) {
    this.#repository = repository;
    this.#clock = clock;
  }

  /**
   * Claims a normalized command before any business side effect may begin.
   *
   * @param input - Server-selected operation, canonical UUID, and opaque payload hash.
   * @returns Execution ownership or an authoritative replay state.
   */
  async claim(
    input: ClaimCommandExecutionInput,
  ): Promise<ClaimCommandExecutionResult> {
    const key = createCommandExecutionKey(input.operationId, input.commandId);
    const persisted = await this.#repository.claimCommandExecution({
      key,
      payloadSha256: input.payload.sha256,
      createdAt: this.currentTimestamp(),
    });
    this.assertMatchingPayload(persisted.record, input.payload.sha256);

    if (persisted.inserted) {
      if (persisted.record.status !== "in_progress") {
        throw storeFailure("new command claim is not in progress");
      }
      return {
        outcome: "claimed",
        claim: Object.freeze({
          key,
          payloadSha256: input.payload.sha256,
        }) as ClaimedCommandExecution,
      };
    }
    return replayResult(persisted.record);
  }

  /**
   * Executes an effect only for a newly persisted claim and replays every other state.
   *
   * Thrown or otherwise unknown failures deliberately escape without settling the
   * record, leaving `in_progress` for later status lookup and business readback.
   * A `known_failure` result is valid only when the caller has proven zero committed
   * side effects or a complete transaction rollback.
   *
   * @param input - Server-selected operation, command UUID, and canonical payload.
   * @param effect - Single attempt returning a bounded success or proven safe failure.
   * @returns A terminal result or replayed in-progress/terminal state.
   */
  async execute(
    input: ClaimCommandExecutionInput,
    effect: () => Promise<CommandEffectResult>,
  ): Promise<ExecuteCommandResult> {
    const claimed = await this.claim(input);
    if (claimed.outcome !== "claimed") {
      return claimed;
    }

    const effectResult = await effect();
    if (effectResult.outcome === "succeeded") {
      return {
        outcome: "succeeded",
        execution: await this.completeSuccess(
          claimed.claim,
          createSafeCommandResult(effectResult.result),
        ),
      };
    }
    return {
      outcome: "failed",
      execution: await this.completeKnownFailure(
        claimed.claim,
        createKnownCommandFailure(effectResult.failure),
      ),
    };
  }

  /**
   * Settles one owned in-progress command exactly once as succeeded.
   *
   * @param claim - Unforgeable claim returned for the first matching request.
   * @param result - Bounded result produced after the business write succeeds.
   * @returns The authoritative succeeded view.
   */
  async completeSuccess(
    claim: ClaimedCommandExecution,
    result: SafeCommandResult,
  ): Promise<CommandExecutionView> {
    const validatedResult = createSafeCommandResult(result.value);
    const persisted = await this.#repository.completeCommandExecutionSuccess({
      key: claim.key,
      payloadSha256: claim.payloadSha256,
      result: validatedResult,
      completedAt: this.currentTimestamp(),
    });
    return this.requireCompletedRecord(persisted, claim, "succeeded");
  }

  /**
   * Settles one owned in-progress command exactly once as a known safe failure.
   *
   * @param claim - Unforgeable claim returned for the first matching request.
   * @param failure - Bounded failure proven to have no committed side effect.
   * @returns The authoritative failed view.
   */
  async completeKnownFailure(
    claim: ClaimedCommandExecution,
    failure: KnownCommandFailure,
  ): Promise<CommandExecutionView> {
    const validatedFailure = createKnownCommandFailure(failure);
    const persisted =
      await this.#repository.completeCommandExecutionKnownFailure({
        key: claim.key,
        payloadSha256: claim.payloadSha256,
        failure: validatedFailure,
        completedAt: this.currentTimestamp(),
      });
    return this.requireCompletedRecord(persisted, claim, "failed");
  }

  /**
   * Finds one command using the authenticated principal plus operation and UUID.
   *
   * @param input - Server-selected operation and canonical command UUID.
   * @returns A safe status view or null when the full three-part key is absent.
   */
  async find(
    input: FindCommandExecutionInput,
  ): Promise<CommandExecutionView | null> {
    const record = await this.#repository.findCommandExecution(
      createCommandExecutionKey(input.operationId, input.commandId),
    );
    return record === null ? null : toCommandExecutionView(record);
  }

  private requireCompletedRecord(
    persisted: {
      readonly updated: boolean;
      readonly record: CommandExecutionRecord | null;
    },
    claim: ClaimedCommandExecution,
    expectedStatus: "succeeded" | "failed",
  ): CommandExecutionView {
    if (persisted.record === null) {
      throw new CommandExecutionError(
        "COMMAND_STATE_CONFLICT",
        "command claim no longer exists",
      );
    }
    this.assertMatchingPayload(persisted.record, claim.payloadSha256);
    if (!persisted.updated || persisted.record.status !== expectedStatus) {
      throw new CommandExecutionError(
        "COMMAND_STATE_CONFLICT",
        "command is no longer eligible for completion",
      );
    }
    return toCommandExecutionView(persisted.record);
  }

  private assertMatchingPayload(
    record: CommandExecutionRecord,
    expectedHash: CommandPayloadSha256,
  ): void {
    if (record.payloadSha256 !== expectedHash) {
      throw new CommandExecutionError(
        "COMMAND_PAYLOAD_CONFLICT",
        "command_id was already used with a different normalized payload",
      );
    }
  }

  private currentTimestamp(): IsoInstant {
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw storeFailure("command clock returned an invalid date");
    }
    const timestamp = now.toISOString();
    const parsed = parseNullableIsoInstant(timestamp, "command timestamp");
    if (parsed === null) {
      throw storeFailure("command clock returned an invalid date");
    }
    return parsed;
  }
}

function createCommandExecutionKey(
  operationId: ConsequentialCommandOperationId,
  commandId: unknown,
): CommandExecutionKey {
  const operation = consequentialCommandOperationIdSchema.safeParse(operationId);
  const command = commandIdSchema.safeParse(commandId);
  if (!operation.success || !command.success) {
    throw new CommandExecutionError(
      "COMMAND_INPUT_INVALID",
      "operation_id and command_id must identify a supported command",
    );
  }
  return Object.freeze({
    principal: CUSTOM_GPT_PRINCIPAL,
    operationId: operation.data,
    commandId: command.data,
  });
}

function replayResult(
  record: CommandExecutionRecord,
): Exclude<ClaimCommandExecutionResult, { readonly outcome: "claimed" }> {
  return {
    outcome: record.status,
    execution: toCommandExecutionView(record),
  };
}

function toCommandExecutionView(
  record: CommandExecutionRecord,
): CommandExecutionView {
  const { key, payloadSha256: _payloadSha256, ...state } = record;
  return Object.freeze({
    ...state,
    operationId: key.operationId,
    commandId: key.commandId,
  }) as CommandExecutionView;
}

function storeFailure(message: string): CommandExecutionError {
  return new CommandExecutionError("COMMAND_STORE_FAILURE", message);
}

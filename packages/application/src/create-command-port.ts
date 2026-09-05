import type { CreateCommandFailureCode, CreateInventoryBatchInput } from "@beautio/contracts";
import type { IsoInstant } from "@beautio/domain";
import type { ClaimedCommandExecution } from "./command-execution-service.ts";
import type { SucceededCommandExecutionRecord } from "./command-execution-types.ts";

export interface CreateCommandPersistenceInput {
  readonly claim: ClaimedCommandExecution;
  readonly input: CreateInventoryBatchInput;
  readonly productIds: readonly string[];
  readonly inventoryItemIds: readonly string[];
  readonly now: IsoInstant;
  readonly completionClock: () => IsoInstant;
}

export type CreateCommandPersistenceResult =
  | { readonly outcome: "succeeded"; readonly record: SucceededCommandExecutionRecord }
  | { readonly outcome: "known_failure"; readonly failureCode: CreateCommandFailureCode };

export interface CreateCommandRepository {
  /**
   * Atomically creates a confirmed batch and its bounded succeeded command record.
   * @param input - Owned claim and generated identities; the completion clock is synchronous and does no I/O.
   * @returns A committed success or a business-preflight rejection proven by complete rollback.
   */
  executeCreateCommand(input: CreateCommandPersistenceInput): Promise<CreateCommandPersistenceResult>;
}

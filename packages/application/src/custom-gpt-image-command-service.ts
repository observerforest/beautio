import type { CustomGptSetDisplayImageCommandOutput, CustomGptUploadImagesCommandOutput, ImageCommandFailureCode } from "@beautio/contracts";
import { BeautioError, parseNullableIsoInstant, type IsoInstant } from "@beautio/domain";
import { randomUUID } from "node:crypto";
import { createKnownCommandFailure } from "./canonical-json.ts";
import type { ClaimedCommandExecution, CommandExecutionService } from "./command-execution-service.ts";
import { CommandExecutionError } from "./command-execution-types.ts";
import type { ActionImageLoader, ImageCommandPreparation, ImageCommandRepository, ImageCommandStorage } from "./image-command-port.ts";
import { imageCommandFailureMessages, imageCommandRecordView, toImageUploadCommandOutput, toSetDisplayImageCommandOutput, unknownImageCommandOutcome } from "./image-command-output.ts";
import { prepareImageUploadCommandValue, prepareSetDisplayImageCommandValue, type ImageUploadCommandValue, type SetDisplayImageCommandValue } from "./image-command-preparation.ts";
import { persistImageUploadCommand } from "./image-upload-command-persistence.ts";
import { assertUploadNotAborted } from "./input-parsing.ts";
import type { ImageUploadOperationOptions } from "./inventory-service-types.ts";
import type { PreparedProductImageUpload } from "./prepared-product-image-upload.ts";

declare const uploadBrand: unique symbol;
declare const ownershipBrand: unique symbol;
declare const executionBrand: unique symbol;
declare const displayBrand: unique symbol;
export interface PreparedImageUploadCommand { readonly [uploadBrand]: true }
export interface OwnedImageUploadCommand { readonly [ownershipBrand]: true }
export interface PreparedImageUploadExecution { readonly [executionBrand]: true }
export interface PreparedSetDisplayImageCommand { readonly [displayBrand]: true }
export type ImageUploadClaimResult =
  | { readonly outcome: "replayed"; readonly output: CustomGptUploadImagesCommandOutput }
  | { readonly outcome: "owned"; readonly ownership: OwnedImageUploadCommand };
export interface CustomGptImageCommandServiceOptions { readonly clock?: () => Date; readonly idGenerator?: () => string }
interface OwnedUpload { readonly value: ImageUploadCommandValue; readonly claim: ClaimedCommandExecution }
type UploadExecution = OwnedUpload & ({ readonly prepared: PreparedProductImageUpload; readonly failureCode?: never } | { readonly prepared?: never; readonly failureCode: ImageCommandFailureCode });

export class CustomGptImageCommandService {
  readonly #repository: ImageCommandRepository;
  readonly #commands: Pick<CommandExecutionService, "claim" | "completeKnownFailure">;
  readonly #preparation: ImageCommandPreparation;
  readonly #storage: ImageCommandStorage;
  readonly #clock: () => Date;
  readonly #generateId: () => string;
  readonly #uploads = new WeakMap<PreparedImageUploadCommand, ImageUploadCommandValue>();
  readonly #owners = new WeakMap<OwnedImageUploadCommand, OwnedUpload>();
  readonly #executions = new WeakMap<PreparedImageUploadExecution, UploadExecution>();
  readonly #ownedExecutions = new WeakSet<PreparedImageUploadExecution>();
  readonly #display = new WeakMap<PreparedSetDisplayImageCommand, SetDisplayImageCommandValue>();

  /**
   * Composes narrow image command ownership, shared preparation and owned file persistence.
   * @param repository - Atomic metadata/receipt and display-image transactions.
   * @param commands - Existing durable claim and proven failure settlement service.
   * @param preparation - The same preparation coordinator used by legacy uploads.
   * @param storage - Create-only owned file storage, never a path supplied by a caller.
   * @param options - Trusted synchronous clock and UUID generator.
   */
  constructor(repository: ImageCommandRepository, commands: Pick<CommandExecutionService, "claim" | "completeKnownFailure">, preparation: ImageCommandPreparation, storage: ImageCommandStorage, options: CustomGptImageCommandServiceOptions = {}) {
    this.#repository = repository; this.#commands = commands; this.#preparation = preparation; this.#storage = storage;
    this.#clock = options.clock ?? (() => new Date()); this.#generateId = options.idGenerator ?? randomUUID;
  }
  /** @param input - Unknown upload body. @returns Same-instance pure prepared command with no I/O. */
  prepareUpload(input: unknown): PreparedImageUploadCommand {
    const value = prepareImageUploadCommandValue(input);
    const handle = Object.freeze({}) as PreparedImageUploadCommand;
    this.#uploads.set(handle, value); return handle;
  }
  /** @param prepared - Single-use pure handle. @returns Replay or ownership; caller must hold the short exclusive gate. */
  async claimPreparedUpload(prepared: PreparedImageUploadCommand): Promise<ImageUploadClaimResult> {
    const value = this.#uploads.get(prepared);
    if (value === undefined) throw invalidHandle();
    this.#uploads.delete(prepared);
    const result = await this.claim("upload_product_images", value);
    if (result.outcome !== "claimed") {
      try {
        const output = toImageUploadCommandOutput(result.execution, value.commandId);
        if (output.status === "succeeded" && output.result.image_asset_ids.length !== value.references.length) throw unknownImageCommandOutcome();
        return { outcome: "replayed", output };
      } catch { throw unknownImageCommandOutcome(); }
    }
    const ownership = Object.freeze({}) as OwnedImageUploadCommand;
    this.#owners.set(ownership, { value, claim: result.claim });
    return { outcome: "owned", ownership };
  }
  /** @param ownership - Single-use owned claim. @param loader - Lazy bounded read-only downloader. @param options - Preparation cancellation only. @returns Shared semantic capability or a proven pure rejection, outside the exclusive gate. */
  async prepareOwnedUpload(ownership: OwnedImageUploadCommand, loader: ActionImageLoader, options: ImageUploadOperationOptions = {}): Promise<PreparedImageUploadExecution> {
    const owner = this.#owners.get(ownership);
    if (owner === undefined) throw invalidHandle();
    this.#owners.delete(ownership);
    let execution: UploadExecution;
    let prepared: PreparedProductImageUpload | undefined;
    try {
      assertUploadNotAborted(options.signal);
      const images = await loader(owner.value.references, options.signal);
      assertUploadNotAborted(options.signal);
      if (!Array.isArray(images) || images.length !== owner.value.references.length || images.some((image, index) => image.source_ref !== owner.value.references[index]!.id)) throw new BeautioError("INVALID_INPUT", "downloaded file identities do not match the confirmed order");
      prepared = await this.#preparation.prepareProductImages(images, options);
      assertUploadNotAborted(options.signal);
      execution = { ...owner, prepared };
    } catch (error) {
      if (prepared !== undefined) this.#preparation.discardPreparedProductImages(prepared);
      if (options.signal?.aborted !== true && error instanceof BeautioError &&
        (error.code === "INVALID_INPUT" || error.code === "UPLOAD_TOO_LARGE" || error.code === "UNSUPPORTED_MEDIA_TYPE")) {
        execution = { ...owner, failureCode: error.code };
      } else throw unknownImageCommandOutcome();
    }
    const handle = Object.freeze({}) as PreparedImageUploadExecution;
    this.#executions.set(handle, execution); this.#ownedExecutions.add(handle); return handle;
  }
  /** @param prepared - Ready or pure-rejection handle. @returns Strict durable state after the caller's final exclusive gate settles. */
  async executePreparedUpload(prepared: PreparedImageUploadExecution): Promise<CustomGptUploadImagesCommandOutput> {
    const execution = this.#executions.get(prepared);
    if (execution === undefined) throw invalidHandle();
    this.#executions.delete(prepared);
    try {
      if (execution.failureCode !== undefined) return toImageUploadCommandOutput(await this.settleFailure(execution.claim, execution.failureCode), execution.value.commandId);
      const consumed = this.#preparation.consumePreparedProductImages(execution.prepared);
      try {
        const now = this.timestamp();
        const result = await persistImageUploadCommand({ repository: this.#repository, storage: this.#storage,
          claim: execution.claim, consumed, now, expiresAt: this.expiry(now), generateId: this.#generateId, completionClock: () => this.timestamp() });
        return toImageUploadCommandOutput(result, execution.value.commandId);
      } finally { consumed.release(); }
    } catch { throw unknownImageCommandOutcome(); }
  }
  /** @param prepared - Same-instance execution handle. @returns Nothing after releasing an unconsumed preparation; repeated discard is safe. */
  discardPreparedUpload(prepared: PreparedImageUploadExecution): void {
    if (!this.#ownedExecutions.has(prepared)) throw invalidHandle();
    const execution = this.#executions.get(prepared);
    this.#executions.delete(prepared);
    if (execution?.prepared !== undefined) this.#preparation.discardPreparedProductImages(execution.prepared);
  }
  /** @param productId - Separate route target. @param input - Unknown body. @returns Single-use pure display-image command. */
  prepareSetDisplayImage(productId: string, input: unknown): PreparedSetDisplayImageCommand {
    const value = prepareSetDisplayImageCommandValue(productId, input);
    const handle = Object.freeze({}) as PreparedSetDisplayImageCommand;
    this.#display.set(handle, value); return handle;
  }
  /** @param prepared - Pure handle. @returns Atomic display-image and receipt outcome under the caller's exclusive gate. */
  async executePreparedSetDisplayImage(prepared: PreparedSetDisplayImageCommand): Promise<CustomGptSetDisplayImageCommandOutput> {
    const value = this.#display.get(prepared);
    if (value === undefined) throw invalidHandle();
    this.#display.delete(prepared);
    const result = await this.claim("set_product_display_image", value);
    try {
      if (result.outcome !== "claimed") return toSetDisplayImageCommandOutput(result.execution, value.commandId);
      const now = this.timestamp();
      const persisted = await this.#repository.executeSetDisplayImageCommand({ claim: result.claim, productId: value.productId,
        input: value.input, now, unlinkedExpiresAt: this.expiry(now), completionClock: () => this.timestamp() });
      const view = persisted.outcome === "known_failure" ? await this.settleFailure(result.claim, persisted.failureCode) : imageCommandRecordView(persisted.record, result.claim);
      const output = toSetDisplayImageCommandOutput(view, value.commandId);
      if (output.status === "succeeded" && output.result.product_id !== value.productId) throw unknownImageCommandOutcome();
      return output;
    } catch { throw unknownImageCommandOutcome(); }
  }
  private async claim(operationId: "upload_product_images" | "set_product_display_image", value: ImageUploadCommandValue | SetDisplayImageCommandValue) {
    try { return await this.#commands.claim({ operationId, commandId: value.commandId, payload: value.payload }); }
    catch (error) {
      if (error instanceof CommandExecutionError && (error.code === "COMMAND_PAYLOAD_CONFLICT" || error.code === "COMMAND_STORE_BUSY")) throw error;
      throw unknownImageCommandOutcome();
    }
  }
  private settleFailure(claim: ClaimedCommandExecution, code: ImageCommandFailureCode) {
    return this.#commands.completeKnownFailure(claim, createKnownCommandFailure({ code, message: imageCommandFailureMessages[code] }));
  }
  private timestamp(): IsoInstant {
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw unknownImageCommandOutcome();
    const result = parseNullableIsoInstant(now.toISOString(), "image command timestamp");
    if (result === null) throw unknownImageCommandOutcome(); return result;
  }
  private expiry(now: IsoInstant): IsoInstant {
    const result = parseNullableIsoInstant(new Date(Date.parse(now) + 86_400_000).toISOString(), "image expiry");
    if (result === null) throw unknownImageCommandOutcome(); return result;
  }
}
function invalidHandle(): BeautioError { return new BeautioError("INVALID_INPUT", "prepared image command is unavailable"); }

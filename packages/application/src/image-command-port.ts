import type { ActionImageFileReference, CustomGptSetDisplayImageCommandInput, ImageCommandFailureCode } from "@beautio/contracts";
import type { ImageAsset, IsoInstant } from "@beautio/domain";
import type { ClaimedCommandExecution } from "./command-execution-service.ts";
import type { SucceededCommandExecutionRecord } from "./command-execution-types.ts";
import type { ImageUploadInput, ImageUploadOperationOptions } from "./inventory-service-types.ts";
import type { ConsumedProductImageUpload, PreparedProductImageUpload } from "./prepared-product-image-upload.ts";

export type ActionImageLoader = (references: readonly ActionImageFileReference[], signal?: AbortSignal) => Promise<readonly ImageUploadInput[]>;
/** Runtime-validated, instance-owned storage capability; its visible tag conveys no authority. */
export interface ReservedImageObject { readonly kind: "reserved_image_object" }
export interface ImageCommandStorage {
  /** @param storageKey - Server-generated opaque key. @returns An exclusively created empty object capability. */
  reserve(storageKey: string): Promise<ReservedImageObject>;
  /** @param reservation - Owned live object. @param bytes - Owned validated bytes. @returns Completion after durable writing. */
  writeReserved(reservation: ReservedImageObject, bytes: Uint8Array): Promise<void>;
  /** @param reservation - Owned object. @param expectedBytes - Complete expected content. @returns Completion only when identity and bytes match. */
  verifyReserved(reservation: ReservedImageObject, expectedBytes: Uint8Array): Promise<void>;
  /** @param reservation - Owned object. @returns Completion after deleting only its matching identity. */
  discardReserved(reservation: ReservedImageObject): Promise<void>;
  /** @param reservation - Owned object. @returns Completion after closing and retiring the capability, without deleting bytes. */
  releaseReserved(reservation: ReservedImageObject): Promise<void>;
}
export interface ImageCommandPreparation {
  /** @param input - Complete candidates. @param options - Real preparation cancellation. @returns Shared bounded semantic capability. */
  prepareProductImages(input: unknown, options?: ImageUploadOperationOptions): Promise<PreparedProductImageUpload>;
  /** @param prepared - Same-instance capability. @returns Owned entries and their release callback after consuming it once. */
  consumePreparedProductImages(prepared: PreparedProductImageUpload): ConsumedProductImageUpload;
  /** @param prepared - Same-instance capability. @returns Nothing after releasing unconsumed capacity. */
  discardPreparedProductImages(prepared: PreparedProductImageUpload): void;
}
export interface ImageUploadPersistenceInput {
  readonly claim: ClaimedCommandExecution;
  readonly assets: readonly ImageAsset[];
}
export interface FinalizeImageUploadPersistenceInput extends ImageUploadPersistenceInput {
  readonly completionClock: () => IsoInstant;
}
export interface SetDisplayImageCommandPersistenceInput {
  readonly claim: ClaimedCommandExecution;
  readonly productId: string;
  readonly input: Omit<CustomGptSetDisplayImageCommandInput, "command_id">;
  readonly now: IsoInstant;
  readonly unlinkedExpiresAt: IsoInstant;
  readonly completionClock: () => IsoInstant;
}
export type SetDisplayImageCommandPersistenceResult =
  | { readonly outcome: "succeeded"; readonly record: SucceededCommandExecutionRecord }
  | { readonly outcome: "known_failure"; readonly failureCode: ImageCommandFailureCode };
export interface ImageCommandRepository {
  /** @param input - Owned claim and generated staging metadata. @returns Completion after atomic staging and exact readback. */
  stageImageUploadCommand(input: ImageUploadPersistenceInput): Promise<void>;
  /** @param input - Owned batch and trusted synchronous clock. @returns Atomically activated assets and their full ID receipt. */
  finalizeImageUploadCommand(input: FinalizeImageUploadPersistenceInput): Promise<SucceededCommandExecutionRecord>;
  /** @param input - Owned pre-finalization batch. @returns Completion after verifying and marking its existing rows for cleanup. */
  abandonImageUploadCommand(input: ImageUploadPersistenceInput): Promise<void>;
  /** @param imageAssetId - Owned pending row whose file is proven absent. @returns Completion after removing only pending metadata. */
  deleteClaimedImageAsset(imageAssetId: string): Promise<void>;
  /** @param input - Owned command, expected revision, target and trusted synchronous clocks. @returns Atomic success or rollback-proven preflight rejection. */
  executeSetDisplayImageCommand(input: SetDisplayImageCommandPersistenceInput): Promise<SetDisplayImageCommandPersistenceResult>;
}

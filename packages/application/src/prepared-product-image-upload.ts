import {
  BeautioError,
  imageMediaTypes,
  type ImageMediaType,
} from "@beautio/domain";
import { assertUploadNotAborted, parseImageUploads } from "./input-parsing.ts";
import type {
  ImageUploadInput,
  ImageUploadOperationOptions,
} from "./inventory-service-types.ts";
import type { ImageInspection, ImageInspector } from "./ports.ts";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_LIVE_PREPARATIONS = 17;
const MAX_LIVE_OWNED_BYTES = 100 * 1024 * 1024;
const MAX_INSPECTION_QUEUE = 16;

declare const preparedProductImageUploadBrand: unique symbol;

/** Opaque, single-use capability for one semantically validated image batch. */
export interface PreparedProductImageUpload {
  readonly [preparedProductImageUploadBrand]: true;
}

interface OwnedImage {
  readonly sourceRef: string;
  readonly bytes: Uint8Array;
}

export interface PreparedProductImageEntry extends OwnedImage {
  readonly mediaType: ImageMediaType;
}

interface LivePreparation {
  readonly entries: readonly PreparedProductImageEntry[];
  readonly reservation: ImagePreparationReservation;
}

export interface ConsumedProductImageUpload {
  readonly entries: readonly PreparedProductImageEntry[];
  /** Releases the live byte/count reservation after commit and compensation settle. */
  readonly release: () => void;
}

interface ImagePreparationReservation {
  readonly release: () => void;
}

interface InspectionWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
}

/**
 * Owns bounded semantic image preparation and its single-use commit capabilities.
 *
 * @remarks Every accepted batch reserves its owned bytes until it is committed or
 * explicitly discarded. Semantic image decoding is serialized per coordinator,
 * while queued cancellation never abandons active decoder work.
 */
export class ImageUploadPreparationCoordinator {
  readonly #inspector: ImageInspector;
  readonly #ownedHandles = new WeakSet<object>();
  readonly #liveHandles = new WeakMap<object, LivePreparation>();
  readonly #inspectionQueue: InspectionWaiter[] = [];
  #inspectionActive = false;
  #livePreparations = 0;
  #liveOwnedBytes = 0;

  /**
   * Creates one instance-scoped preparation boundary.
   *
   * @param inspector - Trusted decoder for untrusted image byte snapshots.
   */
  constructor(inspector: ImageInspector) {
    this.#inspector = inspector;
  }

  /**
   * Takes immutable ownership snapshots and validates one candidate image batch.
   *
   * @param untrustedImages - Adapter-neutral references and complete candidate bytes.
   * @param options - Optional cancellation observed before and after real decoder work.
   * @returns An opaque handle that must be committed or explicitly discarded once.
   */
  async prepare(
    untrustedImages: readonly ImageUploadInput[] | unknown,
    options: ImageUploadOperationOptions = {},
  ): Promise<PreparedProductImageUpload> {
    assertUploadNotAborted(options.signal);
    const parsedImages = parseImageUploads(untrustedImages);
    let totalBytes = 0;
    for (const image of parsedImages) {
      totalBytes += image.bytes.byteLength;
      validateEncodedSize(image.bytes.byteLength, totalBytes);
    }

    const reservation = this.reserve(totalBytes);
    try {
      // All caller-owned views are copied synchronously before the first await.
      const ownedImages = parsedImages.map((image): OwnedImage => ({
        sourceRef: image.source_ref,
        bytes: Uint8Array.from(image.bytes),
      }));
      const entries = await this.runInspection(options.signal, async () => {
        const validated: PreparedProductImageEntry[] = [];
        for (const image of ownedImages) {
          assertUploadNotAborted(options.signal);
          const inspection = await inspectSnapshot(
            this.#inspector,
            Uint8Array.from(image.bytes),
          );
          assertUploadNotAborted(options.signal);
          validateInspection(inspection);
          validated.push(
            Object.freeze({
              sourceRef: image.sourceRef,
              bytes: image.bytes,
              mediaType: inspection.mediaType,
            }),
          );
        }
        return Object.freeze(validated);
      });
      assertUploadNotAborted(options.signal);

      const handle = Object.freeze({}) as PreparedProductImageUpload;
      this.#ownedHandles.add(handle);
      this.#liveHandles.set(handle, { entries, reservation });
      return handle;
    } catch (error) {
      reservation.release();
      throw error;
    }
  }

  /**
   * Inspects one backup image through the same decoder slot used by uploads.
   *
   * @remarks Cancellation may release the backup caller before a decoder that
   * ignores its signal settles. The shared decoder slot is nevertheless held
   * until that original promise resolves or rejects.
   * @param bytes - Integrity-checked backup bytes owned by the restore operation.
   * @param options - Optional cancellation for the waiting backup caller.
   * @returns A primitive snapshot of the decoder result.
   */
  async inspectBackupSnapshot(
    bytes: Uint8Array,
    options: ImageUploadOperationOptions = {},
  ): Promise<ImageInspection> {
    assertUploadNotAborted(options.signal);
    await this.acquireInspection(options.signal);

    let operation: Promise<ImageInspection>;
    try {
      assertUploadNotAborted(options.signal);
      // Queued backup callers do not allocate their decoder copy until admitted.
      operation = inspectSnapshot(this.#inspector, Uint8Array.from(bytes));
    } catch (error) {
      this.releaseInspection();
      throw error;
    }

    return this.waitForBackupInspection(operation, options.signal);
  }

  /**
   * Atomically consumes a live handle before any persistence await can occur.
   *
   * @param handle - Handle returned by this coordinator's `prepare` method.
   * @returns Validated entries plus an idempotent reservation release callback.
   */
  consume(handle: PreparedProductImageUpload): ConsumedProductImageUpload {
    if (!isObject(handle) || !this.#ownedHandles.has(handle)) {
      throw invalidPreparedUpload();
    }
    const live = this.#liveHandles.get(handle);
    if (live === undefined) {
      throw consumedPreparedUpload();
    }
    this.#liveHandles.delete(handle);
    return {
      entries: live.entries,
      release: live.reservation.release,
    };
  }

  /**
   * Releases an uncommitted handle without exposing its bytes or metadata.
   *
   * @param handle - Same-instance handle to discard; an already consumed handle is a no-op.
   * @returns Nothing after any live reservation has been released.
   */
  discard(handle: PreparedProductImageUpload): void {
    if (!isObject(handle) || !this.#ownedHandles.has(handle)) {
      throw invalidPreparedUpload();
    }
    const live = this.#liveHandles.get(handle);
    if (live === undefined) {
      return;
    }
    this.#liveHandles.delete(handle);
    live.reservation.release();
  }

  private reserve(byteSize: number): ImagePreparationReservation {
    if (
      this.#livePreparations >= MAX_LIVE_PREPARATIONS ||
      this.#liveOwnedBytes + byteSize > MAX_LIVE_OWNED_BYTES
    ) {
      throw preparationCapacityExceeded();
    }
    this.#livePreparations += 1;
    this.#liveOwnedBytes += byteSize;
    let released = false;
    return {
      release: (): void => {
        if (released) {
          return;
        }
        released = true;
        this.#livePreparations -= 1;
        this.#liveOwnedBytes -= byteSize;
      },
    };
  }

  private async runInspection<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.acquireInspection(signal);
    try {
      assertUploadNotAborted(signal);
      const value = await operation();
      assertUploadNotAborted(signal);
      return value;
    } finally {
      this.releaseInspection();
    }
  }

  private waitForBackupInspection(
    operation: Promise<ImageInspection>,
    signal: AbortSignal | undefined,
  ): Promise<ImageInspection> {
    return new Promise<ImageInspection>((resolve, reject) => {
      const abort = (): void => reject(uploadAborted());
      const settle = (complete: () => void): void => {
        signal?.removeEventListener("abort", abort);
        this.releaseInspection();
        complete();
      };

      // Both original settlement paths are consumed here. A caller-side abort
      // cannot release the decoder slot or leave a rejected promise unobserved.
      void operation.then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error)),
      );
      if (signal?.aborted === true) {
        abort();
      } else {
        signal?.addEventListener("abort", abort, { once: true });
      }
    });
  }

  private acquireInspection(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(uploadAborted());
    }
    if (!this.#inspectionActive) {
      this.#inspectionActive = true;
      return Promise.resolve();
    }
    if (this.#inspectionQueue.length >= MAX_INSPECTION_QUEUE) {
      return Promise.reject(preparationCapacityExceeded());
    }
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        const index = this.#inspectionQueue.indexOf(waiter);
        if (index < 0) {
          return;
        }
        this.#inspectionQueue.splice(index, 1);
        signal?.removeEventListener("abort", abort);
        reject(uploadAborted());
      };
      const waiter: InspectionWaiter = {
        resolve,
        reject,
        signal,
        abort: signal === undefined ? undefined : abort,
      };
      this.#inspectionQueue.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private releaseInspection(): void {
    while (this.#inspectionQueue.length > 0) {
      const waiter = this.#inspectionQueue.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.abort!);
      if (waiter.signal?.aborted === true) {
        waiter.reject(uploadAborted());
        continue;
      }
      waiter.resolve();
      return;
    }
    this.#inspectionActive = false;
  }
}

async function inspectSnapshot(
  inspector: ImageInspector,
  bytes: Uint8Array,
): Promise<ImageInspection> {
  let inspection: ImageInspection;
  try {
    const decoded = await inspector.inspect(bytes);
    inspection = {
      mediaType: decoded.mediaType,
      width: decoded.width,
      height: decoded.height,
      animated: decoded.animated,
    };
  } catch (error) {
    if (error instanceof BeautioError) {
      throw error;
    }
    throw new BeautioError(
      "UNSUPPORTED_MEDIA_TYPE",
      "image content could not be decoded",
    );
  }
  return inspection;
}

function validateEncodedSize(byteSize: number, totalBytes: number): void {
  if (byteSize === 0) {
    throw new BeautioError(
      "UNSUPPORTED_MEDIA_TYPE",
      "image content cannot be empty",
    );
  }
  if (byteSize > MAX_IMAGE_BYTES) {
    throw new BeautioError(
      "UPLOAD_TOO_LARGE",
      "an image exceeds the 20 MiB limit",
    );
  }
  if (totalBytes > MAX_UPLOAD_BYTES) {
    throw new BeautioError(
      "UPLOAD_TOO_LARGE",
      "the upload exceeds the 50 MiB total limit",
    );
  }
}

function validateInspection(inspection: ImageInspection): void {
  if (
    !imageMediaTypes.includes(inspection.mediaType) ||
    inspection.animated
  ) {
    throw new BeautioError(
      "UNSUPPORTED_MEDIA_TYPE",
      "only JPEG, PNG, and static WebP images are supported",
    );
  }
  if (
    !Number.isInteger(inspection.width) ||
    !Number.isInteger(inspection.height) ||
    inspection.width < 1 ||
    inspection.height < 1
  ) {
    throw new BeautioError(
      "UNSUPPORTED_MEDIA_TYPE",
      "image dimensions could not be decoded",
    );
  }
  if (inspection.width * inspection.height > MAX_IMAGE_PIXELS) {
    throw new BeautioError(
      "UPLOAD_TOO_LARGE",
      "an image exceeds the 40 megapixel limit",
    );
  }
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function uploadAborted(): BeautioError {
  return new BeautioError("UPLOAD_FAILED", "image upload timed out");
}

function preparationCapacityExceeded(): BeautioError {
  return new BeautioError(
    "BATCH_CONFLICT",
    "image preparation capacity is full; retry later",
  );
}

function invalidPreparedUpload(): BeautioError {
  return new BeautioError("INTERNAL_ERROR", "prepared image upload is invalid");
}

function consumedPreparedUpload(): BeautioError {
  return new BeautioError(
    "INTERNAL_ERROR",
    "prepared image upload was already consumed",
  );
}

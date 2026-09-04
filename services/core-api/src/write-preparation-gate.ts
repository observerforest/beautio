import { BeautioError } from "@beautio/domain";

interface WritePreparationWaiter {
  readonly resolve: (permit: WritePreparationPermit) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

/** Configurable bounds for request preparation. */
export interface WritePreparationGateOptions {
  /** Maximum callers that may prepare requests concurrently. */
  readonly maximumActive?: number;
  /** Maximum callers that may wait after all active slots are occupied. */
  readonly maximumQueueLength?: number;
}

/** Ownership of one active request-preparation slot. */
export interface WritePreparationPermit {
  /**
   * Releases this permit at most once.
   *
   * @returns Nothing. Repeated calls have no additional effect.
   */
  release(): void;
}

const DEFAULT_MAXIMUM_ACTIVE = 2;
const DEFAULT_MAXIMUM_QUEUE_LENGTH = 16;

/**
 * Bounds concurrent request preparation without abandoning active work.
 *
 * @remarks A queued caller is removed when its signal aborts. Once a caller
 * receives a permit, aborting that signal does not release the permit; the
 * owner must release it only after both preparation and the downstream write
 * have actually settled. Holding the permit across that boundary keeps the
 * number of live prepared payloads bounded while they wait to be committed.
 */
export class WritePreparationGate {
  #active = 0;
  readonly #queue: WritePreparationWaiter[] = [];
  readonly #maximumActive: number;
  readonly #maximumQueueLength: number;

  /**
   * Creates a bounded FIFO gate for request preparation.
   *
   * @param options - Optional active and queued caller limits.
   */
  constructor(options: WritePreparationGateOptions = {}) {
    this.#maximumActive = positiveSafeInteger(
      options.maximumActive,
      DEFAULT_MAXIMUM_ACTIVE,
      "maximumActive",
    );
    this.#maximumQueueLength = nonNegativeSafeInteger(
      options.maximumQueueLength,
      DEFAULT_MAXIMUM_QUEUE_LENGTH,
      "maximumQueueLength",
    );
  }

  /**
   * Acquires one request-preparation permit or waits in FIFO order.
   *
   * @param signal - Caller-owned cancellation signal and deadline source.
   * @returns A permit whose idempotent `release` method must be called after
   * preparation and the downstream write have actually settled.
   * @throws An `AbortError` if the signal is already aborted or aborts while
   * queued. Throws `BeautioError` with `BATCH_CONFLICT` when the queue is full.
   */
  acquire(signal: AbortSignal): Promise<WritePreparationPermit> {
    if (signal.aborted) {
      return Promise.reject(operationAborted());
    }
    if (this.#active < this.#maximumActive) {
      this.#active += 1;
      return Promise.resolve(this.createPermit());
    }
    if (this.#queue.length >= this.#maximumQueueLength) {
      return Promise.reject(writePreparationQueueFull());
    }

    return new Promise<WritePreparationPermit>((resolve, reject) => {
      const abort = (): void => {
        const index = this.#queue.indexOf(waiter);
        if (index < 0) {
          return;
        }
        this.#queue.splice(index, 1);
        signal.removeEventListener("abort", abort);
        reject(operationAborted());
      };
      const waiter: WritePreparationWaiter = {
        resolve,
        reject,
        signal,
        abort,
      };
      this.#queue.push(waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private createPermit(): WritePreparationPermit {
    let released = false;
    return {
      release: (): void => {
        if (released) {
          return;
        }
        released = true;
        this.releaseActiveSlot();
      },
    };
  }

  private releaseActiveSlot(): void {
    while (this.#queue.length > 0) {
      const waiter = this.#queue.shift()!;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(operationAborted());
        continue;
      }
      waiter.resolve(this.createPermit());
      return;
    }
    this.#active -= 1;
  }
}

function operationAborted(): Error {
  const error = new Error("write preparation was aborted");
  error.name = "AbortError";
  return error;
}

function writePreparationQueueFull(): BeautioError {
  return new BeautioError(
    "BATCH_CONFLICT",
    "write preparation queue is full; retry later",
  );
}

function positiveSafeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function nonNegativeSafeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return resolved;
}

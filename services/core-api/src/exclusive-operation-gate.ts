import { BeautioError } from "@beautio/domain";

interface GateWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
  readonly timeout: NodeJS.Timeout;
}

export interface ExclusiveOperationGateOptions {
  readonly maximumQueueLength?: number;
  readonly queueTimeoutMs?: number;
}

const DEFAULT_MAXIMUM_QUEUE_LENGTH = 64;
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;

/**
 * Serializes state-changing and full-backup HTTP operations within one server process.
 *
 * @remarks Aborted queued callers are removed before they acquire the gate. The
 * active operation always settles before ownership passes to the next caller.
 */
export class ExclusiveOperationGate {
  #locked = false;
  readonly #queue: GateWaiter[] = [];
  readonly #maximumQueueLength: number;
  readonly #queueTimeoutMs: number;

  /**
   * Creates a bounded FIFO gate for serialized state-changing operations.
   *
   * @param options - Maximum queued callers and their maximum wait duration.
   */
  constructor(options: ExclusiveOperationGateOptions = {}) {
    this.#maximumQueueLength = positiveInteger(
      options.maximumQueueLength,
      DEFAULT_MAXIMUM_QUEUE_LENGTH,
      "maximumQueueLength",
    );
    this.#queueTimeoutMs = positiveInteger(
      options.queueTimeoutMs,
      DEFAULT_QUEUE_TIMEOUT_MS,
      "queueTimeoutMs",
    );
  }

  /**
   * Runs one operation after every earlier admitted operation has settled.
   *
   * @param operation - Work that must not overlap another admitted operation.
   * @param signal - Optional cancellation while queued or active.
   * @returns The operation result after exclusive execution.
   */
  async run<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.acquire(signal);
    try {
      if (signal?.aborted === true) {
        throw operationAborted();
      }
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(operationAborted());
    }
    if (!this.#locked) {
      this.#locked = true;
      return Promise.resolve();
    }
    if (this.#queue.length >= this.#maximumQueueLength) {
      return Promise.reject(writeQueueBusy());
    }
    return new Promise<void>((resolve, reject) => {
      const removeAndReject = (error: unknown): void => {
        const index = this.#queue.indexOf(waiter);
        if (index < 0) {
          return;
        }
        this.#queue.splice(index, 1);
        clearTimeout(waiter.timeout);
        signal?.removeEventListener("abort", waiter.abort!);
        reject(error);
      };
      const timeout = setTimeout(
        () => removeAndReject(writeQueueTimedOut()),
        this.#queueTimeoutMs,
      );
      timeout.unref();
      const waiter: GateWaiter = {
        resolve,
        reject,
        signal,
        timeout,
        abort:
          signal === undefined
            ? undefined
            : () => removeAndReject(operationAborted()),
      };
      this.#queue.push(waiter);
      signal?.addEventListener("abort", waiter.abort!, { once: true });
    });
  }

  private release(): void {
    while (this.#queue.length > 0) {
      const waiter = this.#queue.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.abort!);
      clearTimeout(waiter.timeout);
      if (waiter.signal?.aborted === true) {
        waiter.reject(operationAborted());
        continue;
      }
      waiter.resolve();
      return;
    }
    this.#locked = false;
  }
}

function operationAborted(): Error {
  const error = new Error("exclusive operation was aborted");
  error.name = "AbortError";
  return error;
}

function writeQueueBusy(): BeautioError {
  return new BeautioError(
    "BATCH_CONFLICT",
    "the write queue is full; retry later",
  );
}

function writeQueueTimedOut(): BeautioError {
  return new BeautioError(
    "BATCH_CONFLICT",
    "the write queue wait timed out; retry later",
  );
}

function positiveInteger(
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

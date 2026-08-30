interface GateWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
}

/**
 * Serializes state-changing and full-backup HTTP operations within one server process.
 *
 * @remarks Aborted queued callers are removed before they acquire the gate. The
 * active operation always settles before ownership passes to the next caller.
 */
export class ExclusiveOperationGate {
  #locked = false;
  readonly #queue: GateWaiter[] = [];

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
        throw backupOperationAborted();
      }
      return await operation();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(backupOperationAborted());
    }
    if (!this.#locked) {
      this.#locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: GateWaiter = {
        resolve,
        reject,
        signal,
        abort:
          signal === undefined
            ? undefined
            : () => {
                const index = this.#queue.indexOf(waiter);
                if (index >= 0) {
                  this.#queue.splice(index, 1);
                  reject(backupOperationAborted());
                }
              },
      };
      this.#queue.push(waiter);
      signal?.addEventListener("abort", waiter.abort!, { once: true });
    });
  }

  private release(): void {
    while (this.#queue.length > 0) {
      const waiter = this.#queue.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.abort!);
      if (waiter.signal?.aborted === true) {
        waiter.reject(backupOperationAborted());
        continue;
      }
      waiter.resolve();
      return;
    }
    this.#locked = false;
  }
}

function backupOperationAborted(): Error {
  return new Error("exclusive operation was aborted");
}

import assert from "node:assert/strict";
import test from "node:test";
import { BeautioError } from "@beautio/domain";
import { WritePreparationGate } from "../src/write-preparation-gate.ts";

test("admits two active callers, bounds sixteen waiters, and remains reusable", async () => {
  const gate = new WritePreparationGate();
  const signal = new AbortController().signal;
  const active = await Promise.all([gate.acquire(signal), gate.acquire(signal)]);
  const queued = Array.from({ length: 16 }, () => gate.acquire(signal));
  let overflowContinued = false;

  await assert.rejects(
    gate.acquire(signal).then((permit) => {
      overflowContinued = true;
      permit.release();
    }),
    (error: unknown) =>
      error instanceof BeautioError &&
      error.code === "BATCH_CONFLICT" &&
      error.message === "write preparation queue is full; retry later",
  );
  assert.equal(overflowContinued, false);

  const drain = Promise.all(
    queued.map(async (pendingPermit) => {
      const permit = await pendingPermit;
      permit.release();
    }),
  );
  for (const permit of active) {
    permit.release();
  }
  await drain;

  const afterCleanup = await gate.acquire(signal);
  afterCleanup.release();
});

test("removes an aborted waiter so another caller can take its queue place", async () => {
  const gate = new WritePreparationGate({
    maximumActive: 1,
    maximumQueueLength: 1,
  });
  const active = await gate.acquire(new AbortController().signal);
  const abortedController = new AbortController();
  const aborted = gate.acquire(abortedController.signal);

  abortedController.abort();
  await assert.rejects(
    aborted,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  const replacement = gate.acquire(new AbortController().signal);
  active.release();
  const replacementPermit = await replacement;
  replacementPermit.release();
});

test("does not release an active permit when its owner's signal aborts", async () => {
  const gate = new WritePreparationGate({ maximumActive: 1 });
  const activeController = new AbortController();
  const active = await gate.acquire(activeController.signal);
  let queuedEntered = false;
  const queued = gate.acquire(new AbortController().signal).then((permit) => {
    queuedEntered = true;
    return permit;
  });

  activeController.abort();
  await Promise.resolve();
  assert.equal(queuedEntered, false);

  active.release();
  const queuedPermit = await queued;
  assert.equal(queuedEntered, true);
  queuedPermit.release();
});

test("transfers released slots to queued callers in FIFO order", async () => {
  const gate = new WritePreparationGate({ maximumActive: 1 });
  const signal = new AbortController().signal;
  const active = await gate.acquire(signal);
  const order: number[] = [];
  const secondPending = gate.acquire(signal).then((permit) => {
    order.push(2);
    return permit;
  });
  const thirdPending = gate.acquire(signal).then((permit) => {
    order.push(3);
    return permit;
  });

  active.release();
  const second = await secondPending;
  assert.deepEqual(order, [2]);
  second.release();
  const third = await thirdPending;
  assert.deepEqual(order, [2, 3]);
  third.release();
});

test("releasing one permit twice does not release another active slot", async () => {
  const gate = new WritePreparationGate({ maximumActive: 1 });
  const signal = new AbortController().signal;
  const first = await gate.acquire(signal);
  const secondPending = gate.acquire(signal);

  first.release();
  const second = await secondPending;
  const thirdPending = gate.acquire(signal);
  let thirdEntered = false;
  const observedThird = thirdPending.then((permit) => {
    thirdEntered = true;
    return permit;
  });

  first.release();
  await Promise.resolve();
  assert.equal(thirdEntered, false);

  second.release();
  const third = await observedThird;
  third.release();
});

test("rejects an already-aborted caller without admitting it", async () => {
  const gate = new WritePreparationGate();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    gate.acquire(controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

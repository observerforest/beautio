import assert from "node:assert/strict";
import test from "node:test";
import { BeautioError } from "@beautio/domain";
import { ExclusiveOperationGate } from "../src/exclusive-operation-gate.ts";

test("queued operations are removed when their caller aborts", async () => {
  const gate = new ExclusiveOperationGate();
  let releaseActive!: () => void;
  const active = gate.run(
    () =>
      new Promise<void>((resolve) => {
        releaseActive = resolve;
      }),
  );
  const controller = new AbortController();
  let queuedRan = false;
  const queued = gate.run(async () => {
    queuedRan = true;
  }, controller.signal);

  controller.abort();
  await assert.rejects(
    queued,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  releaseActive();
  await active;
  assert.equal(queuedRan, false);
});

test("the exclusive queue rejects callers beyond its configured bound", async () => {
  const gate = new ExclusiveOperationGate({ maximumQueueLength: 1 });
  let releaseActive!: () => void;
  const active = gate.run(
    () =>
      new Promise<void>((resolve) => {
        releaseActive = resolve;
      }),
  );
  const admitted = gate.run(async () => undefined);

  await assert.rejects(
    gate.run(async () => undefined),
    (error: unknown) =>
      error instanceof BeautioError && error.code === "BATCH_CONFLICT",
  );
  releaseActive();
  await Promise.all([active, admitted]);
});

test("queued callers fail instead of waiting without a deadline", async () => {
  const gate = new ExclusiveOperationGate({ queueTimeoutMs: 10 });
  let releaseActive!: () => void;
  const active = gate.run(
    () =>
      new Promise<void>((resolve) => {
        releaseActive = resolve;
      }),
  );

  await assert.rejects(
    gate.run(async () => undefined),
    (error: unknown) =>
      error instanceof BeautioError &&
      error.code === "BATCH_CONFLICT" &&
      /timed out/u.test(error.message),
  );
  releaseActive();
  await active;
});

import assert from "node:assert/strict";
import { CommandExecutionError } from "@beautio/application";
import {
  customGptFactActionErrorSchema,
  customGptFactCommandOutputSchema,
} from "@beautio/contracts";
import { request as httpRequest } from "node:http";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  factActionFixture,
  factCommandId,
  factCustomGptToken,
} from "./custom-gpt-fact-action-fixture.ts";

const notesPath = "/api/actions/inventory-items/bottle/custom-notes";

test("an unfinished body times out and never occupies the exclusive write gate", { timeout: 10_000 }, async (context) => {
  const fixture = await factActionFixture(context, {
    coreOptions: { writeBodyTimeoutMs: 300 },
  });
  const arrived = new Promise<void>((resolve) =>
    fixture.server.once("request", () => resolve()),
  );
  const incomplete = startIncompleteRequest(fixture.origin + notesPath);
  await arrived;

  const valid = await fixture.request("PUT", notesPath, {
    command_id: factCommandId(101),
    custom_notes: "Completed around the slow body",
  });
  assert.equal(valid.status, 200);
  assert.equal(
    customGptFactCommandOutputSchema.parse(await valid.json()).status,
    "succeeded",
  );

  const rejection = await incomplete.response;
  await incomplete.closed;
  assert.equal(rejection.status, 400);
  assert.equal(rejection.connection, "close");
  assert.equal(
    fixture.database
      .prepare("SELECT COUNT(*) AS count FROM command_executions")
      .get()?.count,
    1,
  );
});

test("disconnect while queued cancels before execute and creates no command claim", { timeout: 10_000 }, async (context) => {
  const firstEntered = Promise.withResolvers<void>();
  const secondPrepared = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let prepareCalls = 0;
  let executeCalls = 0;
  const fixture = await factActionFixture(context, {
    createFactWrites: ({ service }) => ({
      prepare(operation, target, input) {
        const prepared = service.prepare(operation, target, input);
        prepareCalls += 1;
        if (prepareCalls === 2) secondPrepared.resolve();
        return prepared;
      },
      async executePrepared(prepared) {
        executeCalls += 1;
        if (executeCalls === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
        return service.executePrepared(prepared);
      },
    }),
  });

  const first = fixture.request("PUT", notesPath, {
    command_id: factCommandId(110),
    custom_notes: "First committed note",
  });
  await firstEntered.promise;
  const serverObservedClose = new Promise<void>((resolve) =>
    fixture.server.once("request", (_request, response) =>
      response.once("close", () => resolve()),
    ),
  );
  const cancelled = startAbortableJsonRequest(fixture.origin + notesPath, {
    command_id: factCommandId(111),
    custom_notes: "Cancelled queued note",
  });
  await secondPrepared.promise;
  cancelled.request.destroy();
  await cancelled.closed;
  await serverObservedClose;
  await nextTurn();
  releaseFirst.resolve();
  assert.equal((await first).status, 200);
  await nextTurn();

  assert.equal(executeCalls, 1);
  assert.equal(
    (
      await fixture.reads.getCommandStatus({
        operation_id: "set_inventory_item_custom_notes",
        command_id: factCommandId(111),
      })
    ).status,
    "not_found",
  );
  assert.equal(
    (await fixture.repository.findById("bottle"))?.customNotes,
    "First committed note",
  );
});

test("disconnect after gate entry does not release the gate before execution settles", { timeout: 10_000 }, async (context) => {
  const firstEntered = Promise.withResolvers<void>();
  const secondPrepared = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let prepareCalls = 0;
  let executeCalls = 0;
  const fixture = await factActionFixture(context, {
    createFactWrites: ({ service }) => ({
      prepare(operation, target, input) {
        const prepared = service.prepare(operation, target, input);
        prepareCalls += 1;
        if (prepareCalls === 2) secondPrepared.resolve();
        return prepared;
      },
      async executePrepared(prepared) {
        executeCalls += 1;
        if (executeCalls === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
        } else {
          secondEntered.resolve();
        }
        return service.executePrepared(prepared);
      },
    }),
  });

  const disconnected = startAbortableJsonRequest(fixture.origin + notesPath, {
    command_id: factCommandId(120),
    custom_notes: "Committed after disconnect",
  });
  await firstEntered.promise;
  disconnected.request.destroy();
  await disconnected.closed;

  const second = fixture.request("PUT", notesPath, {
    command_id: factCommandId(121),
    custom_notes: "Second committed note",
  });
  await secondPrepared.promise;
  assert.equal(
    await Promise.race([
      secondEntered.promise.then(() => true),
      delay(30).then(() => false),
    ]),
    false,
  );

  releaseFirst.resolve();
  const secondResponse = await second;
  assert.equal(secondResponse.status, 200);
  await secondEntered.promise;
  assert.equal(executeCalls, 2);
  assert.equal(
    (await fixture.repository.findById("bottle"))?.customNotes,
    "Second committed note",
  );
  assert.equal(
    fixture.database
      .prepare("SELECT COUNT(*) AS count FROM command_executions")
      .get()?.count,
    2,
  );
});

test("execution-stage busy and malformed success responses use safe unknown-result messages", async (context) => {
  await context.test("execution busy", async (nested) => {
    const fixture = await factActionFixture(nested, {
      createFactWrites: ({ service }) => ({
        prepare: service.prepare.bind(service),
        async executePrepared() {
          throw new CommandExecutionError(
            "COMMAND_STORE_BUSY",
            "Synthetic private busy detail",
          );
        },
      }),
    });
    const response = await fixture.request("PUT", notesPath, {
      command_id: factCommandId(130),
      custom_notes: "Not executed",
    });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.doesNotMatch(text, /Synthetic private|temporarily busy/u);
    assert.match(text, /command status and inventory facts/u);
    customGptFactActionErrorSchema.parse(JSON.parse(text));
  });

  await context.test("strict complete response", async (nested) => {
    const fixture = await factActionFixture(nested, {
      createFactWrites: ({ service }) => ({
        prepare: service.prepare.bind(service),
        async executePrepared(prepared) {
          return {
            ...(await service.executePrepared(prepared)),
            private_payload: "Synthetic response detail",
          };
        },
      }),
    });
    const body = {
      command_id: factCommandId(131),
      custom_notes: "Committed despite response rejection",
    };
    let response = await fixture.request("PUT", notesPath, body);
    assert.equal(response.status, 500);
    let text = await response.text();
    assert.doesNotMatch(text, /private_payload|Synthetic response/u);
    assert.match(text, /command status and inventory facts/u);
    const afterFirst = fixture.snapshot();

    response = await fixture.request("PUT", notesPath, body);
    assert.equal(response.status, 500);
    text = await response.text();
    assert.doesNotMatch(text, /private_payload|Synthetic response/u);
    assert.deepEqual(fixture.snapshot(), afterFirst);
    assert.equal(
      (await fixture.repository.findById("bottle"))?.customNotes,
      "Committed despite response rejection",
    );
  });
});

function startIncompleteRequest(url: string): {
  readonly closed: Promise<void>;
  readonly response: Promise<{
    readonly connection: string | undefined;
    readonly status: number | undefined;
  }>;
} {
  const closed = Promise.withResolvers<void>();
  const response = new Promise<{
    readonly connection: string | undefined;
    readonly status: number | undefined;
  }>((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${factCustomGptToken}`,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (incoming) => {
        incoming.resume();
        incoming.once("end", () =>
          resolve({
            connection: incoming.headers.connection,
            status: incoming.statusCode,
          }),
        );
        incoming.once("error", reject);
      },
    );
    request.once("error", reject);
    request.once("close", () => closed.resolve());
    request.write("{");
  });
  return { closed: closed.promise, response };
}

function startAbortableJsonRequest(url: string, body: unknown): {
  readonly closed: Promise<void>;
  readonly request: ReturnType<typeof httpRequest>;
} {
  const payload = JSON.stringify(body);
  const closed = Promise.withResolvers<void>();
  const request = httpRequest(
    url,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${factCustomGptToken}`,
        "content-length": String(Buffer.byteLength(payload)),
        "content-type": "application/json",
      },
    },
    (response) => response.resume(),
  );
  request.on("error", () => undefined);
  request.once("close", () => closed.resolve());
  request.end(payload);
  return { closed: closed.promise, request };
}

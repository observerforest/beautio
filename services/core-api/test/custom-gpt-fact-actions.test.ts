import assert from "node:assert/strict";
import {
  CommandExecutionError,
  CustomGptFactWriteService,
  type FactCommandRepository,
} from "@beautio/application";
import {
  customGptCommandStatusOutputSchema,
  customGptFactActionErrorSchema,
  customGptFactCommandOutputSchema,
  customGptFetchOutputSchema,
} from "@beautio/contracts";
import { BeautioError } from "@beautio/domain";
import test from "node:test";
import {
  factActionFixture,
  factAdminToken,
  factCodexToken,
  factCommandId,
} from "./custom-gpt-fact-action-fixture.ts";

test("five Custom GPT fact Actions commit through HTTP and are independently readable", async (context) => {
  const fixture = await factActionFixture(context);
  let current = await fetchBottle(fixture.origin);
  assert.ok(current.inventory_item.product);

  const profile = await factCommand(
    fixture.request("PATCH", "/api/actions/products/product/profile", {
      command_id: factCommandId(1),
      expected_revision: current.inventory_item.product.revision,
      alias: "New serum",
    }),
  );
  assert.equal(profile.status, "succeeded");
  assert.deepEqual(profile.result, {
    product_id: "product",
    revision: profile.result?.revision,
    outcome: "updated",
  });
  current = await fetchBottle(fixture.origin);
  assert.equal(current.inventory_item.product?.alias, "New serum");

  const facts = await factCommand(
    fixture.request("PATCH", "/api/actions/inventory-items/bottle/facts", {
      command_id: factCommandId(2),
      expected_revision: current.inventory_item.revision,
      expires_on: "2029-01-01",
    }),
  );
  assert.equal(facts.status, "succeeded");
  current = await fetchBottle(fixture.origin);
  assert.equal(current.inventory_item.expires_on, "2029-01-01");

  const notes = await factCommand(
    fixture.request("PUT", "/api/actions/inventory-items/bottle/custom-notes", {
      command_id: factCommandId(3),
      custom_notes: "Updated synthetic note",
    }),
  );
  assert.equal(notes.status, "succeeded");
  current = await fetchBottle(fixture.origin);
  assert.equal(current.inventory_item.custom_notes, "Updated synthetic note");

  const opened = await factCommand(
    fixture.request("POST", "/api/actions/inventory-items/bottle/open", {
      command_id: factCommandId(4),
      opened_on: "2026-09-05",
      opened_on_accuracy: "exact",
    }),
  );
  assert.equal(opened.status, "succeeded");
  assert.equal(opened.result?.outcome, "opened");
  current = await fetchBottle(fixture.origin);
  assert.equal(current.inventory_item.lifecycle_status, "opened");
  assert.equal(current.inventory_item.opened_on, "2026-09-05");

  const ended = await factCommand(
    fixture.request("POST", "/api/actions/inventory-items/bottle/end-use", {
      command_id: factCommandId(5),
      as_of: "2026-09-05",
      lifecycle_status: "finished",
    }),
  );
  assert.equal(ended.status, "succeeded");
  assert.equal(ended.result?.outcome, "finished");
  current = await fetchBottle(fixture.origin);
  assert.equal(current.inventory_item.lifecycle_status, "finished");
  assert.equal(current.inventory_item.remaining_percent_estimate, 0);

  const statusResponse = await fixture.request(
    "POST",
    "/api/actions/commands/status",
    {
      operation_id: "end_inventory_item_use",
      command_id: factCommandId(5),
    },
  );
  assert.equal(statusResponse.status, 200);
  const status = customGptCommandStatusOutputSchema.parse(
    await statusResponse.json(),
  );
  assert.deepEqual(status.result, ended.result);

  const stored = JSON.stringify(
    fixture.database
      .prepare("SELECT result_json, failure_message FROM command_executions")
      .all(),
  );
  assert.doesNotMatch(stored, /Updated synthetic note|New serum/u);
});

test("fact routes accept only the Custom GPT identity and fail closed when disabled", async (context) => {
  const fixture = await factActionFixture(context);
  const before = fixture.snapshot();
  const path = "/api/actions/inventory-items/bottle/custom-notes";
  const body = {
    command_id: factCommandId(10),
    custom_notes: "Must not be written",
  };
  for (const token of [null, factCodexToken, factAdminToken]) {
    const response = await fixture.request("PUT", path, body, token);
    assert.equal(response.status, 401);
  }
  assert.deepEqual(fixture.snapshot(), before);

  const disabled = await factActionFixture(context, {
    enableFactWrites: false,
  });
  const response = await disabled.request("PUT", path, body);
  assert.equal(response.status, 404);
  assert.equal(
    customGptFactActionErrorSchema.parse(await response.json()).error.code,
    "NOT_FOUND",
  );
  assert.deepEqual(disabled.snapshot()[4], []);
});

test("fact routes reject method, query, path, media, field and body boundary violations before claim", async (context) => {
  const fixture = await factActionFixture(context);
  const command = {
    command_id: factCommandId(20),
    custom_notes: "No mutation",
  };
  const cases = [
    fixture.request(
      "POST",
      "/api/actions/inventory-items/bottle/custom-notes",
      command,
    ).then((response) => [response, 404] as const),
    fixture.request(
      "PUT",
      "/api/actions/inventory-items/bottle/custom-notes?extra=true",
      command,
    ).then((response) => [response, 400] as const),
    fixture.request(
      "PUT",
      "/api/actions/inventory-items/bottle/unknown",
      command,
    ).then((response) => [response, 404] as const),
    fixture.request(
      "PUT",
      "/api/actions/inventory-items/a%2Fb/custom-notes",
      command,
    ).then((response) => [response, 400] as const),
    fixture.request(
      "PUT",
      "/api/actions/inventory-items/bottle/custom-notes",
      command,
      undefined,
      "text/plain",
    ).then((response) => [response, 400] as const),
    fixture.request(
      "PUT",
      "/api/actions/inventory-items/bottle/custom-notes",
      { ...command, unknown: true },
    ).then((response) => [response, 400] as const),
    fixture.request(
      "PUT",
      "/api/actions/inventory-items/bottle/custom-notes",
      JSON.stringify({ ...command, custom_notes: "x".repeat(65 * 1024) }),
    ).then((response) => [response, 413] as const),
  ];
  for (const pending of cases) {
    const [response, expectedStatus] = await pending;
    assert.equal(response.status, expectedStatus);
    customGptFactActionErrorSchema.parse(await response.json());
  }
  assert.deepEqual(fixture.snapshot()[4], []);
  assert.equal((await fetchBottle(fixture.origin)).inventory_item.custom_notes, "Synthetic bottle notes");
});

test("same normalized command replays once while changed target or payload conflicts", async (context) => {
  const fixture = await factActionFixture(context);
  const path = "/api/actions/inventory-items/bottle/custom-notes";
  const commandId = factCommandId(30);
  const first = await factCommand(
    fixture.request("PUT", path, {
      command_id: commandId,
      custom_notes: "  Normalized note  ",
    }),
  );
  const afterFirst = fixture.snapshot();
  const replay = await factCommand(
    fixture.request("PUT", path, {
      custom_notes: "Normalized note",
      command_id: commandId,
    }),
  );
  assert.deepEqual(replay, first);

  for (const [target, value] of [
    ["other", "Normalized note"],
    ["bottle", "Changed note"],
  ] as const) {
    const response = await fixture.request(
      "PUT",
      `/api/actions/inventory-items/${target}/custom-notes`,
      { command_id: commandId, custom_notes: value },
    );
    assert.equal(response.status, 409);
    assert.equal(
      customGptFactActionErrorSchema.parse(await response.json()).error.code,
      "COMMAND_PAYLOAD_CONFLICT",
    );
  }
  assert.deepEqual(fixture.snapshot(), afterFirst);
});

test("rollback-proven rejection is a replayable failed command, not an HTTP write error", async (context) => {
  const fixture = await factActionFixture(context);
  const body = {
    command_id: factCommandId(40),
    custom_notes: "Missing target",
  };
  const first = await factCommand(
    fixture.request(
      "PUT",
      "/api/actions/inventory-items/missing/custom-notes",
      body,
    ),
  );
  assert.equal(first.status, "failed");
  assert.equal(first.failure_code, "INVENTORY_ITEM_NOT_FOUND");
  assert.equal(first.result, null);
  const replay = await factCommand(
    fixture.request(
      "PUT",
      "/api/actions/inventory-items/missing/custom-notes",
      body,
    ),
  );
  assert.deepEqual(replay, first);
});

test("post-commit domain-shaped failure returns unknown and never repeats the effect", async (context) => {
  const fixture = await factActionFixture(context, {
    createFactWrites: ({ commands, repository }) => {
      const postCommitFailure: FactCommandRepository = {
        async executeFactCommand(command) {
          await repository.executeFactCommand(command);
          throw new BeautioError(
            "INVALID_INPUT",
            "Synthetic private failure after commit",
          );
        },
      };
      return new CustomGptFactWriteService(postCommitFailure, commands);
    },
  });
  const body = {
    command_id: factCommandId(50),
    custom_notes: "Committed before response loss",
  };
  let response = await fixture.request(
    "PUT",
    "/api/actions/inventory-items/bottle/custom-notes",
    body,
  );
  assert.equal(response.status, 500);
  const errorText = await response.text();
  assert.doesNotMatch(errorText, /Synthetic private|after commit/u);
  assert.match(errorText, /command status and inventory facts/u);
  assert.equal(
    (await fetchBottle(fixture.origin)).inventory_item.custom_notes,
    "Committed before response loss",
  );

  response = await fixture.request(
    "PUT",
    "/api/actions/inventory-items/bottle/custom-notes",
    body,
  );
  assert.equal(response.status, 200);
  assert.equal(
    customGptFactCommandOutputSchema.parse(await response.json()).status,
    "in_progress",
  );
  assert.equal(
    fixture.database
      .prepare("SELECT COUNT(*) AS count FROM command_executions")
      .get()?.count,
    1,
  );
});

test("post-commit settlement busy stays unknown and replays in-progress without a second effect", async (context) => {
  let effects = 0;
  const fixture = await factActionFixture(context, {
    createFactWrites: ({ commands, repository }) =>
      new CustomGptFactWriteService(
        {
          async executeFactCommand(command) {
            effects += 1;
            return repository.executeFactCommand(command);
          },
        },
        commands,
      ),
  });
  fixture.repository.completeCommandExecutionSuccess = async () => {
    throw new CommandExecutionError(
      "COMMAND_STORE_BUSY",
      "Synthetic private settlement detail",
    );
  };
  const body = {
    command_id: factCommandId(51),
    custom_notes: "Committed before settlement busy",
  };
  let response = await fixture.request(
    "PUT",
    "/api/actions/inventory-items/bottle/custom-notes",
    body,
  );
  assert.equal(response.status, 500);
  const errorText = await response.text();
  assert.doesNotMatch(errorText, /Synthetic private|settlement detail/u);
  assert.match(errorText, /command status and inventory facts/u);
  assert.equal(
    (await fetchBottle(fixture.origin)).inventory_item.custom_notes,
    "Committed before settlement busy",
  );

  const statusResponse = await fixture.request(
    "POST",
    "/api/actions/commands/status",
    {
      operation_id: "set_inventory_item_custom_notes",
      command_id: factCommandId(51),
    },
  );
  assert.equal(statusResponse.status, 200);
  assert.equal(
    customGptCommandStatusOutputSchema.parse(await statusResponse.json()).status,
    "in_progress",
  );
  const afterFirst = fixture.snapshot();

  response = await fixture.request(
    "PUT",
    "/api/actions/inventory-items/bottle/custom-notes",
    body,
  );
  assert.equal(response.status, 200);
  assert.equal(
    customGptFactCommandOutputSchema.parse(await response.json()).status,
    "in_progress",
  );
  assert.equal(effects, 1);
  assert.deepEqual(fixture.snapshot(), afterFirst);
});

async function factCommand(responsePromise: Promise<Response>) {
  const response = await responsePromise;
  assert.equal(response.status, 200);
  return customGptFactCommandOutputSchema.parse(await response.json());
}

async function fetchBottle(origin: string) {
  const response = await fetch(`${origin}/api/actions/inventory/fetch`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-custom-gpt-fact-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ inventory_item_id: "bottle" }),
  });
  assert.equal(response.status, 200);
  return customGptFetchOutputSchema.parse(await response.json());
}

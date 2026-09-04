import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEndUseInput,
  emptyEndUseDraft,
  endUseQuickPercentages,
  type EndUseDraft,
} from "../src/features/inventory/models/end-use-model.ts";

const AS_OF = "2026-09-01";

test("end-use draft starts without a persisted lifecycle or remaining estimate", () => {
  assert.deepEqual(emptyEndUseDraft(), {
    lifecycleStatus: null,
    remainingSelection: "unset",
    remainingPercent: 50,
  });
  assert.deepEqual(buildEndUseInput(emptyEndUseDraft(), AS_OF), {
    ok: false,
    field: "lifecycle",
    message: "请选择用完或丢弃。",
  });
});

test("finished omits a stale slider value and lets the server freeze zero remaining", () => {
  assert.deepEqual(
    buildEndUseInput(
      {
        lifecycleStatus: "finished",
        remainingSelection: "estimate",
        remainingPercent: 75,
      },
      AS_OF,
    ),
    {
      ok: true,
      input: { as_of: AS_OF, lifecycle_status: "finished" },
    },
  );
});

test("discarded requires an explicit estimate or explicit unknown snapshot", () => {
  assert.deepEqual(
    buildEndUseInput(
      {
        lifecycleStatus: "discarded",
        remainingSelection: "unset",
        remainingPercent: 50,
      },
      AS_OF,
    ),
    {
      ok: false,
      field: "remaining",
      message: "请估算剩余量，或明确选择未知。",
    },
  );
  assert.deepEqual(
    buildEndUseInput(
      {
        lifecycleStatus: "discarded",
        remainingSelection: "unknown",
        remainingPercent: 50,
      },
      AS_OF,
    ),
    {
      ok: true,
      input: {
        as_of: AS_OF,
        lifecycle_status: "discarded",
        remaining_percent_estimate: null,
      },
    },
  );
});

test("discarded accepts integer percentage boundaries and the UI shortcut set", () => {
  assert.deepEqual(endUseQuickPercentages, [0, 25, 50, 75, 100]);
  for (const remainingPercent of endUseQuickPercentages) {
    assert.deepEqual(
      buildEndUseInput(
        {
          lifecycleStatus: "discarded",
          remainingSelection: "estimate",
          remainingPercent,
        },
        AS_OF,
      ),
      {
        ok: true,
        input: {
          as_of: AS_OF,
          lifecycle_status: "discarded",
          remaining_percent_estimate: remainingPercent,
        },
      },
    );
  }
});

test("discarded rejects invalid remaining estimates before building a command", () => {
  for (const remainingPercent of [-1, 101, 1.5, Number.NaN]) {
    const draft: EndUseDraft = {
      lifecycleStatus: "discarded",
      remainingSelection: "estimate",
      remainingPercent,
    };
    assert.deepEqual(buildEndUseInput(draft, AS_OF), {
      ok: false,
      field: "remaining",
      message: "剩余量必须是 0–100 的整数，或明确选择未知。",
    });
  }
});

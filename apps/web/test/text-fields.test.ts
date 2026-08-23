import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeOptionalEditorText,
  textCharacterCountLabel,
} from "../src/text-fields.ts";

test("optional editor text trims only the edges and clears whitespace", () => {
  assert.equal(normalizeOptionalEditorText(" \n  "), null);
  assert.equal(
    normalizeOptionalEditorText("  Water, Glycerin\nNiacinamide.  "),
    "Water, Glycerin\nNiacinamide.",
  );
});

test("character counters use the browser string length and require a limit", () => {
  assert.equal(textCharacterCountLabel("第一行\nsecond", 1_000), "10 / 1000");
  assert.throws(() => textCharacterCountLabel("value", 0), RangeError);
});

import {
  customGptSetDisplayImageCommandInputSchema, customGptUploadImagesCommandInputSchema,
  productIdSchema, setDisplayImageCommandSuccessResultSchema, uploadImagesCommandSuccessResultSchema,
} from "@beautio/contracts";
import { maximumEntityRevision } from "@beautio/domain";
import { createCanonicalCommandPayload, createSafeCommandResult } from "./canonical-json.ts";
import { parseInput } from "./input-parsing.ts";

/** @param input - Unknown upload body. @returns Owned normalized transport data and stable identity hash without I/O. */
export function prepareImageUploadCommandValue(input: unknown) {
  const parsed = parseInput(customGptUploadImagesCommandInputSchema, input);
  const references = Object.freeze(parsed.openaiFileIdRefs.map((reference) => Object.freeze(reference)));
  createSafeCommandResult(uploadImagesCommandSuccessResultSchema.parse({
    outcome: "uploaded", expires_at: "9999-12-31T23:59:59.999Z",
    image_asset_ids: Array.from({ length: 10 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
  }));
  return Object.freeze({ commandId: parsed.command_id, references, payload: createCanonicalCommandPayload({
    files: references.map(({ id, name, mime_type }) => ({ id, name, mime_type })),
  }) });
}

/** @param productId - Separate route target. @param input - Unknown command body. @returns Owned normalized target and full business hash. */
export function prepareSetDisplayImageCommandValue(productId: string, input: unknown) {
  const target = parseInput(productIdSchema, productId);
  const { command_id: commandId, ...body } = parseInput(customGptSetDisplayImageCommandInputSchema, input);
  createSafeCommandResult(setDisplayImageCommandSuccessResultSchema.parse({ outcome: "updated", product_id: target, revision: maximumEntityRevision }));
  return Object.freeze({ commandId, productId: target, input: Object.freeze(body),
    payload: createCanonicalCommandPayload({ product_id: target, ...body }),
  });
}
export type ImageUploadCommandValue = ReturnType<typeof prepareImageUploadCommandValue>;
export type SetDisplayImageCommandValue = ReturnType<typeof prepareSetDisplayImageCommandValue>;

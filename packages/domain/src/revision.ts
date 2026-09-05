import { BeautioError } from "./errors.ts";

declare const entityRevisionBrand: unique symbol;

export type EntityRevision = number & { readonly [entityRevisionBrand]: true };
export const maximumEntityRevision = Number.MAX_SAFE_INTEGER;

/**
 * Validates an opaque server-issued revision without coercion or rounding.
 * @param value - Revision read from persistence or supplied as a precondition.
 * @returns A positive safe integer; invalid values fail before any write.
 */
export function parseEntityRevision(value: unknown): EntityRevision {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new BeautioError("INVALID_INPUT", "revision must be a positive safe integer");
  }
  return value as EntityRevision;
}

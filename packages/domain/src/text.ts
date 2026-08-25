import { BeautioError } from "./errors.ts";

export const ingredientListTextMaximumLength = 5_000;
export const sharedNotesMaximumLength = 1_000;
export const customNotesMaximumLength = 1_000;

/**
 * Reports whether free-form persisted text can be represented consistently by
 * the JSON and SQLite boundaries used by Beautio.
 *
 * @param value - User-confirmed text before persistence.
 * @returns True for ordinary Unicode text plus tab and line breaks; false for
 * unsupported C0 controls or unpaired UTF-16 surrogates.
 */
export function hasOnlySupportedTextCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit <= 0x1f &&
      codeUnit !== 0x09 &&
      codeUnit !== 0x0a &&
      codeUnit !== 0x0d
    ) {
      return false;
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) {
        return false;
      }
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return false;
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function requireText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new BeautioError("INVALID_INPUT", `${fieldName} is required`);
  }
  return normalized;
}

export function normalizeOptionalText(
  value: string | null | undefined,
  fieldName: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new BeautioError(
      "INVALID_INPUT",
      `${fieldName} must be non-empty when provided`,
    );
  }
  return normalized;
}

export function normalizeNullableText(
  value: string | null | undefined,
  fieldName: string,
  maximumLength: number,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!hasOnlySupportedTextCharacters(value)) {
    throw new BeautioError(
      "INVALID_INPUT",
      `${fieldName} contains unsupported control characters`,
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > maximumLength) {
    throw new BeautioError(
      "INVALID_INPUT",
      `${fieldName} must be at most ${maximumLength} characters`,
    );
  }
  return normalized;
}

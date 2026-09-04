import { createHash } from "node:crypto";
import {
  CommandExecutionError,
  maximumStoredCommandFailureCodeBytes,
  maximumStoredCommandFailureMessageBytes,
  maximumStoredCommandFailureRefBytes,
  maximumStoredCommandResultBytes,
  type CanonicalCommandPayload,
  type CommandPayloadSha256,
  type JsonObject,
  type JsonValue,
  type KnownCommandFailure,
  type SafeCommandResult,
} from "./command-execution-types.ts";

const RESERVED_COMMAND_PAYLOAD_KEYS = new Set([
  "command_id",
  "operation_id",
  "principal",
]);

const SENSITIVE_COMMAND_KEYS = new Set([
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "tokenhash",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "storagekey",
]);

const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Hashes one already schema-validated, business-normalized command payload.
 *
 * The root must be a plain JSON object containing every normalized target and
 * side-effecting field. Command identity fields are structurally separate and
 * therefore rejected here. Object keys are sorted; array order and the
 * distinction between an omitted field and an explicit null remain significant.
 *
 * @param normalizedPayload - Parsed, normalized operation payload without command identity.
 * @returns An opaque SHA-256 value accepted by the CommandExecution service.
 */
export function createCanonicalCommandPayload(
  normalizedPayload: unknown,
): CanonicalCommandPayload {
  const object = requirePlainJsonObject(normalizedPayload, "command payload");
  for (const reservedKey of RESERVED_COMMAND_PAYLOAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(object, reservedKey)) {
      throw invalidCommandData(
        `command payload must not contain reserved field ${reservedKey}`,
      );
    }
  }
  assertNoSensitiveFields(object as JsonObject, "command payload", new Set());
  const canonicalJson = canonicalizeJsonValue(object, new Set());
  const sha256 = createHash("sha256")
    .update(canonicalJson, "utf8")
    .digest("hex") as CommandPayloadSha256;
  return Object.freeze({ sha256 }) as CanonicalCommandPayload;
}

/**
 * Reduces a successful command result to bounded canonical JSON safe for replay.
 *
 * @param value - Deliberately selected public result fields, never a raw response.
 * @returns Immutable parsed value and its bounded canonical serialization.
 */
export function createSafeCommandResult(value: unknown): SafeCommandResult {
  const object = requirePlainJsonObject(value, "command result");
  assertNoSensitiveFields(object as JsonObject, "command result", new Set());
  const serialized = canonicalizeJsonValue(object, new Set());
  if (Buffer.byteLength(serialized, "utf8") > maximumStoredCommandResultBytes) {
    throw new CommandExecutionError(
      "COMMAND_RESULT_TOO_LARGE",
      `command result exceeds ${maximumStoredCommandResultBytes} UTF-8 bytes`,
    );
  }
  const normalized = JSON.parse(serialized) as JsonObject;
  return Object.freeze({
    value: deepFreezeJson(normalized) as JsonObject,
    serialized,
  }) as SafeCommandResult;
}

/**
 * Validates an explicitly classified failure that is safe to persist and replay.
 *
 * Calling code must use this only after proving that no side effect committed or
 * that the complete business transaction rolled back.
 *
 * @param value - Stable failure code, safe message, and optional safe reference.
 * @returns A bounded immutable failure record.
 */
export function createKnownCommandFailure(
  value: unknown,
): KnownCommandFailure {
  const object = requirePlainJsonObject(value, "known command failure");
  const keys = Object.keys(object).sort();
  const allowedKeys = new Set(["code", "message", "ref"]);
  if (keys.some((key) => !allowedKeys.has(key))) {
    throw invalidCommandData("known command failure has unsupported fields");
  }
  const code = requireBoundedString(
    object.code,
    "failure code",
    maximumStoredCommandFailureCodeBytes,
  );
  if (!FAILURE_CODE_PATTERN.test(code)) {
    throw invalidCommandData(
      "failure code must use uppercase letters, digits, and underscores",
    );
  }
  const message = requireBoundedString(
    object.message,
    "failure message",
    maximumStoredCommandFailureMessageBytes,
  );
  assertNoBearerLikeCredential(message, "failure message");
  const rawRef = object.ref;
  if (rawRef === undefined) {
    return Object.freeze({ code, message });
  }
  const ref = requireBoundedString(
    rawRef,
    "failure ref",
    maximumStoredCommandFailureRefBytes,
  );
  assertNoBearerLikeCredential(ref, "failure ref");
  return Object.freeze({ code, message, ref });
}

export function isCommandPayloadSha256(
  value: string,
): value is CommandPayloadSha256 {
  return SHA256_PATTERN.test(value);
}

function canonicalizeJsonValue(
  value: unknown,
  ancestors: Set<object>,
): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw invalidCommandData("JSON numbers must be finite");
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "object":
      break;
    default:
      throw invalidCommandData("value is not JSON-compatible");
  }

  if (ancestors.has(value)) {
    throw invalidCommandData("cyclic values are not JSON-compatible");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertPlainJsonArray(value);
      return `[${value
        .map((entry) => canonicalizeJsonValue(entry, ancestors))
        .join(",")}]`;
    }
    const object = requirePlainJsonObject(value, "JSON value");
    return `{${Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeJsonValue(object[key], ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function requirePlainJsonObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidCommandData(`${label} must be a plain JSON object`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidCommandData(`${label} must be a plain JSON object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalidCommandData(`${label} must not contain symbol keys`);
  }
  for (const propertyName of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, propertyName);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidCommandData(`${label} must contain only JSON data fields`);
    }
  }
  return value as Record<string, unknown>;
}

function assertPlainJsonArray(value: readonly unknown[]): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw invalidCommandData("JSON arrays must use the standard Array prototype");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalidCommandData("JSON arrays must not contain symbol keys");
  }
  const propertyNames = Object.getOwnPropertyNames(value);
  const expectedNames = [
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    "length",
  ];
  if (
    propertyNames.length !== expectedNames.length ||
    expectedNames.some((name) => !propertyNames.includes(name))
  ) {
    throw invalidCommandData(
      "JSON arrays must be dense and contain no extra properties",
    );
  }
}

function assertNoSensitiveFields(
  value: JsonValue,
  label: string,
  ancestors: Set<object>,
): void {
  if (value !== null && typeof value === "object") {
    if (ancestors.has(value)) {
      throw invalidCommandData("cyclic values are not JSON-compatible");
    }
    ancestors.add(value);
  }
  try {
    if (Array.isArray(value)) {
      for (const entry of value) {
        assertNoSensitiveFields(entry, label, ancestors);
      }
      return;
    }
    if (value === null || typeof value !== "object") {
      if (typeof value === "string") {
        assertNoBearerLikeCredential(value, label);
      }
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_COMMAND_KEYS.has(normalizeSensitiveKey(key))) {
        throw invalidCommandData(
          `${label} must not contain credential or storage fields`,
        );
      }
      assertNoSensitiveFields(entry, label, ancestors);
    }
  } finally {
    if (value !== null && typeof value === "object") {
      ancestors.delete(value);
    }
  }
}

function normalizeSensitiveKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

function assertNoBearerLikeCredential(value: string, label: string): void {
  if (/\bbearer\s+\S+/iu.test(value)) {
    throw invalidCommandData(`${label} must not contain credentials`);
  }
}

function requireBoundedString(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string") {
    throw invalidCommandData(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw invalidCommandData(`${label} must not be empty`);
  }
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw invalidCommandData(`${label} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return normalized;
}

function deepFreezeJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") {
    for (const entry of Array.isArray(value) ? value : Object.values(value)) {
      deepFreezeJson(entry);
    }
    Object.freeze(value);
  }
  return value;
}

function invalidCommandData(message: string): CommandExecutionError {
  return new CommandExecutionError("COMMAND_INPUT_INVALID", message);
}

import { sourceRefSchema } from "@beautio/contracts";
import { BeautioError, type InventoryItem } from "@beautio/domain";
import type { ImageUploadInput } from "./inventory-service-types.ts";

const MAX_IMAGES = 10;

/**
 * Parses an untrusted application input through its contract schema.
 *
 * @param schema - Contract schema that returns normalized data or safe validation issues.
 * @param input - Untrusted value received from an adapter.
 * @returns The normalized contract value.
 * @throws BeautioError with a stable field-level reason when the schema exposes one.
 */
export function parseInput<T>(
  schema: {
    safeParse(
      input: unknown,
    ):
      | { success: true; data: T }
      | {
          success: false;
          error?: { issues?: readonly { message?: unknown }[] };
        };
  },
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const specificMessage = result.error?.issues
      ?.map((issue) => issue.message)
      .find(
        (message): message is string =>
          typeof message === "string" && message.startsWith("INVALID_INPUT: "),
      );
    throw new BeautioError(
      "INVALID_INPUT",
      specificMessage?.slice("INVALID_INPUT: ".length) ??
        "input does not match the tool contract",
    );
  }
  return result.data;
}

export function parseRequiredId(value: string, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BeautioError("INVALID_INPUT", `${fieldName} is required`);
  }
  return value.trim();
}

export function parseImageUploads(
  input: unknown,
): readonly ImageUploadInput[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_IMAGES) {
    throw new BeautioError(
      "INVALID_INPUT",
      "images must contain 1 through 10 items",
    );
  }
  const refs = new Set<string>();
  return input.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      Object.keys(candidate).some(
        (key) => key !== "source_ref" && key !== "bytes",
      )
    ) {
      throw new BeautioError(
        "INVALID_INPUT",
        "each image must contain only source_ref and bytes",
      );
    }
    const record = candidate as Record<string, unknown>;
    const sourceRef = parseInput(sourceRefSchema, record.source_ref);
    if (refs.has(sourceRef)) {
      throw new BeautioError(
        "INVALID_INPUT",
        `duplicate image source_ref ${sourceRef}`,
      );
    }
    refs.add(sourceRef);
    if (!(record.bytes instanceof Uint8Array)) {
      throw new BeautioError("INVALID_INPUT", "image bytes must be binary data");
    }
    return { source_ref: sourceRef, bytes: record.bytes };
  });
}

export function assertUploadNotAborted(
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted === true) {
    throw new BeautioError("UPLOAD_FAILED", "image upload timed out");
  }
}

export function abortableInspection<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return operation;
  }
  if (signal.aborted) {
    return Promise.reject(
      new BeautioError("UPLOAD_FAILED", "image upload timed out"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(new BeautioError("UPLOAD_FAILED", "image upload timed out"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function ensureUniqueRefs(
  refs: readonly string[],
  entityName: string,
): void {
  const unique = new Set<string>();
  for (const ref of refs) {
    if (unique.has(ref)) {
      throw new BeautioError(
        "INVALID_INPUT",
        `duplicate ${entityName} batch_ref ${ref}`,
      );
    }
    unique.add(ref);
  }
}

export function validateEditedOpeningAccuracy(
  existing: InventoryItem,
  input: {
    readonly lifecycle_status: "unopened" | "opened";
    readonly opened_on: string | null;
    readonly opened_on_accuracy: "exact" | "estimated" | "legacy_unknown" | null;
  },
): void {
  if (input.lifecycle_status === "unopened") {
    if (input.opened_on !== null || input.opened_on_accuracy !== null) {
      throw new BeautioError(
        "INVALID_INPUT",
        "unopened inventory cannot have opening facts",
      );
    }
    return;
  }
  if (input.opened_on === null || input.opened_on_accuracy === null) {
    throw new BeautioError(
      "INVALID_INPUT",
      "opened inventory requires opened_on and opened_on_accuracy",
    );
  }
  if (
    input.opened_on_accuracy === "legacy_unknown" &&
    (existing.lifecycleStatus !== "opened" ||
      existing.openedOnAccuracy !== "legacy_unknown" ||
      existing.openedOn !== input.opened_on)
  ) {
    throw new BeautioError(
      "INVALID_INPUT",
      "legacy_unknown can only preserve an unchanged legacy opening date",
    );
  }
}

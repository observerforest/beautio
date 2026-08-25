import { sourceRefSchema } from "@beautio/contracts";
import { BeautioError } from "@beautio/domain";
import type { IncomingMessage } from "node:http";
import { invalidInput } from "./responses.ts";

export const JSON_BODY_LIMIT = 1024 * 1024;
const ADMIN_MULTIPART_LIMIT = 21 * 1024 * 1024;
const CODEX_MULTIPART_LIMIT = 51 * 1024 * 1024;
const MAXIMUM_IMAGE_BYTES = 20 * 1024 * 1024;
const MAXIMUM_UPLOAD_BYTES = 50 * 1024 * 1024;
const MCP_BODY_TIMEOUT_MS = 10_000;

export async function readJson(
  request: IncomingMessage,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (mediaType(contentType) !== "application/json") {
    throw invalidInput();
  }
  const body = await readBody(request, maximumBytes, signal);
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw invalidInput();
  }
}

export async function readMcpJson(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (mediaType(contentType) !== "application/json") {
    throw new BeautioError(
      "UNSUPPORTED_MEDIA_TYPE",
      "MCP requests must use application/json",
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MCP_BODY_TIMEOUT_MS);
  timeout.unref();
  try {
    const body = await readBody(
      request,
      maximumBytes,
      controller.signal,
      mcpBodyTimedOut,
    );
    try {
      return JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      throw invalidInput();
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function readSingleImageMultipart(
  request: IncomingMessage,
): Promise<Uint8Array> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw invalidInput();
  }
  const body = await readBody(request, ADMIN_MULTIPART_LIMIT);
  let form: FormData;
  try {
    form = await new Request("http://127.0.0.1/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }).formData();
  } catch {
    throw invalidInput();
  }
  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== "image") {
    throw invalidInput();
  }
  const file = entries[0][1];
  if (typeof file === "string") {
    throw invalidInput();
  }
  if (file.size > MAXIMUM_IMAGE_BYTES) {
    throw new BeautioError("UPLOAD_TOO_LARGE", "image exceeds the 20 MiB limit");
  }
  return new Uint8Array(await file.arrayBuffer());
}

export async function readCodexImageMultipart(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<readonly { readonly source_ref: string; readonly bytes: Uint8Array }[]> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw invalidInput();
  }
  const body = await readBody(request, CODEX_MULTIPART_LIMIT, signal);
  throwIfActionAborted(signal);
  let form: FormData;
  try {
    form = await new Request("http://127.0.0.1/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }).formData();
  } catch {
    throw invalidInput();
  }
  throwIfActionAborted(signal);

  const entries = [...form.entries()];
  if (entries.length < 1 || entries.length > 10) {
    throw invalidInput();
  }
  const sourceRefs = new Set<string>();
  let totalBytes = 0;
  const images: { source_ref: string; bytes: Uint8Array }[] = [];
  for (const [untrustedSourceRef, value] of entries) {
    throwIfActionAborted(signal);
    const parsedSourceRef = sourceRefSchema.safeParse(untrustedSourceRef);
    if (!parsedSourceRef.success || sourceRefs.has(parsedSourceRef.data)) {
      throw invalidInput();
    }
    if (typeof value === "string") {
      throw invalidInput();
    }
    if (value.size > MAXIMUM_IMAGE_BYTES) {
      throw new BeautioError(
        "UPLOAD_TOO_LARGE",
        "image exceeds the 20 MiB limit",
      );
    }
    totalBytes += value.size;
    if (totalBytes > MAXIMUM_UPLOAD_BYTES) {
      throw new BeautioError(
        "UPLOAD_TOO_LARGE",
        "image batch exceeds the 50 MiB limit",
      );
    }
    sourceRefs.add(parsedSourceRef.data);
    const bytes = new Uint8Array(await value.arrayBuffer());
    throwIfActionAborted(signal);
    images.push({
      source_ref: parsedSourceRef.data,
      bytes,
    });
  }
  return images;
}

export function actionTimedOut(): BeautioError {
  return new BeautioError("UPLOAD_FAILED", "Action image upload timed out");
}

function mediaType(contentType: string): string {
  return contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
}

function throwIfActionAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw actionTimedOut();
  }
}

function readBody(
  request: IncomingMessage,
  maximumBytes: number,
  signal?: AbortSignal,
  abortError: () => BeautioError = actionTimedOut,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const removeListeners = (keepErrorListener = false): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      if (!keepErrorListener) {
        request.removeListener("error", onError);
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const rejectAndDrain = (error: BeautioError): void => {
      if (settled) {
        return;
      }
      settled = true;
      chunks.length = 0;
      removeListeners(true);
      request.once("close", () => request.removeListener("error", onError));
      request.resume();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.byteLength;
      if (total > maximumBytes) {
        rejectAndDrain(
          new BeautioError("UPLOAD_TOO_LARGE", "request body is too large"),
        );
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeListeners();
      resolve(Buffer.concat(chunks, total));
    };
    const onError = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      chunks.length = 0;
      removeListeners();
      reject(
        new BeautioError("INVALID_INPUT", "request body could not be read"),
      );
    };
    const onAbort = (): void => rejectAndDrain(abortError());

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
    }
  });
}

function mcpBodyTimedOut(): BeautioError {
  return new BeautioError("INVALID_INPUT", "MCP request body timed out");
}

import {
  createInventoryBatchInputSchema,
  createInventoryBatchOutputSchema,
  getInventoryItemInputSchema,
  getInventoryItemOutputSchema,
  recordProductOpenedInputSchema,
  recordProductOpenedOutputSchema,
  setProductDisplayImageInputSchema,
  setProductDisplayImageOutputSchema,
  sourceRefSchema,
  toolErrorOutputSchema,
  uploadProductImagesOutputSchema,
  type CreateInventoryBatchInput,
  type CreateInventoryBatchOutput,
  type GetInventoryItemOutput,
  type RecordProductOpenedOutput,
  type SetProductDisplayImageOutput,
  type UploadProductImagesOutput,
} from "@beautio/contracts";
import { BeautioError } from "@beautio/domain";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { McpImageBytes } from "./local-image-files.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONFIGURED_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_TOKEN_BYTES = 4 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface OutputSchema<T> {
  parse(value: unknown): T;
}

export interface RemoteBeautioClientOptions {
  readonly origin: string;
  readonly tokenFilePath: string;
  readonly fetchImplementation?: FetchLike;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/**
 * Calls the Action-authenticated Beautio production API without owning domain rules.
 *
 * Instances are created through {@link createRemoteBeautioClient}, which validates
 * the fixed HTTPS origin and reads the Bearer token from a protected local file.
 */
export class RemoteBeautioClient {
  readonly #origin: string;
  readonly #bearerToken: string;
  readonly #fetch: FetchLike;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;

  private constructor(
    origin: string,
    bearerToken: string,
    fetchImplementation: FetchLike,
    requestTimeoutMs: number,
    maxResponseBytes: number,
  ) {
    this.#origin = origin;
    this.#bearerToken = bearerToken;
    this.#fetch = fetchImplementation;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
  }

  /**
   * Creates a client only after validating startup configuration and token-file security.
   *
   * @param options - Fixed origin, credential file, request bounds, and optional fetch seam.
   * @returns A production client that never retries a request automatically.
   */
  static async create(
    options: RemoteBeautioClientOptions,
  ): Promise<RemoteBeautioClient> {
    const origin = validateOrigin(options.origin);
    const requestTimeoutMs = positiveBoundedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      120_000,
      "request timeout",
    );
    const maxResponseBytes = positiveBoundedInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      MAX_CONFIGURED_RESPONSE_BYTES,
      "response byte limit",
    );
    const bearerToken = await readSecureToken(options.tokenFilePath);
    return new RemoteBeautioClient(
      origin,
      bearerToken,
      options.fetchImplementation ?? globalThis.fetch,
      requestTimeoutMs,
      maxResponseBytes,
    );
  }

  /**
   * Records an explicit opening date through the production application boundary.
   *
   * @param untrustedInput - Tool input validated against the shared strict contract.
   * @returns The validated server-confirmed lifecycle state.
   */
  async recordProductOpened(
    untrustedInput: unknown,
  ): Promise<RecordProductOpenedOutput> {
    const input = parseInput(recordProductOpenedInputSchema, untrustedInput);
    const output = await this.#postJson(
      "/api/actions/codex/record-product-opened",
      input,
      recordProductOpenedOutputSchema,
    );
    if (
      output.inventory_item_id !== input.inventory_item_id ||
      output.opened_on !== input.opened_on
    ) {
      throw invalidRemoteResponse();
    }
    return output;
  }

  /**
   * Reads one inventory item from production for an explicit comparison date.
   *
   * @param untrustedInput - Tool input validated against the shared strict contract.
   * @returns The validated production inventory state.
   */
  async getInventoryItem(
    untrustedInput: unknown,
  ): Promise<GetInventoryItemOutput> {
    const input = parseInput(getInventoryItemInputSchema, untrustedInput);
    const output = await this.#postJson(
      "/api/actions/codex/get-inventory-item",
      input,
      getInventoryItemOutputSchema,
    );
    if (output.inventory_item_id !== input.inventory_item_id) {
      throw invalidRemoteResponse();
    }
    return output;
  }

  /**
   * Uploads already-bounded local bytes to production as temporary managed assets.
   *
   * @param images - Confirmed image bytes with unique client references and no paths.
   * @returns Validated production asset identifiers and expiry facts.
   */
  async uploadProductImages(
    images: readonly McpImageBytes[],
  ): Promise<UploadProductImagesOutput> {
    const validatedImages = validateImages(images);
    const form = new FormData();
    for (const image of validatedImages) {
      form.append(
        image.source_ref,
        new Blob([ownedArrayBuffer(image.bytes)]),
        `${image.source_ref}.image`,
      );
    }
    const output = await this.#request(
      "/api/actions/codex/upload-product-images",
      {
        method: "POST",
        headers: { accept: "application/json" },
        body: form,
      },
      uploadProductImagesOutputSchema,
    );
    validateUploadCorrelation(validatedImages, output);
    return output;
  }

  /**
   * Creates a user-confirmed inventory batch through the production application service.
   *
   * @param untrustedInput - Tool input validated against the shared strict contract.
   * @returns The validated committed Product and inventory identifiers.
   */
  async createInventoryBatch(
    untrustedInput: unknown,
  ): Promise<CreateInventoryBatchOutput> {
    const input = parseInput(createInventoryBatchInputSchema, untrustedInput);
    const output = await this.#postJson(
      "/api/actions/create-inventory-batch",
      input,
      createInventoryBatchOutputSchema,
    );
    validateCreateCorrelation(input, output);
    return output;
  }

  /**
   * Replaces the shared display image of one existing production Product.
   *
   * @param untrustedInput - Confirmed Product and temporary image asset identifiers.
   * @returns The validated server-confirmed Product projection.
   */
  async setProductDisplayImage(
    untrustedInput: unknown,
  ): Promise<SetProductDisplayImageOutput> {
    const input = parseInput(setProductDisplayImageInputSchema, untrustedInput);
    const output = await this.#postJson(
      "/api/actions/codex/set-product-display-image",
      input,
      setProductDisplayImageOutputSchema,
    );
    if (
      output.product.product_id !== input.product_id ||
      output.product.image_asset_id !== input.image_asset_id
    ) {
      throw invalidRemoteResponse();
    }
    return output;
  }

  async #postJson<T>(
    path: string,
    body: object,
    outputSchema: OutputSchema<T>,
  ): Promise<T> {
    return this.#request(
      path,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      outputSchema,
    );
  }

  async #request<T>(
    path: string,
    init: RequestInit,
    outputSchema: OutputSchema<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(remoteRequestFailure(true));
      }, this.#requestTimeoutMs);
    });

    const request = this.#performRequest(
      path,
      init,
      outputSchema,
      controller.signal,
    );
    try {
      return await Promise.race([request, deadline]);
    } catch (error) {
      if (error instanceof BeautioError) {
        throw error;
      }
      throw remoteRequestFailure(timedOut);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async #performRequest<T>(
    path: string,
    init: RequestInit,
    outputSchema: OutputSchema<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.#bearerToken}`);
    const response = await this.#fetch(new URL(path, this.#origin), {
      ...init,
      headers,
      signal,
      redirect: "error",
    });
    const body = await readBoundedJson(response, this.#maxResponseBytes);
    if (!response.ok) {
      throw parseRemoteError(body);
    }
    try {
      return outputSchema.parse(body);
    } catch {
      throw invalidRemoteResponse();
    }
  }
}

/**
 * Creates a production API client from one fixed origin and a secure token file.
 *
 * @param options - Startup-only origin, credential file, and optional test seams.
 * @returns A client that performs one bounded, non-retrying HTTPS request per call.
 */
export async function createRemoteBeautioClient(
  options: RemoteBeautioClientOptions,
): Promise<RemoteBeautioClient> {
  return RemoteBeautioClient.create(options);
}

function validateOrigin(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalidOrigin();
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname.length === 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.port.length > 0
  ) {
    throw invalidOrigin();
  }
  return url.origin;
}

async function readSecureToken(filePath: string): Promise<string> {
  if (!isAbsolute(filePath) || typeof process.getuid !== "function") {
    throw invalidTokenFile();
  }

  let handle: FileHandle | undefined;
  try {
    const pathStats = await lstat(filePath);
    if (
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      pathStats.uid !== process.getuid() ||
      (pathStats.mode & 0o777) !== 0o600
    ) {
      throw invalidTokenFile();
    }

    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino ||
      openedStats.uid !== process.getuid() ||
      (openedStats.mode & 0o777) !== 0o600
    ) {
      throw invalidTokenFile();
    }

    const bytes = await readBounded(handle, MAX_TOKEN_BYTES + 1);
    if (bytes.byteLength > MAX_TOKEN_BYTES) {
      throw invalidTokenFile();
    }
    const token = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    if (token.length === 0 || /\s/u.test(token)) {
      throw invalidTokenFile();
    }
    return token;
  } catch {
    throw invalidTokenFile();
  } finally {
    await handle?.close();
  }
}

async function readBounded(
  handle: FileHandle,
  maximumBytes: number,
): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(maximumBytes);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  return bytes.subarray(0, offset);
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType === undefined || mediaType(contentType) !== "application/json") {
    throw invalidRemoteResponse();
  }
  if (response.body === null) {
    throw invalidRemoteResponse();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw invalidRemoteResponse();
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof BeautioError) {
      throw error;
    }
    throw invalidRemoteResponse();
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidRemoteResponse();
  }
}

function mediaType(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim() ?? "";
}

function parseRemoteError(body: unknown): BeautioError {
  if (!isRecord(body) || !("error" in body)) {
    return invalidRemoteResponse();
  }
  const parsed = toolErrorOutputSchema.safeParse(body.error);
  if (!parsed.success) {
    return invalidRemoteResponse();
  }
  if (parsed.data.code === "INTERNAL_ERROR") {
    return remoteRequestFailure(false);
  }
  return new BeautioError(
    parsed.data.code,
    parsed.data.message,
    parsed.data.ref,
  );
}

function validateImages(
  images: readonly McpImageBytes[],
): readonly McpImageBytes[] {
  if (!Array.isArray(images) || images.length < 1 || images.length > 10) {
    throw new BeautioError(
      "INVALID_INPUT",
      "image upload must contain between 1 and 10 images",
    );
  }
  const references = new Set<string>();
  let totalBytes = 0;
  return images.map((image) => {
    if (
      !isRecord(image) ||
      !hasExactKeys(image, ["source_ref", "bytes"]) ||
      !(image.bytes instanceof Uint8Array)
    ) {
      throw new BeautioError(
        "INVALID_INPUT",
        "image upload does not match the tool contract",
      );
    }
    const sourceRef = parseInput(sourceRefSchema, image.source_ref);
    if (references.has(sourceRef)) {
      throw new BeautioError(
        "INVALID_INPUT",
        "image source references must be unique",
      );
    }
    references.add(sourceRef);
    if (image.bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new BeautioError(
        "UPLOAD_TOO_LARGE",
        "image exceeds the 20 MiB limit",
      );
    }
    totalBytes += image.bytes.byteLength;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new BeautioError(
        "UPLOAD_TOO_LARGE",
        "image upload exceeds the 50 MiB total limit",
      );
    }
    return { source_ref: sourceRef, bytes: image.bytes };
  });
}

function validateUploadCorrelation(
  input: readonly McpImageBytes[],
  output: UploadProductImagesOutput,
): void {
  if (output.assets.length !== input.length) {
    throw invalidRemoteResponse();
  }
  const responseReferences = new Set<string>();
  const responseAssetIds = new Set<string>();
  for (const [index, expected] of input.entries()) {
    const actual = output.assets[index];
    if (
      actual === undefined ||
      responseReferences.has(actual.source_ref) ||
      responseAssetIds.has(actual.image_asset_id) ||
      actual.source_ref !== expected.source_ref ||
      actual.byte_size !== expected.bytes.byteLength
    ) {
      throw invalidRemoteResponse();
    }
    responseReferences.add(actual.source_ref);
    responseAssetIds.add(actual.image_asset_id);
  }
}

function validateCreateCorrelation(
  input: CreateInventoryBatchInput,
  output: CreateInventoryBatchOutput,
): void {
  if (
    output.as_of !== input.as_of ||
    output.products.length !== input.products.length ||
    output.inventory_items.length !== input.inventory_items.length
  ) {
    throw invalidRemoteResponse();
  }

  const productIdsByBatchRef = new Map<string, string>();
  const productIds = new Set(
    input.inventory_items.flatMap((item) =>
      item.product_ref.kind === "existing"
        ? [item.product_ref.product_id]
        : [],
    ),
  );
  for (const [index, expected] of input.products.entries()) {
    const actual = output.products[index];
    if (
      actual === undefined ||
      actual.batch_ref !== expected.batch_ref ||
      actual.ingredient_list_text !== (expected.ingredient_list_text ?? null) ||
      actual.shared_notes !== (expected.shared_notes ?? null) ||
      productIdsByBatchRef.has(actual.batch_ref) ||
      productIds.has(actual.product_id)
    ) {
      throw invalidRemoteResponse();
    }
    productIdsByBatchRef.set(actual.batch_ref, actual.product_id);
    productIds.add(actual.product_id);
  }

  const inventoryItemIds = new Set<string>();
  for (const [index, expected] of input.inventory_items.entries()) {
    const actual = output.inventory_items[index];
    if (
      actual === undefined ||
      actual.batch_ref !== expected.batch_ref ||
      actual.custom_notes !== (expected.custom_notes ?? null) ||
      inventoryItemIds.has(actual.inventory_item_id)
    ) {
      throw invalidRemoteResponse();
    }
    inventoryItemIds.add(actual.inventory_item_id);

    const expectedProductId =
      expected.product_ref.kind === "existing"
        ? expected.product_ref.product_id
        : productIdsByBatchRef.get(expected.product_ref.batch_ref);
    if (
      expectedProductId === undefined ||
      actual.product_id !== expectedProductId
    ) {
      throw invalidRemoteResponse();
    }
  }
}

function parseInput<T>(schema: OutputSchema<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new BeautioError("INVALID_INPUT", "input does not match the tool contract");
  }
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function positiveBoundedInteger(
  value: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Beautio ${label} is invalid`);
  }
  return value;
}

function invalidOrigin(): Error {
  return new Error(
    "BEAUTIO_REMOTE_ORIGIN must be a bare HTTPS origin without a non-default port",
  );
}

function invalidTokenFile(): Error {
  return new Error("Beautio Action token file is not a secure regular file");
}

function invalidRemoteResponse(): BeautioError {
  return new BeautioError(
    "INTERNAL_ERROR",
    "The Beautio service returned an invalid response.",
  );
}

function remoteRequestFailure(timedOut: boolean): BeautioError {
  return new BeautioError(
    "INTERNAL_ERROR",
    timedOut
      ? "The Beautio service request timed out."
      : "The Beautio service request could not be completed.",
  );
}

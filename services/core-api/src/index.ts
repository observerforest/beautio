import type {
  ImageAssetReadVariant,
  InventoryApplicationService,
} from "@beautio/application";
import { sourceRefSchema } from "@beautio/contracts";
import { BeautioError, type BeautioErrorCode } from "@beautio/domain";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { z } from "zod";
import {
  downloadActionImages,
  type ActionFileReference,
  type DownloadedActionImage,
} from "./action-download.ts";
import { createBeautioActionsOpenApiV1 } from "./openapi.ts";
import {
  createStaticWebRoot,
  tryServeStaticWeb,
  type StaticWebRoot,
} from "./static-web.ts";
import type { ReadOnlyMcpRoute } from "./read-only-mcp.ts";

const JSON_BODY_LIMIT = 1024 * 1024;
const ADMIN_MULTIPART_LIMIT = 21 * 1024 * 1024;
const CODEX_MULTIPART_LIMIT = 51 * 1024 * 1024;
const MAXIMUM_IMAGE_BYTES = 20 * 1024 * 1024;
const MAXIMUM_UPLOAD_BYTES = 50 * 1024 * 1024;
const ACTION_UPLOAD_TIMEOUT_MS = 40_000;
const MCP_BODY_TIMEOUT_MS = 10_000;

const actionFileRequestSchema = z
  .object({
    openaiFileIdRefs: z
      .array(
        z
          .object({
            name: z.string().min(1),
            id: sourceRefSchema,
            mime_type: z.string().min(1),
            download_link: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

export interface CoreApiHandlerOptions {
  readonly actionBearerToken: string;
  readonly adminBearerToken: string;
  readonly actionFileHosts: ReadonlySet<string>;
  readonly actionDownloader?: (
    references: readonly ActionFileReference[],
    allowedHosts: ReadonlySet<string>,
    signal: AbortSignal,
  ) => Promise<readonly DownloadedActionImage[]>;
  readonly actionUploadTimeoutMs?: number;
  readonly publicOrigin?: string;
  readonly webRoot?: string;
  readonly readOnlyMcp?: ReadOnlyMcpRoute;
}

/**
 * Creates the authenticated HTTP adapter around the shared application service.
 *
 * @param application - Shared use cases also called by stdio MCP.
 * @param options - Separate Action/Admin keys and approved Action file hosts.
 * @returns A Node request listener exposing health, Actions, and management routes.
 */
export function createCoreApiHandler(
  application: InventoryApplicationService,
  options: CoreApiHandlerOptions,
): RequestListener {
  const configuration = validateOptions(options);
  return (request, response) => {
    void routeRequest(application, configuration, request, response).catch(
      (error: unknown) => {
        if (!response.headersSent) {
          sendError(response, error);
          return;
        }
        response.destroy();
      },
    );
  };
}

async function routeRequest(
  application: InventoryApplicationService,
  options: ValidatedOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { status: "ok", mode: "managed" });
    return;
  }
  if (url.pathname === "/mcp") {
    if (options.readOnlyMcp === null) {
      sendNotFound(response);
      return;
    }
    await options.readOnlyMcp.handleRequest(request, response, () =>
      readMcpJson(request, JSON_BODY_LIMIT),
    );
    return;
  }
  if (
    request.method === "GET" &&
    url.pathname === "/openapi/beautio-actions-v1.json"
  ) {
    requireBearer(request, options.actionBearerToken);
    sendJson(
      response,
      200,
      createBeautioActionsOpenApiV1(options.publicOrigin),
    );
    return;
  }

  if (isReservedPath(url.pathname, "/api/actions")) {
    requireBearer(request, options.actionBearerToken);
  } else if (isReservedPath(url.pathname, "/api")) {
    requireBearer(request, options.adminBearerToken);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/actions/upload-product-images"
  ) {
    const output = await withActionUploadDeadline(
      options.actionUploadTimeoutMs,
      async (signal) => {
        const body = actionFileRequestSchema.safeParse(
          await abortableActionOperation(
            readJson(request, JSON_BODY_LIMIT, signal),
            signal,
          ),
        );
        if (!body.success) {
          throw invalidInput();
        }
        const downloaded = await abortableActionOperation(
          options.actionDownloader(
            body.data.openaiFileIdRefs,
            options.actionFileHosts,
            signal,
          ),
          signal,
        );
        return application.uploadProductImages(downloaded, { signal });
      },
    );
    sendJson(response, 200, output);
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/actions/create-inventory-batch"
  ) {
    sendJson(
      response,
      200,
      await application.createInventoryBatch(
        await readJson(request, JSON_BODY_LIMIT),
      ),
    );
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/actions/codex/upload-product-images"
  ) {
    const output = await withActionUploadDeadline(
      options.actionUploadTimeoutMs,
      async (signal) => {
        const images = await abortableActionOperation(
          readCodexImageMultipart(request, signal),
          signal,
        );
        return application.uploadProductImages(images, { signal });
      },
    );
    sendJson(response, 200, output);
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/actions/codex/record-product-opened"
  ) {
    sendJson(
      response,
      200,
      await application.recordProductOpened(
        await readJson(request, JSON_BODY_LIMIT),
      ),
    );
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/actions/codex/get-inventory-item"
  ) {
    sendJson(
      response,
      200,
      await application.getInventoryItem(
        await readJson(request, JSON_BODY_LIMIT),
      ),
    );
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/actions/codex/set-product-display-image"
  ) {
    sendJson(
      response,
      200,
      await application.setProductDisplayImage(
        await readJson(request, JSON_BODY_LIMIT),
      ),
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/inventory") {
    sendJson(
      response,
      200,
      await application.listInventory({ as_of: url.searchParams.get("as_of") }),
    );
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/image-assets"
  ) {
    const bytes = await readSingleImageMultipart(request);
    const uploaded = await application.uploadProductImages([
      { source_ref: "admin_image", bytes },
    ]);
    const asset = uploaded.assets[0];
    if (asset === undefined) {
      throw new BeautioError("INTERNAL_ERROR", "image upload returned no asset");
    }
    sendJson(response, 200, {
      asset: {
        image_asset_id: asset.image_asset_id,
        media_type: asset.media_type,
        byte_size: asset.byte_size,
        expires_at: asset.expires_at,
      },
    });
    return;
  }

  const productId = routeId(url.pathname, "/api/admin/products/", "");
  if (request.method === "PUT" && productId !== null) {
    sendJson(
      response,
      200,
      await application.updateProduct(
        productId,
        await readJson(request, JSON_BODY_LIMIT),
      ),
    );
    return;
  }

  const inventoryItemId = routeId(
    url.pathname,
    "/api/admin/inventory-items/",
    "/facts",
  );
  if (request.method === "PUT" && inventoryItemId !== null) {
    sendJson(
      response,
      200,
      await application.updateInventoryItemFacts(
        inventoryItemId,
        await readJson(request, JSON_BODY_LIMIT),
      ),
    );
    return;
  }

  const customNotesInventoryItemId = routeId(
    url.pathname,
    "/api/admin/inventory-items/",
    "/custom-notes",
  );
  if (request.method === "PUT" && customNotesInventoryItemId !== null) {
    sendJson(
      response,
      200,
      await application.updateInventoryItemCustomNotes(
        customNotesInventoryItemId,
        await readJson(request, JSON_BODY_LIMIT),
      ),
    );
    return;
  }

  const imageAssetId = routeId(
    url.pathname,
    "/api/image-assets/",
    "/content",
  );
  if (request.method === "GET" && imageAssetId !== null) {
    const image = await application.readImageAsset(
      imageAssetId,
      parseImageAssetVariant(url.searchParams),
    );
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": String(image.bytes.byteLength),
      "content-type": image.media_type,
      "x-content-type-options": "nosniff",
    });
    response.end(image.bytes);
    return;
  }

  if (isReservedPath(url.pathname, "/api")) {
    throw new BeautioError("INVALID_INPUT", "route or method is not supported");
  }
  if (isReservedPath(url.pathname, "/openapi")) {
    sendNotFound(response);
    return;
  }
  if (isReservedPath(url.pathname, "/mcp")) {
    sendNotFound(response);
    return;
  }
  if (
    options.staticWebRoot !== null &&
    (await tryServeStaticWeb(
      options.staticWebRoot,
      url.pathname,
      request.method,
      response,
    ))
  ) {
    return;
  }
  sendNotFound(response);
}

function parseImageAssetVariant(
  searchParams: URLSearchParams,
): ImageAssetReadVariant {
  const variants = searchParams.getAll("variant");
  if (variants.length === 0) {
    return "original";
  }
  if (variants.length !== 1 || variants[0] !== "card") {
    throw new BeautioError(
      "INVALID_INPUT",
      "image variant must be exactly card when provided",
    );
  }
  return "card";
}

function sendNotFound(response: ServerResponse): void {
  sendJson(response, 404, {
    error: { code: "INVALID_INPUT", message: "Route not found." },
  });
}

interface ValidatedOptions {
  readonly actionBearerToken: string;
  readonly adminBearerToken: string;
  readonly actionFileHosts: ReadonlySet<string>;
  readonly actionDownloader: (
    references: readonly ActionFileReference[],
    allowedHosts: ReadonlySet<string>,
    signal: AbortSignal,
  ) => Promise<readonly DownloadedActionImage[]>;
  readonly actionUploadTimeoutMs: number;
  readonly publicOrigin: string | undefined;
  readonly staticWebRoot: StaticWebRoot | null;
  readonly readOnlyMcp: ReadOnlyMcpRoute | null;
}

function validateOptions(options: CoreApiHandlerOptions): ValidatedOptions {
  const actionBearerToken = options.actionBearerToken.trim();
  const adminBearerToken = options.adminBearerToken.trim();
  if (actionBearerToken.length === 0 || adminBearerToken.length === 0) {
    throw new Error("both Beautio HTTP bearer tokens are required");
  }
  if (tokensEqual(actionBearerToken, adminBearerToken)) {
    throw new Error("Beautio HTTP bearer tokens must be different");
  }
  if (options.actionFileHosts.size === 0) {
    throw new Error("at least one Action file host is required");
  }
  return {
    actionBearerToken,
    adminBearerToken,
    actionFileHosts: new Set(options.actionFileHosts),
    actionDownloader:
      options.actionDownloader ??
      ((references, allowedHosts, signal) =>
        downloadActionImages(
          references,
          allowedHosts,
          undefined,
          undefined,
          { signal },
        )),
    actionUploadTimeoutMs: positiveTimeout(
      options.actionUploadTimeoutMs,
      ACTION_UPLOAD_TIMEOUT_MS,
    ),
    publicOrigin: validatePublicOrigin(options.publicOrigin),
    staticWebRoot:
      options.webRoot === undefined
        ? null
        : createStaticWebRoot(options.webRoot),
    readOnlyMcp: options.readOnlyMcp ?? null,
  };
}

async function withActionUploadDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref();
  try {
    return await abortableActionOperation(
      operation(controller.signal),
      controller.signal,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function abortableActionOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(actionTimedOut());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(actionTimedOut());
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

function actionTimedOut(): BeautioError {
  return new BeautioError("UPLOAD_FAILED", "Action image upload timed out");
}

function requireBearer(request: IncomingMessage, expectedToken: string): void {
  const header = request.headers.authorization;
  const match = header === undefined ? null : /^Bearer ([^\s]+)$/i.exec(header);
  if (match === null || !tokensEqual(match[1] ?? "", expectedToken)) {
    throw new BeautioError("UNAUTHORIZED", "valid bearer authorization is required");
  }
}

function tokensEqual(first: string, second: string): boolean {
  const firstBytes = Buffer.from(first);
  const secondBytes = Buffer.from(second);
  return (
    firstBytes.byteLength === secondBytes.byteLength &&
    timingSafeEqual(firstBytes, secondBytes)
  );
}

async function readJson(
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

async function readMcpJson(
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

function mediaType(contentType: string): string {
  return contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
}

async function readSingleImageMultipart(
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

async function readCodexImageMultipart(
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

function routeId(pathname: string, prefix: string, suffix: string): string | null {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  const end = suffix.length === 0 ? pathname.length : pathname.length - suffix.length;
  const encoded = pathname.slice(prefix.length, end);
  if (encoded.length === 0 || encoded.includes("/")) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length === 0 ? null : decoded;
  } catch {
    return null;
  }
}

function sendError(response: ServerResponse, error: unknown): void {
  if (!(error instanceof BeautioError)) {
    sendJson(response, 500, {
      error: { code: "INTERNAL_ERROR", message: "The request could not be completed." },
    });
    return;
  }
  sendJson(response, statusFor(error.code), {
    error: {
      code: error.code,
      message: error.message,
      ...(error.ref === undefined ? {} : { ref: error.ref }),
    },
  });
}

function statusFor(code: BeautioErrorCode): number {
  switch (code) {
    case "INVALID_INPUT":
    case "FILE_SOURCE_REJECTED":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "PRODUCT_NOT_FOUND":
    case "INVENTORY_ITEM_NOT_FOUND":
    case "IMAGE_ASSET_NOT_FOUND":
      return 404;
    case "INVENTORY_ITEM_TERMINAL":
    case "OPENED_ON_CONFLICT":
    case "IMAGE_ASSET_EXPIRED":
    case "BATCH_CONFLICT":
      return 409;
    case "UPLOAD_TOO_LARGE":
      return 413;
    case "UNSUPPORTED_MEDIA_TYPE":
      return 415;
    case "UPLOAD_FAILED":
      return 502;
    case "INTERNAL_ERROR":
      return 500;
  }
}

function invalidInput(): BeautioError {
  return new BeautioError("INVALID_INPUT", "input does not match the HTTP contract");
}

function isReservedPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function validatePublicOrigin(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("BEAUTIO_PUBLIC_ORIGIN must be an HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("BEAUTIO_PUBLIC_ORIGIN must be an HTTPS origin");
  }
  return url.origin;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-beautio-mode": "managed",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

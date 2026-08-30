import type {
  ImageAssetReadVariant,
  InventoryApplicationService,
} from "@beautio/application";
import { sourceRefSchema } from "@beautio/contracts";
import { BeautioError } from "@beautio/domain";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type {
  ActionFileReference,
  DownloadedActionImage,
} from "./action-download.ts";
import { requireBearer } from "./bearer.ts";
import {
  JSON_BODY_LIMIT,
  readCodexImageMultipart,
  readJson,
  readMcpJson,
  readSingleImageMultipart,
  readStreamingJson,
} from "./body.ts";
import { createBeautioActionsOpenApiV1 } from "./openapi.ts";
import { invalidInput, sendJson, sendNotFound } from "./responses.ts";
import type { ReadOnlyMcpRoute } from "./read-only-mcp.ts";
import { tryServeStaticWeb, type StaticWebRoot } from "./static-web.ts";

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
const BACKUP_BODY_LIMIT = 280 * 1024 * 1024;

export interface ValidatedOptions {
  readonly actionBearerToken: string;
  readonly adminBearerToken: string;
  readonly actionFileHosts: ReadonlySet<string>;
  readonly actionDownloader: (
    references: readonly ActionFileReference[],
    allowedHosts: ReadonlySet<string>,
    signal: AbortSignal,
  ) => Promise<readonly DownloadedActionImage[]>;
  readonly actionUploadTimeoutMs: number;
  readonly backupOperationTimeoutMs: number;
  readonly publicOrigin: string | undefined;
  readonly staticWebRoot: StaticWebRoot | null;
  readonly readOnlyMcp: ReadOnlyMcpRoute | null;
}

export interface RouteRequestDependencies {
  readonly withActionUploadDeadline: <T>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  readonly abortableActionOperation: <T>(
    operation: Promise<T>,
    signal: AbortSignal,
  ) => Promise<T>;
  readonly withExclusiveOperation: <T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  readonly withBackupDeadline: <T>(
    timeoutMs: number,
    externalSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
}

export async function routeRequest(
  application: InventoryApplicationService,
  options: ValidatedOptions,
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: RouteRequestDependencies,
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

  const execute = (backupSignal?: AbortSignal): Promise<void> =>
    routeAuthorizedRequest(
      application,
      options,
      request,
      response,
      dependencies,
      url,
      backupSignal,
    );
  if (isBackupRoute(request.method, url.pathname)) {
    await withRequestBackupCancellation(request, response, (externalSignal) =>
      dependencies.withBackupDeadline(
        options.backupOperationTimeoutMs,
        externalSignal,
        (backupSignal) =>
          dependencies.withExclusiveOperation(
            () => execute(backupSignal),
            backupSignal,
          ),
      ),
    );
    return;
  }
  if (isExclusiveWriteRoute(request.method, url.pathname)) {
    await dependencies.withExclusiveOperation(() => execute());
    return;
  }
  await execute();
}

async function routeAuthorizedRequest(
  application: InventoryApplicationService,
  options: ValidatedOptions,
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: RouteRequestDependencies,
  url: URL,
  backupSignal?: AbortSignal,
): Promise<void> {

  if (
    request.method === "POST" &&
    url.pathname === "/api/actions/upload-product-images"
  ) {
    const output = await dependencies.withActionUploadDeadline(
      options.actionUploadTimeoutMs,
      async (signal) => {
        const body = actionFileRequestSchema.safeParse(
          await dependencies.abortableActionOperation(
            readJson(request, JSON_BODY_LIMIT, signal),
            signal,
          ),
        );
        if (!body.success) {
          throw invalidInput();
        }
        const downloaded = await dependencies.abortableActionOperation(
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
    const output = await dependencies.withActionUploadDeadline(
      options.actionUploadTimeoutMs,
      async (signal) => {
        const images = await dependencies.abortableActionOperation(
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

  if (request.method === "GET" && url.pathname === "/api/admin/backup") {
    const plan = await application.prepareBackupExport(
      backupSignal === undefined ? {} : { signal: backupSignal },
    );
    const date = plan.createdAt.slice(0, 10);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="beautio-backup-${date}.beautio-backup"`,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    await plan.writeTo(
      (chunk) => writeResponseChunk(response, chunk, backupSignal),
      backupSignal === undefined ? {} : { signal: backupSignal },
    );
    response.end();
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/admin/backup") {
    sendJson(
      response,
      200,
      await application.restoreBackup(
        await readStreamingJson(request, BACKUP_BODY_LIMIT, backupSignal),
        backupSignal === undefined ? {} : { signal: backupSignal },
      ),
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

function isBackupRoute(method: string | undefined, pathname: string): boolean {
  return pathname === "/api/admin/backup" && (method === "GET" || method === "PUT");
}

function isExclusiveWriteRoute(
  method: string | undefined,
  pathname: string,
): boolean {
  if (method === "POST") {
    return (
      pathname === "/api/actions/upload-product-images" ||
      pathname === "/api/actions/create-inventory-batch" ||
      pathname === "/api/actions/codex/upload-product-images" ||
      pathname === "/api/actions/codex/record-product-opened" ||
      pathname === "/api/actions/codex/set-product-display-image" ||
      pathname === "/api/admin/image-assets"
    );
  }
  return (
    method === "PUT" &&
    (pathname.startsWith("/api/admin/products/") ||
      pathname.startsWith("/api/admin/inventory-items/"))
  );
}

async function withRequestBackupCancellation<T>(
  request: IncomingMessage,
  response: ServerResponse,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.once("aborted", abort);
  response.once("close", abort);
  try {
    return await operation(controller.signal);
  } finally {
    request.removeListener("aborted", abort);
    response.removeListener("close", abort);
  }
}

function writeResponseChunk(
  response: ServerResponse,
  chunk: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(new Error("backup response was aborted"));
  }
  if (response.write(chunk)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.removeListener("drain", drained);
      response.removeListener("close", closed);
      signal?.removeEventListener("abort", aborted);
    };
    const drained = (): void => {
      cleanup();
      resolve();
    };
    const closed = (): void => {
      cleanup();
      reject(new Error("backup response closed before draining"));
    };
    const aborted = (): void => {
      cleanup();
      reject(new Error("backup response was aborted"));
    };
    response.once("drain", drained);
    response.once("close", closed);
    signal?.addEventListener("abort", aborted, { once: true });
  });
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

function routeId(
  pathname: string,
  prefix: string,
  suffix: string,
): string | null {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }
  const end =
    suffix.length === 0 ? pathname.length : pathname.length - suffix.length;
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

function isReservedPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

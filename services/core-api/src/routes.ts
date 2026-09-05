import type {
  ImageAssetReadVariant,
  InventoryApplicationService,
} from "@beautio/application";
import { BeautioError } from "@beautio/domain";
import type { IncomingMessage, ServerResponse } from "node:http";
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
  throwIfRequestAborted,
} from "./body.ts";
import { createBeautioActionsOpenApiV1 } from "./openapi.ts";
import { routeId } from "./path-segment.ts";
import { invalidInput, sendJson, sendNotFound } from "./responses.ts";
import type { ReadOnlyMcpRoute } from "./read-only-mcp.ts";
import { tryServeStaticWeb, type StaticWebRoot } from "./static-web.ts";
import type { WritePreparationPermit } from "./write-preparation-gate.ts";
import type { CustomGptReadRoute } from "./custom-gpt-read-route.ts";
import { closeIncompleteRequestAfterResponse } from "./incomplete-request.ts";
import {
  isCustomGptFactActionPath,
  type CustomGptFactActionRoute,
} from "./custom-gpt-fact-action-route.ts";
import { sendCustomGptFactActionNotFound } from "./custom-gpt-fact-action-errors.ts";
import {
  isCustomGptCreateActionPath,
  type CustomGptCreateActionRoute,
} from "./custom-gpt-create-action-route.ts";
import { sendCustomGptCreateActionNotFound } from "./custom-gpt-create-action-errors.ts";
import {
  isCustomGptImageActionPath,
  type CustomGptImageActionRoute,
} from "./custom-gpt-image-action-route.ts";
import { sendCustomGptImageActionNotFound } from "./custom-gpt-image-action-errors.ts";
const BACKUP_BODY_LIMIT = 280 * 1024 * 1024;

export interface ValidatedOptions {
  readonly customGptBearerToken: string;
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
  readonly writeBodyTimeoutMs: number;
  readonly publicOrigin: string | undefined;
  readonly staticWebRoot: StaticWebRoot | null;
  readonly readOnlyMcp: ReadOnlyMcpRoute | null;
  readonly customGptReadRoute: CustomGptReadRoute | null;
  readonly customGptFactActionRoute: CustomGptFactActionRoute | null;
  readonly customGptCreateActionRoute: CustomGptCreateActionRoute | null;
  readonly customGptImageActionRoute: CustomGptImageActionRoute | null;
}

export interface RouteRequestDependencies {
  readonly withActionUploadDeadline: <T>(
    timeoutMs: number,
    externalSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  readonly acquireWritePreparation: (
    signal: AbortSignal,
  ) => Promise<WritePreparationPermit>;
  readonly withExclusiveOperation: <T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  readonly withBackupDeadline: <T>(
    timeoutMs: number,
    externalSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  readonly withWriteBodyDeadline: <T>(
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
    requireBearer(request, options.customGptBearerToken);
    sendJson(
      response,
      200,
      createBeautioActionsOpenApiV1(options.publicOrigin),
    );
    return;
  }

  if (isReservedPath(url.pathname, "/api/actions/codex")) {
    requireBearer(request, options.actionBearerToken);
  } else if (isReservedPath(url.pathname, "/api/actions")) {
    requireBearer(request, options.customGptBearerToken);
  } else if (isReservedPath(url.pathname, "/api")) {
    requireBearer(request, options.adminBearerToken);
  }

  const execute = (
    backupSignal?: AbortSignal,
    requestSignal?: AbortSignal,
  ): Promise<void> =>
    routeAuthorizedRequest(
      application,
      options,
      request,
      response,
      dependencies,
      url,
      backupSignal,
      requestSignal,
    );
  if (request.method === "PUT" && url.pathname === "/api/admin/backup") {
    await withRequestCancellation(request, response, (externalSignal) =>
      dependencies.withBackupDeadline(
        options.backupOperationTimeoutMs,
        externalSignal,
        async (backupSignal) => {
          const prepared = application.prepareBackupRestore(
            await readStreamingJson(request, BACKUP_BODY_LIMIT, backupSignal),
          );
          await dependencies.withExclusiveOperation(async () => {
            sendJson(
              response,
              200,
              await application.restorePreparedBackup(prepared, {
                signal: backupSignal,
              }),
            );
          }, backupSignal);
        },
      ),
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/admin/backup") {
    await withRequestCancellation(request, response, (externalSignal) =>
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
  await withRequestCancellation(request, response, (signal) =>
    execute(undefined, signal),
  );
}

async function routeAuthorizedRequest(
  application: InventoryApplicationService,
  options: ValidatedOptions,
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: RouteRequestDependencies,
  url: URL,
  backupSignal?: AbortSignal,
  requestSignal?: AbortSignal,
): Promise<void> {

  if (url.pathname.startsWith("/api/actions/")) {
    const signal = requireRequestSignal(requestSignal);
    if (options.customGptImageActionRoute !== null) {
      const handled = await options.customGptImageActionRoute.handleRequest(
        request,
        response,
        url,
        dependencies,
        options.writeBodyTimeoutMs,
        options.actionUploadTimeoutMs,
        signal,
      );
      if (handled) return;
    } else if (isCustomGptImageActionPath(url.pathname)) {
      closeIncompleteRequestAfterResponse(request, response);
      sendCustomGptImageActionNotFound(response);
      return;
    }
    if (options.customGptCreateActionRoute !== null) {
      const handled = await options.customGptCreateActionRoute.handleRequest(
        request,
        response,
        url,
        dependencies,
        options.writeBodyTimeoutMs,
        signal,
      );
      if (handled) return;
    } else if (isCustomGptCreateActionPath(url.pathname)) {
      closeIncompleteRequestAfterResponse(request, response);
      sendCustomGptCreateActionNotFound(response);
      return;
    }
    if (options.customGptFactActionRoute !== null) {
      const handled = await options.customGptFactActionRoute.handleRequest(
        request,
        response,
        url,
        dependencies,
        options.writeBodyTimeoutMs,
        signal,
      );
      if (handled) return;
    } else if (isCustomGptFactActionPath(url.pathname)) {
      closeIncompleteRequestAfterResponse(request, response);
      sendCustomGptFactActionNotFound(response);
      return;
    }
  }

  if (options.customGptReadRoute !== null && url.pathname.startsWith("/api/actions/")) {
    const signal = requireRequestSignal(requestSignal);
    const handled = await options.customGptReadRoute.handleRequest(
      request, response, url,
      (maximumBytes) => dependencies.withWriteBodyDeadline(
        options.writeBodyTimeoutMs, signal,
        (bodySignal) => readJson(request, maximumBytes, bodySignal),
      ), signal,
    );
    if (handled) return;
  }

  if (
    request.method === "POST" &&
    (url.pathname === "/api/actions/codex/create-inventory-batch" ||
      url.pathname === "/api/admin/create-inventory-batch")
  ) {
    const signal = requireRequestSignal(requestSignal);
    const prepared = await prepareOrdinaryWrite(
      request,
      response,
      options,
      dependencies,
      signal,
      (preparationSignal) =>
        readJson(request, JSON_BODY_LIMIT, preparationSignal),
    );
    sendJson(
      response,
      200,
      await commitPreparedWrite(
        prepared,
        dependencies,
        signal,
        (body) => application.createInventoryBatch(body),
      ),
    );
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/actions/codex/upload-product-images"
  ) {
    const signal = requireRequestSignal(requestSignal);
    const output = await runActionPreparedWrite(
      request,
      response,
      options,
      dependencies,
      signal,
      async (operationSignal) =>
        application.prepareProductImages(
          await readCodexImageMultipart(request, operationSignal),
          { signal: operationSignal },
        ),
      (prepared, operationSignal) =>
        application.commitPreparedProductImages(prepared, {
          signal: operationSignal,
        }),
      (prepared) => application.discardPreparedProductImages(prepared),
    );
    sendJson(response, 200, output);
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/actions/codex/record-product-opened"
  ) {
    const signal = requireRequestSignal(requestSignal);
    const prepared = await prepareOrdinaryWrite(
      request,
      response,
      options,
      dependencies,
      signal,
      (preparationSignal) =>
        readJson(request, JSON_BODY_LIMIT, preparationSignal),
    );
    sendJson(
      response,
      200,
      await commitPreparedWrite(
        prepared,
        dependencies,
        signal,
        (body) =>
          application.recordProductOpened(
            addLegacyOpeningAccuracyWhenMissing(body),
          ),
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
    const signal = requireRequestSignal(requestSignal);
    const prepared = await prepareOrdinaryWrite(
      request,
      response,
      options,
      dependencies,
      signal,
      (preparationSignal) =>
        readJson(request, JSON_BODY_LIMIT, preparationSignal),
    );
    sendJson(
      response,
      200,
      await commitPreparedWrite(
        prepared,
        dependencies,
        signal,
        (body) => application.setProductDisplayImage(body),
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

  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/image-assets"
  ) {
    const signal = requireRequestSignal(requestSignal);
    const bodyPrepared = await prepareOrdinaryWrite(
      request,
      response,
      options,
      dependencies,
      signal,
      (preparationSignal) =>
        readSingleImageMultipart(request, preparationSignal),
    );
    const prepared = await continuePreparedWrite(
      bodyPrepared,
      signal,
      (bytes, semanticSignal) =>
        application.prepareProductImages(
          [{ source_ref: "admin_image", bytes }],
          { signal: semanticSignal },
        ),
    );
    const uploaded = await commitPreparedWrite(
      prepared,
      dependencies,
      signal,
      (semanticPrepared) =>
        application.commitPreparedProductImages(semanticPrepared, { signal }),
      (semanticPrepared) =>
        application.discardPreparedProductImages(semanticPrepared),
    );
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
    const signal = requireRequestSignal(requestSignal);
    const prepared = await prepareOrdinaryWrite(
      request,
      response,
      options,
      dependencies,
      signal,
      (preparationSignal) =>
        readJson(request, JSON_BODY_LIMIT, preparationSignal),
    );
    sendJson(
      response,
      200,
      await commitPreparedWrite(
        prepared,
        dependencies,
        signal,
        (body) => application.updateProduct(productId, body),
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
    const signal = requireRequestSignal(requestSignal);
    const prepared = await prepareOrdinaryWrite(
      request,
      response,
      options,
      dependencies,
      signal,
      (preparationSignal) =>
        readJson(request, JSON_BODY_LIMIT, preparationSignal),
    );
    sendJson(
      response,
      200,
      await commitPreparedWrite(
        prepared,
        dependencies,
        signal,
        (body) => application.updateInventoryItemFacts(inventoryItemId, body),
      ),
    );
    return;
  }

  const endUseInventoryItemId = routeId(
    url.pathname,
    "/api/admin/inventory-items/",
    "/end-use",
  );
  if (request.method === "POST" && endUseInventoryItemId !== null) {
    const signal = requireRequestSignal(requestSignal);
    const prepared = await prepareOrdinaryWrite(
      request,
      response,
      options,
      dependencies,
      signal,
      (preparationSignal) =>
        readJson(request, JSON_BODY_LIMIT, preparationSignal),
    );
    sendJson(
      response,
      200,
      await commitPreparedWrite(
        prepared,
        dependencies,
        signal,
        (body) => application.endInventoryItem(endUseInventoryItemId, body),
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
    const signal = requireRequestSignal(requestSignal);
    const prepared = await prepareOrdinaryWrite(
      request,
      response,
      options,
      dependencies,
      signal,
      (preparationSignal) =>
        readJson(request, JSON_BODY_LIMIT, preparationSignal),
    );
    sendJson(
      response,
      200,
      await commitPreparedWrite(
        prepared,
        dependencies,
        signal,
        (body) =>
          application.updateInventoryItemCustomNotes(
            customNotesInventoryItemId,
            body,
          ),
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

interface PreparedWrite<T> {
  readonly value: T;
  readonly permit: WritePreparationPermit;
}

async function prepareOrdinaryWrite<T>(
  request: IncomingMessage,
  response: ServerResponse,
  options: ValidatedOptions,
  dependencies: RouteRequestDependencies,
  requestSignal: AbortSignal,
  prepare: (signal: AbortSignal) => Promise<T>,
): Promise<PreparedWrite<T>> {
  let acquiredPermit: WritePreparationPermit | undefined;
  try {
    return await dependencies.withWriteBodyDeadline(
      options.writeBodyTimeoutMs,
      requestSignal,
      async (preparationSignal) => {
        acquiredPermit = await dependencies.acquireWritePreparation(
          preparationSignal,
        );
        const value = await prepare(preparationSignal);
        throwIfRequestAborted(preparationSignal);
        return { value, permit: acquiredPermit };
      },
    );
  } catch (error) {
    acquiredPermit?.release();
    closeIncompleteRequestAfterResponse(request, response);
    throw error;
  }
}

async function commitPreparedWrite<T, R>(
  prepared: PreparedWrite<T>,
  dependencies: RouteRequestDependencies,
  requestSignal: AbortSignal,
  commit: (value: T) => Promise<R>,
  discard?: (value: T) => void,
): Promise<R> {
  try {
    return await dependencies.withExclusiveOperation(
      () => commit(prepared.value),
      requestSignal,
    );
  } finally {
    try {
      discard?.(prepared.value);
    } finally {
      prepared.permit.release();
    }
  }
}

async function continuePreparedWrite<T, R>(
  prepared: PreparedWrite<T>,
  requestSignal: AbortSignal,
  continuation: (value: T, signal: AbortSignal) => Promise<R>,
): Promise<PreparedWrite<R>> {
  try {
    const value = await continuation(prepared.value, requestSignal);
    return { value, permit: prepared.permit };
  } catch (error) {
    prepared.permit.release();
    throw error;
  }
}

async function runActionPreparedWrite<T, R>(
  request: IncomingMessage,
  response: ServerResponse,
  options: ValidatedOptions,
  dependencies: RouteRequestDependencies,
  requestSignal: AbortSignal,
  prepare: (signal: AbortSignal) => Promise<T>,
  commit: (value: T, signal: AbortSignal) => Promise<R>,
  discard?: (value: T) => void,
): Promise<R> {
  return dependencies.withActionUploadDeadline(
    options.actionUploadTimeoutMs,
    requestSignal,
    async (operationSignal) => {
      let permit: WritePreparationPermit | undefined;
      let preparationComplete = false;
      let preparedValue: { readonly value: T } | undefined;
      try {
        permit = await dependencies.acquireWritePreparation(operationSignal);
        preparedValue = { value: await prepare(operationSignal) };
        throwIfRequestAborted(operationSignal);
        preparationComplete = true;
        const value = preparedValue.value;
        return await dependencies.withExclusiveOperation(
          () => commit(value, operationSignal),
          operationSignal,
        );
      } catch (error) {
        if (!preparationComplete) {
          closeIncompleteRequestAfterResponse(request, response);
        }
        throw error;
      } finally {
        try {
          if (preparedValue !== undefined) {
            discard?.(preparedValue.value);
          }
        } finally {
          permit?.release();
        }
      }
    },
  );
}

function requireRequestSignal(signal: AbortSignal | undefined): AbortSignal {
  if (signal === undefined) {
    throw new BeautioError(
      "INTERNAL_ERROR",
      "write route is missing request cancellation state",
    );
  }
  return signal;
}

function addLegacyOpeningAccuracyWhenMissing(body: unknown): unknown {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.hasOwn(body, "opened_on_accuracy")
  ) {
    return body;
  }
  return { ...body, opened_on_accuracy: "legacy_unknown" };
}

async function withRequestCancellation<T>(
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

function isReservedPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

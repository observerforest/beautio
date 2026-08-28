import type { InventoryApplicationService } from "@beautio/application";
import type { RequestListener } from "node:http";
import {
  downloadActionImages,
  type ActionFileReference,
  type DownloadedActionImage,
} from "./action-download.ts";
import { tokensEqual } from "./bearer.ts";
import { actionTimedOut } from "./body.ts";
import { sendError } from "./responses.ts";
import {
  routeRequest,
  type RouteRequestDependencies,
  type ValidatedOptions,
} from "./routes.ts";
import { createStaticWebRoot } from "./static-web.ts";
import type { ReadOnlyMcpRoute } from "./read-only-mcp.ts";

const ACTION_UPLOAD_TIMEOUT_MS = 40_000;

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

const routeRequestDependencies: RouteRequestDependencies = {
  withActionUploadDeadline,
  abortableActionOperation,
};

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
    void routeRequest(
      application,
      configuration,
      request,
      response,
      routeRequestDependencies,
    ).catch((error: unknown) => {
      if (!response.headersSent) {
        sendError(response, error);
        return;
      }
      response.destroy();
    });
  };
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

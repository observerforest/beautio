import type { InventoryApplicationService } from "@beautio/application";
import { BeautioError } from "@beautio/domain";
import type { RequestListener } from "node:http";
import {
  downloadActionImagesSettled,
  type ActionFileReference,
  type DownloadedActionImage,
} from "./action-download.ts";
import { actionTimedOut } from "./body.ts";
import { validateHttpBearerTokens } from "./http-bearer-tokens.ts";
import { sendError } from "./responses.ts";
import { ExclusiveOperationGate } from "./exclusive-operation-gate.ts";
import { WritePreparationGate } from "./write-preparation-gate.ts";
import { createCustomGptReadRoute, type CustomGptReadApplication, type CustomGptReadLimits } from "./custom-gpt-read-route.ts";
import {
  createCustomGptFactActionRoute,
  type CustomGptFactActionApplication,
} from "./custom-gpt-fact-action-route.ts";
import {
  createCustomGptCreateActionRoute,
  type CustomGptCreateActionApplication,
} from "./custom-gpt-create-action-route.ts";
import {
  createCustomGptImageActionRoute,
  type CustomGptImageActionApplication,
} from "./custom-gpt-image-action-route.ts";
import {
  routeRequest,
  type RouteRequestDependencies,
  type ValidatedOptions,
} from "./routes.ts";
import { createStaticWebRoot } from "./static-web.ts";
import type { ReadOnlyMcpRoute } from "./read-only-mcp.ts";

const ACTION_UPLOAD_TIMEOUT_MS = 40_000;
const BACKUP_OPERATION_TIMEOUT_MS = 120_000;
const WRITE_BODY_TIMEOUT_MS = 10_000;

export interface CoreApiHandlerOptions {
  readonly customGptBearerToken: string;
  readonly actionBearerToken: string;
  readonly adminBearerToken: string;
  readonly actionFileHosts: ReadonlySet<string>;
  readonly actionDownloader?: (
    references: readonly ActionFileReference[],
    allowedHosts: ReadonlySet<string>,
    signal: AbortSignal,
  ) => Promise<readonly DownloadedActionImage[]>;
  readonly actionUploadTimeoutMs?: number;
  readonly backupOperationTimeoutMs?: number;
  readonly writeBodyTimeoutMs?: number;
  readonly publicOrigin?: string;
  readonly webRoot?: string;
  readonly readOnlyMcp?: ReadOnlyMcpRoute;
  readonly customGptReads?: CustomGptReadApplication;
  readonly customGptReadLimits?: CustomGptReadLimits;
  readonly customGptFactWrites?: CustomGptFactActionApplication;
  readonly customGptCreates?: CustomGptCreateActionApplication;
  readonly customGptImageCommands?: CustomGptImageActionApplication;
}

/**
 * Creates the authenticated HTTP adapter around the shared application service.
 *
 * @param application - Shared use cases also called by stdio MCP.
 * @param options - Separate Custom GPT, Codex Action, and Admin keys plus approved Action file hosts.
 * @returns A Node request listener exposing health, Actions, and management routes.
 */
export function createCoreApiHandler(
  application: InventoryApplicationService,
  options: CoreApiHandlerOptions,
): RequestListener {
  const configuration = validateOptions(options);
  const exclusiveOperationGate = new ExclusiveOperationGate();
  const writePreparationGate = new WritePreparationGate();
  const routeRequestDependencies: RouteRequestDependencies = {
    withActionUploadDeadline,
    acquireWritePreparation: (signal) =>
      writePreparationGate.acquire(signal),
    withExclusiveOperation: (operation, signal) =>
      exclusiveOperationGate.run(operation, signal),
    withBackupDeadline,
    withWriteBodyDeadline,
  };
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
  const bearerTokens = validateHttpBearerTokens(options);
  if (options.actionFileHosts.size === 0) {
    throw new Error("at least one Action file host is required");
  }
  const actionFileHosts = new Set(options.actionFileHosts);
  const neverAbortedSignal = new AbortController().signal;
  const actionDownloader =
    options.actionDownloader ??
    ((references, allowedHosts, signal) =>
      downloadActionImagesSettled(
        references,
        allowedHosts,
        undefined,
        undefined,
        { signal },
      ));
  return {
    ...bearerTokens,
    actionFileHosts,
    actionDownloader,
    actionUploadTimeoutMs: positiveTimeout(
      options.actionUploadTimeoutMs,
      ACTION_UPLOAD_TIMEOUT_MS,
    ),
    backupOperationTimeoutMs: positiveTimeout(
      options.backupOperationTimeoutMs,
      BACKUP_OPERATION_TIMEOUT_MS,
    ),
    writeBodyTimeoutMs: positiveTimeout(
      options.writeBodyTimeoutMs,
      WRITE_BODY_TIMEOUT_MS,
    ),
    publicOrigin: validatePublicOrigin(options.publicOrigin),
    staticWebRoot:
      options.webRoot === undefined
        ? null
        : createStaticWebRoot(options.webRoot),
    readOnlyMcp: options.readOnlyMcp ?? null,
    customGptReadRoute: options.customGptReads === undefined ? null :
      createCustomGptReadRoute(options.customGptReads, options.customGptReadLimits),
    customGptFactActionRoute:
      options.customGptFactWrites === undefined
        ? null
        : createCustomGptFactActionRoute(options.customGptFactWrites),
    customGptCreateActionRoute:
      options.customGptCreates === undefined
        ? null
        : createCustomGptCreateActionRoute(options.customGptCreates),
    customGptImageActionRoute:
      options.customGptImageCommands === undefined
        ? null
        : createCustomGptImageActionRoute(
            options.customGptImageCommands,
            (references, signal) =>
              actionDownloader(
                references,
                actionFileHosts,
                signal ?? neverAbortedSignal,
              ),
          ),
  };
}

async function withBackupDeadline<T>(
  timeoutMs: number,
  externalSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), timeoutMs);
  timeout.unref();
  const signal = AbortSignal.any([externalSignal, deadline.signal]);
  try {
    return await operation(signal);
  } catch (error) {
    if (deadline.signal.aborted && isAbortFailure(error)) {
      throw new BeautioError("UPLOAD_FAILED", "backup operation timed out");
    }
    if (externalSignal.aborted && isAbortFailure(error)) {
      throw new BeautioError("UPLOAD_FAILED", "backup operation was aborted");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortFailure(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof BeautioError &&
      error.code === "UPLOAD_FAILED" &&
      error.message === "backup operation was aborted")
  );
}

async function withActionUploadDeadline<T>(
  timeoutMs: number,
  externalSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = createTaggedDeadline(timeoutMs, externalSignal);
  try {
    return await operation(deadline.signal);
  } catch (error) {
    if (
      deadline.firstSource() === "deadline" &&
      isExplicitAbortFailure(error)
    ) {
      throw actionTimedOut();
    }
    if (
      deadline.firstSource() === "external" &&
      isExplicitAbortFailure(error)
    ) {
      throw deadline.abortReason();
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}

async function withWriteBodyDeadline<T>(
  timeoutMs: number,
  externalSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = createTaggedDeadline(timeoutMs, externalSignal);
  try {
    const value = await operation(deadline.signal);
    if (deadline.signal.aborted) {
      throw deadline.abortReason();
    }
    return value;
  } catch (error) {
    if (
      deadline.firstSource() === "deadline" &&
      isExplicitAbortFailure(error)
    ) {
      throw new BeautioError("INVALID_INPUT", "request body timed out");
    }
    if (
      deadline.firstSource() === "external" &&
      isExplicitAbortFailure(error)
    ) {
      throw deadline.abortReason();
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}

type AbortSource = "deadline" | "external";

interface TaggedDeadline {
  readonly signal: AbortSignal;
  readonly abortReason: () => Error;
  readonly firstSource: () => AbortSource | null;
  readonly dispose: () => void;
}

function createTaggedDeadline(
  timeoutMs: number,
  externalSignal: AbortSignal,
): TaggedDeadline {
  const controller = new AbortController();
  let firstSource: AbortSource | null = null;
  const abort = (source: AbortSource): void => {
    if (firstSource !== null) {
      return;
    }
    firstSource = source;
    const error = new Error(
      source === "deadline" ? "operation deadline elapsed" : "request was aborted",
    );
    error.name = "AbortError";
    controller.abort(error);
  };
  const externalAbort = (): void => abort("external");
  if (externalSignal.aborted) {
    externalAbort();
  } else {
    externalSignal.addEventListener("abort", externalAbort, { once: true });
  }
  const timeout = setTimeout(() => abort("deadline"), timeoutMs);
  timeout.unref();
  return {
    signal: controller.signal,
    abortReason: () => abortReason(controller.signal),
    firstSource: () => firstSource,
    dispose: () => {
      clearTimeout(timeout);
      externalSignal.removeEventListener("abort", externalAbort);
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("operation was aborted");
  error.name = "AbortError";
  return error;
}

function isExplicitAbortFailure(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof BeautioError &&
      error.code === "UPLOAD_FAILED" &&
      error.message === "image upload timed out")
  );
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

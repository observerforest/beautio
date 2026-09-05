import type {
  ActionImageLoader,
  CustomGptImageCommandService,
  PreparedImageUploadExecution,
} from "@beautio/application";
import {
  customGptImageCommandMaximumResponseBytes,
  customGptSetDisplayImageCommandOutputSchema,
  customGptUploadImagesCommandOutputSchema,
} from "@beautio/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { JSON_BODY_LIMIT, readJson, throwIfRequestAborted } from "./body.ts";
import {
  sendCustomGptImageActionError,
  sendCustomGptImageActionNotFound,
  type CustomGptImageActionErrorPhase,
} from "./custom-gpt-image-action-errors.ts";
import { closeIncompleteRequestAfterResponse } from "./incomplete-request.ts";
import { routeId } from "./path-segment.ts";
import { invalidInput, sendJson } from "./responses.ts";
import type { WritePreparationPermit } from "./write-preparation-gate.ts";

export const customGptUploadImagesActionPath =
  "/api/actions/upload-product-images";
const PRODUCT_ACTION_PREFIX = "/api/actions/products/";
const DISPLAY_IMAGE_SUFFIX = "/display-image";
const IMAGE_FACT_BODY_LIMIT = 64 * 1024;

export type CustomGptImageActionApplication = Pick<
  CustomGptImageCommandService,
  | "prepareUpload"
  | "claimPreparedUpload"
  | "prepareOwnedUpload"
  | "executePreparedUpload"
  | "discardPreparedUpload"
  | "prepareSetDisplayImage"
  | "executePreparedSetDisplayImage"
>;

export interface CustomGptImageActionDependencies {
  readonly acquireWritePreparation: (
    signal: AbortSignal,
  ) => Promise<WritePreparationPermit>;
  readonly withActionUploadDeadline: <T>(
    timeoutMs: number,
    externalSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  readonly withExclusiveOperation: <T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  readonly withWriteBodyDeadline: <T>(
    timeoutMs: number,
    externalSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
}

export interface CustomGptImageActionRoute {
  /**
   * Handles the two fixed image Actions after the caller has authenticated Custom GPT.
   * @param request - Authenticated HTTP request.
   * @param response - Pending HTTP response.
   * @param url - Parsed URL whose query component must be empty.
   * @param dependencies - Shared bounded preparation and exclusive write gates.
   * @param writeBodyTimeoutMs - Deadline covering permit acquisition and body preparation.
   * @param actionUploadTimeoutMs - Deadline covering owned download and semantic preparation.
   * @param requestSignal - Disconnect signal used until a final effect begins.
   * @returns Whether this adapter owns the requested path.
   */
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    dependencies: CustomGptImageActionDependencies,
    writeBodyTimeoutMs: number,
    actionUploadTimeoutMs: number,
    requestSignal: AbortSignal,
  ): Promise<boolean>;
}

/**
 * Reports whether a path belongs to one of the reserved Custom GPT image Actions.
 * @param pathname - URL pathname before application dispatch.
 * @returns True for only the upload path or Product display-image family.
 */
export function isCustomGptImageActionPath(pathname: string): boolean {
  return (
    pathname === customGptUploadImagesActionPath ||
    (pathname.startsWith(PRODUCT_ACTION_PREFIX) &&
      pathname.endsWith(DISPLAY_IMAGE_SUFFIX))
  );
}

/**
 * Creates the narrow HTTP adapter for replay-safe Custom GPT image commands.
 * @param application - Opaque image command service.
 * @param loader - Bounded loader whose Promise represents dependency settlement.
 * @returns Route isolated from Admin and Codex image behavior.
 */
export function createCustomGptImageActionRoute(
  application: CustomGptImageActionApplication,
  loader: ActionImageLoader,
): CustomGptImageActionRoute {
  return {
    async handleRequest(
      request,
      response,
      url,
      dependencies,
      writeBodyTimeoutMs,
      actionUploadTimeoutMs,
      requestSignal,
    ) {
      if (!isCustomGptImageActionPath(url.pathname)) {
        return false;
      }
      if (url.pathname === customGptUploadImagesActionPath) {
        await handleUpload(
          application,
          loader,
          request,
          response,
          url,
          dependencies,
          writeBodyTimeoutMs,
          actionUploadTimeoutMs,
          requestSignal,
        );
        return true;
      }
      await handleSetDisplayImage(
        application,
        request,
        response,
        url,
        dependencies,
        writeBodyTimeoutMs,
        requestSignal,
      );
      return true;
    },
  };
}

async function handleUpload(
  application: CustomGptImageActionApplication,
  loader: ActionImageLoader,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: CustomGptImageActionDependencies,
  writeBodyTimeoutMs: number,
  actionUploadTimeoutMs: number,
  requestSignal: AbortSignal,
): Promise<void> {
  let phase: CustomGptImageActionErrorPhase = "preparation";
  let permit: WritePreparationPermit | undefined;
  let execution: PreparedImageUploadExecution | undefined;
  try {
    if (request.method !== "POST") {
      closeIncompleteRequestAfterResponse(request, response);
      sendCustomGptImageActionNotFound(response);
      return;
    }
    if (url.search !== "") {
      throw invalidInput();
    }

    const prepared = await dependencies.withWriteBodyDeadline(
      writeBodyTimeoutMs,
      requestSignal,
      async (preparationSignal) => {
        permit = await dependencies.acquireWritePreparation(preparationSignal);
        throwIfRequestAborted(preparationSignal);
        const body = await readJson(
          request,
          JSON_BODY_LIMIT,
          preparationSignal,
        );
        throwIfRequestAborted(preparationSignal);
        const command = application.prepareUpload(body);
        throwIfRequestAborted(preparationSignal);
        return command;
      },
    );

    phase = "claim_queue";
    const claim = await dependencies.withExclusiveOperation(
      async () => {
        phase = "claim";
        return application.claimPreparedUpload(prepared);
      },
      requestSignal,
    );
    if (claim.outcome === "replayed") {
      const output = validateUploadOutput(claim.output);
      throwIfRequestAborted(requestSignal);
      releasePermit();
      sendJson(response, 200, output);
      return;
    }

    phase = "owned_preparation";
    const preparedExecution = await dependencies.withActionUploadDeadline(
      actionUploadTimeoutMs,
      requestSignal,
      (preparationSignal) =>
        application.prepareOwnedUpload(
          claim.ownership,
          loader,
          { signal: preparationSignal },
        ),
    );
    execution = preparedExecution;

    phase = "final_queue";
    const rawOutput = await dependencies.withExclusiveOperation(
      async () => {
        phase = "execution";
        return application.executePreparedUpload(preparedExecution);
      },
      requestSignal,
    );
    const output = validateUploadOutput(rawOutput);
    throwIfRequestAborted(requestSignal);
    application.discardPreparedUpload(execution);
    execution = undefined;
    releasePermit();
    sendJson(response, 200, output);
  } catch (error) {
    closeIncompleteRequestAfterResponse(request, response);
    if (!response.destroyed && !response.headersSent) {
      sendCustomGptImageActionError(response, error, phase);
    }
  } finally {
    try {
      if (execution !== undefined) {
        application.discardPreparedUpload(execution);
      }
    } finally {
      permit?.release();
    }
  }

  function releasePermit(): void {
    if (permit === undefined) {
      throw new Error("image Action lost its preparation permit");
    }
    permit.release();
    permit = undefined;
  }
}

async function handleSetDisplayImage(
  application: CustomGptImageActionApplication,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: CustomGptImageActionDependencies,
  writeBodyTimeoutMs: number,
  requestSignal: AbortSignal,
): Promise<void> {
  let phase: CustomGptImageActionErrorPhase = "preparation";
  let permit: WritePreparationPermit | undefined;
  try {
    const productId = routeId(
      url.pathname,
      PRODUCT_ACTION_PREFIX,
      DISPLAY_IMAGE_SUFFIX,
    );
    if (productId === null) {
      throw invalidInput();
    }
    if (request.method !== "PUT") {
      closeIncompleteRequestAfterResponse(request, response);
      sendCustomGptImageActionNotFound(response);
      return;
    }
    if (url.search !== "") {
      throw invalidInput();
    }

    const prepared = await dependencies.withWriteBodyDeadline(
      writeBodyTimeoutMs,
      requestSignal,
      async (preparationSignal) => {
        permit = await dependencies.acquireWritePreparation(preparationSignal);
        throwIfRequestAborted(preparationSignal);
        const body = await readJson(
          request,
          IMAGE_FACT_BODY_LIMIT,
          preparationSignal,
        );
        throwIfRequestAborted(preparationSignal);
        const command = application.prepareSetDisplayImage(productId, body);
        throwIfRequestAborted(preparationSignal);
        return command;
      },
    );

    phase = "claim_queue";
    const rawOutput = await dependencies.withExclusiveOperation(
      async () => {
        phase = "execution";
        return application.executePreparedSetDisplayImage(prepared);
      },
      requestSignal,
    );
    const output = customGptSetDisplayImageCommandOutputSchema.parse(rawOutput);
    assertResponseSize(output);
    throwIfRequestAborted(requestSignal);
    if (permit === undefined) {
      throw new Error("display image Action lost its preparation permit");
    }
    permit.release();
    permit = undefined;
    sendJson(response, 200, output);
  } catch (error) {
    closeIncompleteRequestAfterResponse(request, response);
    if (!response.destroyed && !response.headersSent) {
      sendCustomGptImageActionError(response, error, phase);
    }
  } finally {
    permit?.release();
  }
}

function validateUploadOutput(value: unknown) {
  const output = customGptUploadImagesCommandOutputSchema.parse(value);
  assertResponseSize(output);
  return output;
}

function assertResponseSize(value: unknown): void {
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") >
    customGptImageCommandMaximumResponseBytes
  ) {
    throw new Error("image Action response exceeds its byte limit");
  }
}

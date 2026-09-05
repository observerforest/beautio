import type { CustomGptCreateCommandService } from "@beautio/application";
import {
  customGptCreateCommandMaximumResponseBytes,
  customGptCreateCommandOutputSchema,
} from "@beautio/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { JSON_BODY_LIMIT, readJson, throwIfRequestAborted } from "./body.ts";
import {
  sendCustomGptCreateActionError,
  sendCustomGptCreateActionNotFound,
  type CustomGptCreateActionErrorPhase,
} from "./custom-gpt-create-action-errors.ts";
import { closeIncompleteRequestAfterResponse } from "./incomplete-request.ts";
import { invalidInput, sendJson } from "./responses.ts";
import type { WritePreparationPermit } from "./write-preparation-gate.ts";

export const customGptCreateActionPath =
  "/api/actions/create-inventory-batch";

export type CustomGptCreateActionApplication = Pick<
  CustomGptCreateCommandService,
  "prepare" | "executePrepared"
>;

export interface CustomGptCreateActionDependencies {
  readonly acquireWritePreparation: (
    signal: AbortSignal,
  ) => Promise<WritePreparationPermit>;
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

export interface CustomGptCreateActionRoute {
  /**
   * Handles the fixed create Action after the caller has authenticated Custom GPT.
   *
   * @param request - Authenticated HTTP request.
   * @param response - Pending HTTP response.
   * @param url - Parsed URL whose query component must be empty.
   * @param dependencies - Shared bounded preparation and exclusive write gates.
   * @param writeBodyTimeoutMs - Deadline covering permit acquisition and body preparation.
   * @param requestSignal - Disconnect signal used only before execution starts.
   * @returns Whether this adapter owns the requested path.
   */
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    dependencies: CustomGptCreateActionDependencies,
    writeBodyTimeoutMs: number,
    requestSignal: AbortSignal,
  ): Promise<boolean>;
}

/**
 * Reports whether a path is the reserved Custom GPT create Action.
 *
 * @param pathname - URL pathname before application dispatch.
 * @returns True only for the exact create-inventory-batch path.
 */
export function isCustomGptCreateActionPath(pathname: string): boolean {
  return pathname === customGptCreateActionPath;
}

/**
 * Creates the narrow HTTP adapter for confirmed, replay-safe inventory creation.
 *
 * @param application - Opaque preparation and single-use command execution service.
 * @returns A route that never receives an Admin service or persistence repository.
 */
export function createCustomGptCreateActionRoute(
  application: CustomGptCreateActionApplication,
): CustomGptCreateActionRoute {
  return {
    async handleRequest(
      request,
      response,
      url,
      dependencies,
      writeBodyTimeoutMs,
      requestSignal,
    ) {
      if (!isCustomGptCreateActionPath(url.pathname)) {
        return false;
      }

      let phase: CustomGptCreateActionErrorPhase = "preparation";
      let permit: WritePreparationPermit | undefined;
      try {
        if (request.method !== "POST") {
          closeIncompleteRequestAfterResponse(request, response);
          sendCustomGptCreateActionNotFound(response);
          return true;
        }
        if (url.search !== "") {
          throw invalidInput();
        }

        const prepared = await dependencies.withWriteBodyDeadline(
          writeBodyTimeoutMs,
          requestSignal,
          async (preparationSignal) => {
            permit = await dependencies.acquireWritePreparation(
              preparationSignal,
            );
            throwIfRequestAborted(preparationSignal);
            const body = await readJson(
              request,
              JSON_BODY_LIMIT,
              preparationSignal,
            );
            throwIfRequestAborted(preparationSignal);
            const command = application.prepare(body);
            throwIfRequestAborted(preparationSignal);
            return command;
          },
        );

        phase = "exclusive_queue";
        const rawOutput = await dependencies.withExclusiveOperation(
          async () => {
            phase = "execution";
            return application.executePrepared(prepared);
          },
          requestSignal,
        );
        const output = customGptCreateCommandOutputSchema.parse(rawOutput);
        if (
          Buffer.byteLength(JSON.stringify(output), "utf8") >
          customGptCreateCommandMaximumResponseBytes
        ) {
          throw new Error("create inventory Action response exceeds its byte limit");
        }
        throwIfRequestAborted(requestSignal);
        if (permit === undefined) {
          throw new Error("create inventory Action lost its preparation permit");
        }
        permit.release();
        permit = undefined;
        sendJson(response, 200, output);
      } catch (error) {
        closeIncompleteRequestAfterResponse(request, response);
        if (!response.destroyed && !response.headersSent) {
          sendCustomGptCreateActionError(response, error, phase);
        }
      } finally {
        permit?.release();
      }
      return true;
    },
  };
}

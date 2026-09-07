import type {
  CustomGptFactWriteService,
} from "@beautio/application";
import {
  customGptFactCommandOutputSchema,
  type FactCommandOperationId,
} from "@beautio/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, throwIfRequestAborted } from "./body.ts";
import {
  sendCustomGptFactActionError,
  sendCustomGptFactActionNotFound,
  type CustomGptFactActionErrorPhase,
} from "./custom-gpt-fact-action-errors.ts";
import { closeIncompleteRequestAfterResponse } from "./incomplete-request.ts";
import { routeId } from "./path-segment.ts";
import { invalidInput, sendJson } from "./responses.ts";
import type { WritePreparationPermit } from "./write-preparation-gate.ts";

const FACT_ACTION_BODY_LIMIT = 64 * 1024;
const FACT_ACTION_RESPONSE_LIMIT = 8 * 1024;

export type CustomGptFactActionApplication = Pick<
  CustomGptFactWriteService,
  "prepare" | "executePrepared"
>;

export interface CustomGptFactActionDependencies {
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

export interface CustomGptFactActionRoute {
  /**
   * Handles the five fixed fact routes after the caller has authenticated Custom GPT.
   * @param request - Authenticated HTTP request.
   * @param response - Pending HTTP response.
   * @param url - Parsed URL whose query component must be empty.
   * @param dependencies - Shared bounded preparation and exclusive write gates.
   * @param writeBodyTimeoutMs - Real deadline covering permit acquisition and body preparation.
   * @param requestSignal - Disconnect signal used only before execution starts.
   * @returns Whether this adapter owns the requested path family.
   */
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    dependencies: CustomGptFactActionDependencies,
    writeBodyTimeoutMs: number,
    requestSignal: AbortSignal,
  ): Promise<boolean>;
}

interface FactActionSpecification {
  readonly method: "PATCH" | "POST" | "PUT";
  readonly operationId: FactCommandOperationId;
  readonly prefix: string;
  readonly suffix: string;
}

interface FactActionMatch {
  readonly method: FactActionSpecification["method"];
  readonly operationId: FactCommandOperationId;
  readonly targetId: string;
}

const specifications: readonly FactActionSpecification[] = [
  {
    method: "PATCH",
    operationId: "revise_product_profile",
    prefix: "/api/actions/products/",
    suffix: "/profile",
  },
  {
    method: "PATCH",
    operationId: "correct_inventory_item_facts",
    prefix: "/api/actions/inventory-items/",
    suffix: "/facts",
  },
  {
    method: "PUT",
    operationId: "set_inventory_item_custom_notes",
    prefix: "/api/actions/inventory-items/",
    suffix: "/custom-notes",
  },
  {
    method: "POST",
    operationId: "record_product_opened",
    prefix: "/api/actions/inventory-items/",
    suffix: "/open",
  },
  {
    method: "POST",
    operationId: "end_inventory_item_use",
    prefix: "/api/actions/inventory-items/",
    suffix: "/end-use",
  },
];

/**
 * Reports whether a path belongs to the reserved fact Action resource family.
 * @param pathname - URL pathname before any application dispatch.
 * @returns True for Product-profile and inventory-item fact/lifecycle resources.
 */
export function isCustomGptFactActionPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/actions/products/") ||
    pathname.startsWith("/api/actions/inventory-items/")
  );
}

/**
 * Creates the narrow HTTP adapter for confirmed Custom GPT fact mutations.
 * @param application - Opaque preparation and single-use command execution service.
 * @returns A route that never receives an Admin service or persistence repository.
 */
export function createCustomGptFactActionRoute(
  application: CustomGptFactActionApplication,
): CustomGptFactActionRoute {
  return {
    async handleRequest(
      request,
      response,
      url,
      dependencies,
      writeBodyTimeoutMs,
      requestSignal,
    ) {
      if (!isCustomGptFactActionPath(url.pathname)) {
        return false;
      }

      let phase: CustomGptFactActionErrorPhase = "preparation";
      let permit: WritePreparationPermit | undefined;
      try {
        const matched = matchFactAction(url.pathname);
        if (matched === null) {
          closeIncompleteRequestAfterResponse(request, response);
          sendCustomGptFactActionNotFound(response);
          return true;
        }
        if (request.method !== matched.method) {
          closeIncompleteRequestAfterResponse(request, response);
          sendCustomGptFactActionNotFound(response);
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
              FACT_ACTION_BODY_LIMIT,
              preparationSignal,
            );
            throwIfRequestAborted(preparationSignal);
            const command = application.prepare(
              matched.operationId,
              matched.targetId,
              body,
            );
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
        const output = customGptFactCommandOutputSchema.parse(rawOutput);
        if (output.operation_id !== matched.operationId) {
          throw new Error("fact Action returned a mismatched operation receipt");
        }
        if (
          Buffer.byteLength(JSON.stringify(output), "utf8") >
          FACT_ACTION_RESPONSE_LIMIT
        ) {
          throw new Error("fact Action response exceeds its byte limit");
        }
        throwIfRequestAborted(requestSignal);
        sendJson(response, 200, output);
      } catch (error) {
        closeIncompleteRequestAfterResponse(request, response);
        if (!response.destroyed && !response.headersSent) {
          sendCustomGptFactActionError(response, error, phase);
        }
      } finally {
        permit?.release();
      }
      return true;
    },
  };
}

function matchFactAction(pathname: string): FactActionMatch | null {
  for (const specification of specifications) {
    if (
      !pathname.startsWith(specification.prefix) ||
      !pathname.endsWith(specification.suffix)
    ) {
      continue;
    }
    const targetId = routeId(
      pathname,
      specification.prefix,
      specification.suffix,
    );
    if (targetId === null) {
      throw invalidInput();
    }
    return {
      method: specification.method,
      operationId: specification.operationId,
      targetId,
    };
  }
  return null;
}

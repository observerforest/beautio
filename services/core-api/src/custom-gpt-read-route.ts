import type { CustomGptReadService } from "@beautio/application";
import {
  customGptCommandStatusOutputSchema,
  customGptFetchOutputSchema,
  customGptSearchOutputSchema,
} from "@beautio/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { throwIfRequestAborted } from "./body.ts";
import { sendCustomGptReadError } from "./custom-gpt-read-errors.ts";
import { closeIncompleteRequestAfterResponse } from "./incomplete-request.ts";
import { invalidInput, sendJson, sendNotFound } from "./responses.ts";

export type CustomGptReadApplication = Pick<CustomGptReadService,
  "searchInventory" | "fetchInventoryItem" | "getCommandStatus">;

export interface CustomGptReadLimits {
  readonly maximumConcurrentRequests?: number;
  readonly maximumResultBytes?: number;
}

export interface CustomGptReadRoute {
  /**
   * Handles only the three fixed read paths, after caller authentication.
   * @param request - Authenticated HTTP request.
   * @param response - Pending HTTP response.
   * @param url - Parsed exact URL; query parameters are not accepted.
   * @param readBody - Bounded reader wrapped in a real body deadline.
   * @param signal - Caller disconnect signal, not a fake database timeout.
   * @returns Whether this route owns the path, including method rejections.
   */
  handleRequest(request: IncomingMessage, response: ServerResponse, url: URL,
    readBody: (maximumBytes: number) => Promise<unknown>, signal: AbortSignal): Promise<boolean>;
}

/**
 * Creates an instance-local bounded adapter containing no write capabilities.
 * @param application - Three narrow read methods, never an Admin service.
 * @param limits - Optional stricter concurrency and complete JSON byte bounds.
 * @returns A read route; slots remain occupied until actual operations settle.
 */
export function createCustomGptReadRoute(
  application: CustomGptReadApplication,
  limits: CustomGptReadLimits = {},
): CustomGptReadRoute {
  const maximumConcurrent = boundedInteger(limits.maximumConcurrentRequests, 8, 1, 8);
  const maximumBytes = boundedInteger(limits.maximumResultBytes, 262144, 512, 262144);
  let activeRequests = 0;
  return {
    async handleRequest(request, response, url, readBody, signal) {
      const path = url.pathname;
      if (path !== "/api/actions/inventory/search" &&
          path !== "/api/actions/inventory/fetch" &&
          path !== "/api/actions/commands/status") return false;
      if (request.method !== "POST") {
        closeIncompleteRequestAfterResponse(request, response);
        sendNotFound(response);
        return true;
      }
      if (activeRequests >= maximumConcurrent) {
        closeIncompleteRequestAfterResponse(request, response);
        sendJson(response, 503, { error: { code: "INTERNAL_ERROR", message: "Read Actions are temporarily busy." } });
        return true;
      }
      activeRequests++;
      try {
        if (url.search !== "") throw invalidInput();
        throwIfRequestAborted(signal);
        const input = await readBody(64 * 1024);
        throwIfRequestAborted(signal);
        const output = path === "/api/actions/inventory/search"
          ? customGptSearchOutputSchema.parse(await application.searchInventory(input))
          : path === "/api/actions/inventory/fetch"
            ? customGptFetchOutputSchema.parse(await application.fetchInventoryItem(input))
            : customGptCommandStatusOutputSchema.parse(await application.getCommandStatus(input));
        throwIfRequestAborted(signal);
        if (Buffer.byteLength(JSON.stringify(output), "utf8") > maximumBytes) {
          throw new Error("read result exceeds configured byte limit");
        }
        sendJson(response, 200, output);
      } catch (error) {
        closeIncompleteRequestAfterResponse(request, response);
        if (!response.destroyed) sendCustomGptReadError(response, error);
      } finally {
        activeRequests--;
      }
      return true;
    },
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error("read Action limits are outside their supported range");
  }
  return candidate;
}

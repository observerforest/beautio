import type { IncomingMessage, ServerResponse } from "node:http";

const closedRequests = new WeakSet<IncomingMessage>();

/**
 * Closes an unfinished request after flushing its rejection, without endless draining.
 * @param request - Request that will not be consumed by a handler.
 * @param response - Error response which has not normally sent headers yet.
 * @returns Nothing; a partial socket is closed after the response finishes.
 */
export function closeIncompleteRequestAfterResponse(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if (closedRequests.has(request)) return;
  closedRequests.add(request);
  if (!request.destroyed && !request.readableEnded) request.resume();
  if (request.complete || request.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const socket = request.socket;
  response.setHeader("connection", "close");
  response.once("finish", () => {
    if (!socket.destroyed) socket.destroySoon();
  });
}

import { type InventoryApplicationService } from "@beautio/application";
import {
  fetchInventoryInputSchema,
  fetchInventoryOutputSchema,
  searchInventoryInputSchema,
  searchInventoryOutputSchema,
  type ToolErrorOutput,
} from "@beautio/contracts";
import { BeautioError } from "@beautio/domain";
import {
  originValidation,
  hostHeaderValidation,
  toNodeHandler,
  type NodeIncomingMessageLike,
} from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccessJwtVerifier } from "./access-jwt.ts";

export const searchInventoryToolName = "search_inventory";
export const fetchInventoryItemToolName = "fetch_inventory_item";

export const searchInventoryToolDescription =
  "Search the user's private Beautio inventory by Product name, alias, brand, category, size, ingredient text, shared notes, or one bottle's custom notes. With no query, list inventory in stable order. Results are compact summaries, and the single-user search boundary accepts inventories of up to 1000 bottles. To read full Product details, ingredients, or notes, pass a matched complete inventory_item_id to fetch_inventory_item; never invent an ID from a name or alias. Images never expose bytes, IDs, or legacy references. Optional as_of adds date-relative status; without it derived_status is null and the server never assumes today.";

export const fetchInventoryItemToolDescription =
  "Fetch one private Beautio inventory item by its opaque inventory_item_id, including the Product alias, full ingredient text and shared notes plus this bottle's custom notes. Only has_image is exposed for images. Optional as_of adds date-relative status; without it derived_status is null and the server never assumes today. This tool is read-only.";

export interface ReadOnlyMcpRouteOptions {
  readonly publicOrigin: string;
  readonly verifyAccessJwt: AccessJwtVerifier;
  readonly onError?: () => void;
  readonly maximumConcurrentRequests?: number;
  readonly maximumResultBytes?: number;
}

export interface ReadOnlyMcpRoute {
  readonly handleRequest: (
    request: IncomingMessage,
    response: ServerResponse,
    readJsonBody: () => Promise<unknown>,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface ReadOnlyInventoryMcpServerOptions {
  readonly maximumResultBytes?: number;
}

const DEFAULT_MAXIMUM_CONCURRENT_REQUESTS = 8;
const MINIMUM_RESULT_BYTES = 512;
const DEFAULT_MAXIMUM_RESULT_BYTES = 256 * 1024;

/**
 * Builds the public read-only Streamable HTTP MCP route.
 *
 * @param application - Shared business boundary used by every Beautio adapter.
 * @param options - Exact public origin and Cloudflare Access JWT verifier.
 * @returns A Node route exposing only authenticated inventory search and fetch.
 */
export function createReadOnlyMcpRoute(
  application: InventoryApplicationService,
  options: ReadOnlyMcpRouteOptions,
): ReadOnlyMcpRoute {
  const publicOrigin = validateMcpPublicOrigin(options.publicOrigin);
  const hostname = new URL(publicOrigin).hostname;
  const maximumConcurrentRequests = boundedInteger(
    options.maximumConcurrentRequests,
    DEFAULT_MAXIMUM_CONCURRENT_REQUESTS,
    1,
    DEFAULT_MAXIMUM_CONCURRENT_REQUESTS,
    "maximumConcurrentRequests",
  );
  const maximumResultBytes = boundedInteger(
    options.maximumResultBytes,
    DEFAULT_MAXIMUM_RESULT_BYTES,
    MINIMUM_RESULT_BYTES,
    DEFAULT_MAXIMUM_RESULT_BYTES,
    "maximumResultBytes",
  );
  let activeRequests = 0;
  const validateHost = hostHeaderValidation([hostname]);
  const validateOrigin = originValidation([hostname]);
  const mcpHandler = createMcpHandler(
    () =>
      createReadOnlyInventoryMcpServer(application, {
        maximumResultBytes,
      }),
    {
      legacy: "stateless",
      responseMode: "auto",
      onerror: () => options.onError?.(),
    },
  );
  const privateMcpHandler = {
    fetch: async (
      request: Parameters<typeof mcpHandler.fetch>[0],
      handlerOptions?: Parameters<typeof mcpHandler.fetch>[1],
    ): Promise<Response> => {
      const sdkResponse = await mcpHandler.fetch(request, handlerOptions);
      const headers = new Headers(sdkResponse.headers);
      const contentType = headers.get("content-type");
      headers.set(
        "cache-control",
        contentType?.startsWith("text/event-stream") === true
          ? "no-store, no-transform"
          : "no-store",
      );
      headers.set("x-content-type-options", "nosniff");
      return new Response(sdkResponse.body, {
        status: sdkResponse.status,
        statusText: sdkResponse.statusText,
        headers,
      });
    },
  };
  const nodeHandler = toNodeHandler(privateMcpHandler, {
    onerror: () => options.onError?.(),
  });

  return {
    handleRequest: async (request, response, readJsonBody) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      if (
        !validateHost(request, response) ||
        !validateOrigin(request, response)
      ) {
        return;
      }
      const assertion = accessAssertion(request);
      await options.verifyAccessJwt(assertion);
      if (activeRequests >= maximumConcurrentRequests) {
        throw new BeautioError(
          "INTERNAL_ERROR",
          "read-only MCP is temporarily busy",
        );
      }
      if (request.method === undefined || request.url === undefined) {
        throw new BeautioError("INVALID_INPUT", "MCP request is incomplete");
      }
      const mcpRequest = request as IncomingMessage & NodeIncomingMessageLike;
      activeRequests += 1;
      try {
        if (request.method === "POST") {
          await nodeHandler(mcpRequest, response, await readJsonBody());
          return;
        }
        await nodeHandler(mcpRequest, response);
      } finally {
        activeRequests -= 1;
      }
    },
    close: () => mcpHandler.close(),
  };
}

/**
 * Creates a fresh MCP server with exactly the two approved read tools.
 *
 * @param application - Application service owning search and fetch rules.
 * @param options - Optional response-byte boundary for transport-level tests.
 * @returns A transport-neutral read-only MCP server.
 */
export function createReadOnlyInventoryMcpServer(
  application: InventoryApplicationService,
  options: ReadOnlyInventoryMcpServerOptions = {},
): McpServer {
  const maximumResultBytes = boundedInteger(
    options.maximumResultBytes,
    DEFAULT_MAXIMUM_RESULT_BYTES,
    MINIMUM_RESULT_BYTES,
    DEFAULT_MAXIMUM_RESULT_BYTES,
    "maximumResultBytes",
  );
  const server = new McpServer(
    { name: "beautio-read-only", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    searchInventoryToolName,
    {
      title: "Search Beautio inventory",
      description: searchInventoryToolDescription,
      inputSchema: deferInputValidationToApplication(searchInventoryInputSchema),
      outputSchema: searchInventoryOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      execute(
        () => application.searchInventory(input),
        maximumResultBytes,
      ),
  );

  server.registerTool(
    fetchInventoryItemToolName,
    {
      title: "Fetch one Beautio inventory item",
      description: fetchInventoryItemToolDescription,
      inputSchema: deferInputValidationToApplication(fetchInventoryInputSchema),
      outputSchema: fetchInventoryOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      execute(
        () => application.fetchInventory(input),
        maximumResultBytes,
      ),
  );

  return server;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Keeps the strict schema advertised to MCP clients while letting the shared
 * Application contract produce Beautio's stable structured validation errors.
 */
function deferInputValidationToApplication(
  schema: StandardSchemaWithJSON,
): StandardSchemaWithJSON<unknown, unknown> {
  const standard = schema["~standard"];
  return {
    "~standard": {
      version: 1,
      vendor: "beautio-application-validation",
      validate: (value: unknown) => ({ value }),
      jsonSchema: standard.jsonSchema,
    },
  };
}

async function execute(
  operation: () => Promise<unknown>,
  maximumResultBytes: number,
): Promise<CallToolResult> {
  try {
    const output = await operation();
    if (!isRecord(output)) {
      throw new Error("inventory read returned a non-object result");
    }
    const outputJson = JSON.stringify(output);
    const result: CallToolResult = {
      content: [{ type: "text", text: outputJson }],
      structuredContent: output,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > maximumResultBytes) {
      throw new BeautioError(
        "INTERNAL_ERROR",
        "read-only inventory result is too large",
      );
    }
    return result;
  } catch (error) {
    const output = safeToolError(error);
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
      isError: true,
    };
  }
}

function safeToolError(error: unknown): ToolErrorOutput {
  if (!(error instanceof BeautioError)) {
    return {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed.",
    };
  }
  if (error.code === "INVALID_INPUT") {
    return {
      code: error.code,
      message: "input does not match the tool contract",
    };
  }
  if (error.code === "INVENTORY_ITEM_NOT_FOUND") {
    return {
      code: error.code,
      message: "inventory item does not exist",
    };
  }
  if (
    error.code === "INTERNAL_ERROR" &&
    (error.message === "read-only inventory result is too large" ||
      error.message === "inventory search exceeds the 1000-item safety limit")
  ) {
    return { code: error.code, message: error.message };
  }
  return {
    code: error.code,
    message: "The request could not be completed.",
  };
}

function accessAssertion(request: IncomingMessage): string {
  const assertion = request.headers["cf-access-jwt-assertion"];
  if (typeof assertion !== "string" || assertion.length === 0) {
    throw new BeautioError(
      "UNAUTHORIZED",
      "valid Cloudflare Access authentication is required",
    );
  }
  return assertion;
}

function validateMcpPublicOrigin(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("BEAUTIO_MCP_PUBLIC_ORIGIN must be an HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("BEAUTIO_MCP_PUBLIC_ORIGIN must be an HTTPS origin");
  }
  return url.origin;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

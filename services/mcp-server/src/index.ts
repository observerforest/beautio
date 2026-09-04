import { InventoryApplicationService } from "@beautio/application";
import {
  createInventoryBatchInputSchema,
  createInventoryBatchOutputSchema,
  getInventoryItemInputSchema,
  getInventoryItemOutputSchema,
  recordProductOpenedInputSchema,
  recordProductOpenedOutputSchema,
  uploadProductImagesMcpInputSchema,
  uploadProductImagesOutputSchema,
  type ToolErrorOutput,
} from "@beautio/contracts";
import { BeautioError } from "@beautio/domain";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { readMcpImageFiles } from "./local-image-files.ts";

export const recordProductOpenedToolName = "record_product_opened";
export const getInventoryItemToolName = "get_inventory_item";
export const uploadProductImagesToolName = "upload_product_images";
export const createInventoryBatchToolName = "create_inventory_batch";

export const recordProductOpenedDescription =
  "Record that an existing non-terminal inventory item was opened on an explicit YYYY-MM-DD date with explicit exact or estimated date accuracy. This changes persisted lifecycle facts, calculates PAO and usable-until dates in the core domain, is idempotent only for the same item, date, and accuracy, rejects conflicting facts and terminal items, and never guesses dates, time zones, accuracy, or missing inventory.";

export const getInventoryItemDescription =
  "Read one existing inventory item by ID, including its Product alias, shared Product ingredient text, PAO duration and shared notes plus this bottle's custom notes, and derive usability for an explicit YYYY-MM-DD as_of date. This tool is read-only, never creates inventory, and never guesses a date or time zone.";

export const uploadProductImagesDescription =
  "Only after the user confirms the selected Product display images, upload 1-10 supported local files as private temporary Beautio assets. This write has side effects, keeps unlinked assets for 24 hours, rejects the whole upload if any image fails, never accepts receipts or unselected scans by default, and must not be silently retried when the result is unknown.";

export const createInventoryBatchDescription =
  "Only after the user confirms the structured draft, atomically create Products and one InventoryItem per physical bottle, or reference an existing Product ID. Product alias, brand, pao_duration_months, ingredient_list_text, and shared_notes are shared Product facts; custom_notes and opening dates belong to each bottle. Record confirmed PAO once on a new Product. Existing Products supply known PAO automatically: omit the legacy bottle PAO rather than asking again, and do not guess when Product PAO is unknown. A conflicting bottle PAO is rejected, not used to overwrite an existing Product. alias may contain a user-provided nickname or a commonly used online name the user has confirmed. Use null for missing or uncertain facts. If the intended note scope is unclear, ask the user before calling. This write has side effects, rejects the whole batch when any item or image link is invalid, and must not be silently retried when the result is unknown.";

export interface BeautioMcpServerOptions {
  readonly uploadRoot: string;
}

/**
 * Builds the local Beautio MCP adapter around the shared application service.
 *
 * @param application - Application boundary that owns every business use case.
 * @param options - Canonical local root allowed for MCP image file inputs.
 * @returns An MCP server exposing the frozen read and write tools.
 */
export function createBeautioMcpServer(
  application: InventoryApplicationService,
  options: BeautioMcpServerOptions,
): McpServer {
  if (options.uploadRoot.trim().length === 0) {
    throw new Error("BEAUTIO_MCP_UPLOAD_ROOT is required");
  }
  const server = new McpServer(
    { name: "beautio", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    recordProductOpenedToolName,
    {
      title: "Record product opened",
      description: recordProductOpenedDescription,
      inputSchema: recordProductOpenedInputSchema,
      outputSchema: recordProductOpenedOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => execute(() => application.recordProductOpened(input)),
  );

  server.registerTool(
    getInventoryItemToolName,
    {
      title: "Get inventory item",
      description: getInventoryItemDescription,
      inputSchema: getInventoryItemInputSchema,
      outputSchema: getInventoryItemOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => execute(() => application.getInventoryItem(input)),
  );

  server.registerTool(
    uploadProductImagesToolName,
    {
      title: "Upload confirmed Product images",
      description: uploadProductImagesDescription,
      inputSchema: uploadProductImagesMcpInputSchema,
      outputSchema: uploadProductImagesOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      execute(async () => {
        const images = await readMcpImageFiles(input.images, options.uploadRoot);
        return application.uploadProductImages(images);
      }),
  );

  server.registerTool(
    createInventoryBatchToolName,
    {
      title: "Create confirmed inventory batch",
      description: createInventoryBatchDescription,
      inputSchema: createInventoryBatchInputSchema,
      outputSchema: createInventoryBatchOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => execute(() => application.createInventoryBatch(input)),
  );

  return server;
}

async function execute(
  operation: () => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  try {
    return successResult(await operation());
  } catch (error) {
    return businessErrorResult(error);
  }
}

function successResult(output: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function businessErrorResult(error: unknown): CallToolResult {
  const output: ToolErrorOutput = {
    code: error instanceof BeautioError ? error.code : "INTERNAL_ERROR",
    message:
      error instanceof BeautioError
        ? error.message
        : "The request could not be completed.",
    ...(error instanceof BeautioError && error.ref !== undefined
      ? { ref: error.ref }
      : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
    isError: true,
  };
}

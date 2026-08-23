import {
  createInventoryBatchInputSchema,
  createInventoryBatchOutputSchema,
  getInventoryItemInputSchema,
  getInventoryItemOutputSchema,
  recordProductOpenedInputSchema,
  recordProductOpenedOutputSchema,
  setProductDisplayImageInputSchema,
  setProductDisplayImageOutputSchema,
  uploadProductImagesMcpInputSchema,
  uploadProductImagesOutputSchema,
  type CreateInventoryBatchOutput,
  type GetInventoryItemOutput,
  type RecordProductOpenedOutput,
  type SetProductDisplayImageOutput,
  type ToolErrorOutput,
  type UploadProductImagesOutput,
} from "@beautio/contracts";
import { BeautioError } from "@beautio/domain";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import {
  createInventoryBatchDescription,
  createInventoryBatchToolName,
  getInventoryItemDescription,
  getInventoryItemToolName,
  recordProductOpenedDescription,
  recordProductOpenedToolName,
  uploadProductImagesDescription,
  uploadProductImagesToolName,
} from "./index.ts";
import { readMcpImageFiles, type McpImageBytes } from "./local-image-files.ts";

export const setProductDisplayImageToolName = "set_product_display_image";

export const setProductDisplayImageDescription =
  "Only after the user confirms both the existing Product and the selected image, replace that Product's shared display image. Every inventory item and card for the same Product changes together. This write has side effects, requires a managed image_asset_id obtained from upload_product_images, and must not be silently retried when the result is unknown.";

export interface ProductionBeautioOperations {
  recordProductOpened(input: unknown): Promise<RecordProductOpenedOutput>;
  getInventoryItem(input: unknown): Promise<GetInventoryItemOutput>;
  uploadProductImages(
    images: readonly McpImageBytes[],
  ): Promise<UploadProductImagesOutput>;
  createInventoryBatch(input: unknown): Promise<CreateInventoryBatchOutput>;
  setProductDisplayImage(
    input: unknown,
  ): Promise<SetProductDisplayImageOutput>;
}

export interface ProductionBeautioMcpServerOptions {
  readonly uploadRoot: string;
}

/**
 * Builds the thin production stdio adapter around the remote HTTPS operations.
 *
 * @param operations - Remote adapter that validates production HTTP responses.
 * @param options - Canonical local root allowed for confirmed image inputs.
 * @returns An MCP server exposing five production-backed inventory tools.
 */
export function createProductionBeautioMcpServer(
  operations: ProductionBeautioOperations,
  options: ProductionBeautioMcpServerOptions,
): McpServer {
  if (options.uploadRoot.trim().length === 0) {
    throw new Error("BEAUTIO_MCP_UPLOAD_ROOT is required");
  }
  const server = new McpServer(
    { name: "beautio-production", version: "0.3.0" },
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
    async (input) => execute(() => operations.recordProductOpened(input)),
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
    async (input) => execute(() => operations.getInventoryItem(input)),
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
        return operations.uploadProductImages(images);
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
    async (input) => execute(() => operations.createInventoryBatch(input)),
  );

  server.registerTool(
    setProductDisplayImageToolName,
    {
      title: "Set shared Product display image",
      description: setProductDisplayImageDescription,
      inputSchema: setProductDisplayImageInputSchema,
      outputSchema: setProductDisplayImageOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => execute(() => operations.setProductDisplayImage(input)),
  );

  return server;
}

async function execute(operation: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const output = await operation();
    if (!isRecord(output)) {
      throw new Error("operation returned a non-object result");
    }
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

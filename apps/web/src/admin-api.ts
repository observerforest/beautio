import {
  inventoryItemIdSchema,
  inventoryListOutputSchema,
  updateInventoryItemCustomNotesInputSchema,
  updateInventoryItemCustomNotesOutputSchema,
  updateInventoryItemFactsOutputSchema,
  updateInventoryItemFactsInputSchema,
  updateProductInputSchema,
  updateProductOutputSchema,
  type InventoryListOutput,
  type InventoryStateOutput,
  type UpdateInventoryItemCustomNotesInput,
  type UpdateInventoryItemCustomNotesOutput,
  type UpdateProductInput,
  type UpdateProductOutput,
} from "@beautio/contracts";

export type OpenedOnAccuracy = NonNullable<
  InventoryStateOutput["opened_on_accuracy"]
>;
export type ProductFactsInput = UpdateProductInput;
export type InventoryItemCustomNotesInput = UpdateInventoryItemCustomNotesInput;
export type UpdatedInventoryItemCustomNotes =
  UpdateInventoryItemCustomNotesOutput["inventory_item"];
export interface InventoryItemFactsInput {
  readonly as_of: string;
  readonly lifecycle_status: "unopened" | "opened";
  readonly opened_on: string | null;
  readonly opened_on_accuracy: OpenedOnAccuracy | null;
  readonly expires_on: string | null;
  readonly pao_duration_months: number | null;
}

export interface UploadedImageAsset {
  readonly image_asset_id: string;
  readonly media_type: "image/jpeg" | "image/png" | "image/webp";
  readonly byte_size: number;
  readonly expires_at: string;
}

export type UpdatedProduct = UpdateProductOutput["product"];

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export type PrivateImageVariant = "original" | "card";

interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly ref?: string;
  };
}

/**
 * Represents a stable HTTP failure without retaining request credentials.
 */
export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly ref: string | undefined;

  /**
   * Creates a sanitized error from the public HTTP error envelope.
   *
   * @param status - HTTP status returned by the server, or zero for a client-side response failure.
   * @param code - Stable public error code.
   * @param message - User-safe error message that never includes the Admin token.
   * @param ref - Optional opaque reference supplied by the server.
   */
  constructor(
    status: number,
    code: string,
    message: string,
    ref?: string,
  ) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
    this.ref = ref;
  }
}

/**
 * Calls the protected Beautio management HTTP surface for one unlocked browser tab.
 *
 * The Admin token remains only in this object's private memory. Destroying the client
 * aborts in-flight requests, clears the token, and revokes every private image Blob URL.
 */
export class AdminApiClient {
  #token: string;
  readonly #fetch: FetchLike;
  readonly #objectUrlApi: ObjectUrlApi;
  readonly #activeControllers = new Set<AbortController>();
  readonly #objectUrls = new Set<string>();
  #destroyed = false;

  /**
   * Creates a tab-scoped authenticated client.
   *
   * @param token - Non-empty Admin Bearer token supplied by the user for this tab.
   * @param fetchImplementation - Fetch implementation used for HTTP requests.
   * @param objectUrlApi - Browser Blob URL implementation used for private images.
   */
  constructor(
    token: string,
    fetchImplementation: FetchLike = (input, init) =>
      globalThis.fetch(input, init),
    objectUrlApi: ObjectUrlApi = URL,
  ) {
    if (token.length === 0) {
      throw new TypeError("Admin token is required.");
    }
    this.#token = token;
    this.#fetch = fetchImplementation;
    this.#objectUrlApi = objectUrlApi;
  }

  /**
   * Reads the complete inventory projection for an explicit calendar date.
   *
   * @param asOf - Real YYYY-MM-DD date used for server-side derivation.
   * @returns The validated one-bottle-per-item inventory response.
   */
  async readInventory(asOf: string): Promise<InventoryListOutput> {
    const body = await this.#request(
      `/api/inventory?as_of=${encodeURIComponent(asOf)}`,
      { headers: { accept: "application/json" } },
      readJson,
    );
    try {
      return inventoryListOutputSchema.parse(body);
    } catch {
      throw invalidResponse();
    }
  }

  /**
   * Uploads one user-selected product display image as a temporary managed asset.
   *
   * @param image - JPEG, PNG, or static WebP file selected in the management page.
   * @returns The server-generated asset facts needed for a later Product update.
   */
  async uploadProductImage(image: File): Promise<UploadedImageAsset> {
    const formData = new FormData();
    formData.set("image", image);
    const body = await this.#request(
      "/api/admin/image-assets",
      {
        method: "POST",
        body: formData,
        headers: { accept: "application/json" },
      },
      readJson,
    );
    return parseUploadedImageAsset(body);
  }

  /**
   * Replaces the complete editable Product fact set without sending legacy image_ref.
   *
   * @param productId - Opaque existing Product identifier.
   * @param input - Complete user-confirmed Product facts.
   * @returns The server-confirmed Product projection.
   */
  async updateProduct(
    productId: string,
    input: ProductFactsInput,
  ): Promise<UpdatedProduct> {
    const parsedInput = updateProductInputSchema.parse(input);
    const body = await this.#request(
      `/api/admin/products/${encodeURIComponent(productId)}`,
      jsonRequest("PUT", parsedInput),
      readJson,
    );
    try {
      return updateProductOutputSchema.parse(body).product;
    } catch {
      throw invalidResponse();
    }
  }

  /**
   * Replaces the complete editable direct-fact set for one inventory item.
   *
   * @param inventoryItemId - Opaque existing InventoryItem identifier.
   * @param input - Complete user-confirmed direct facts plus explicit as_of.
   * @returns A promise that resolves only after a valid JSON success response is received.
   */
  async updateInventoryItemFacts(
    inventoryItemId: string,
    input: InventoryItemFactsInput,
  ): Promise<void> {
    const parsedInput = updateInventoryItemFactsInputSchema.parse(input);
    const body = await this.#request(
      `/api/admin/inventory-items/${encodeURIComponent(inventoryItemId)}/facts`,
      jsonRequest("PUT", parsedInput),
      readJson,
    );
    try {
      updateInventoryItemFactsOutputSchema.parse(body);
    } catch {
      throw invalidResponse();
    }
  }

  /**
   * Replaces only one inventory item's private custom notes at any lifecycle state.
   *
   * @param inventoryItemId - Opaque existing InventoryItem identifier.
   * @param input - Explicit nullable notes body; null clears the stored value.
   * @returns The server-confirmed inventory identifier and custom notes.
   */
  async updateInventoryItemCustomNotes(
    inventoryItemId: string,
    input: InventoryItemCustomNotesInput,
  ): Promise<UpdatedInventoryItemCustomNotes> {
    const normalizedInventoryItemId = inventoryItemIdSchema.parse(
      inventoryItemId,
    );
    const parsedInput = updateInventoryItemCustomNotesInputSchema.parse(input);
    const body = await this.#request(
      `/api/admin/inventory-items/${encodeURIComponent(normalizedInventoryItemId)}/custom-notes`,
      jsonRequest("PUT", parsedInput),
      readJson,
    );
    try {
      const committed =
        updateInventoryItemCustomNotesOutputSchema.parse(body).inventory_item;
      if (
        committed.inventory_item_id !== normalizedInventoryItemId ||
        committed.custom_notes !== parsedInput.custom_notes
      ) {
        throw invalidResponse();
      }
      return committed;
    } catch {
      throw invalidResponse();
    }
  }

  /**
   * Fetches a protected managed image and exposes it only through a tracked Blob URL.
   *
   * @param imageAssetId - Opaque existing ImageAsset identifier.
   * @param variant - Original evidence image or the server-managed card rendition.
   * @returns A Blob URL that will be revoked when the client is destroyed or refreshed.
   */
  async loadPrivateImage(
    imageAssetId: string,
    variant: PrivateImageVariant = "original",
  ): Promise<string> {
    const variantQuery = variant === "card" ? "?variant=card" : "";
    const blob = await this.#request(
      `/api/image-assets/${encodeURIComponent(imageAssetId)}/content${variantQuery}`,
      { headers: { accept: "image/jpeg,image/png,image/webp" } },
      (response) => response.blob(),
    );
    const objectUrl = this.#objectUrlApi.createObjectURL(blob);
    if (this.#destroyed) {
      this.#objectUrlApi.revokeObjectURL(objectUrl);
      throw new DOMException("The Admin session was locked.", "AbortError");
    }
    this.#objectUrls.add(objectUrl);
    return objectUrl;
  }

  /**
   * Revokes one no-longer-rendered private image URL.
   *
   * @param objectUrl - Blob URL previously returned by loadPrivateImage.
   * @returns Nothing. Unknown or already-revoked URLs are ignored.
   */
  revokeObjectUrl(objectUrl: string): void {
    if (!this.#objectUrls.delete(objectUrl)) {
      return;
    }
    this.#objectUrlApi.revokeObjectURL(objectUrl);
  }

  /**
   * Revokes every private image URL created for the current rendered inventory.
   *
   * @returns Nothing. Existing image elements must no longer rely on the revoked URLs.
   */
  revokeAllObjectUrls(): void {
    for (const objectUrl of this.#objectUrls) {
      this.#objectUrlApi.revokeObjectURL(objectUrl);
    }
    this.#objectUrls.clear();
  }

  /**
   * Ends the tab session and removes all credential-backed client resources.
   *
   * @returns Nothing. The destroyed client rejects every later request.
   */
  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#token = "";
    for (const controller of this.#activeControllers) {
      controller.abort();
    }
    this.#activeControllers.clear();
    this.revokeAllObjectUrls();
  }

  async #request<T>(
    path: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    if (this.#destroyed) {
      throw new DOMException("The Admin session was locked.", "AbortError");
    }

    const controller = new AbortController();
    this.#activeControllers.add(controller);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.#token}`);
    try {
      const response = await this.#fetch(path, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw await responseError(response);
      }
      return await consume(response);
    } finally {
      this.#activeControllers.delete(controller);
    }
  }
}

function jsonRequest(method: "PUT", body: object): RequestInit {
  return {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

async function responseError(response: Response): Promise<AdminApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return new AdminApiError(
      response.status,
      "HTTP_ERROR",
      `服务器返回了 HTTP ${response.status}。`,
    );
  }

  if (isApiErrorBody(body)) {
    return new AdminApiError(
      response.status,
      body.error.code,
      body.error.message,
      body.error.ref,
    );
  }
  return new AdminApiError(
    response.status,
    "HTTP_ERROR",
    `服务器返回了 HTTP ${response.status}。`,
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw invalidResponse();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function invalidResponse(): AdminApiError {
  return new AdminApiError(
    0,
    "INVALID_RESPONSE",
    "服务器返回了无法识别的响应。",
  );
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!isRecord(value) || !isRecord(value.error)) {
    return false;
  }
  return (
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    (value.error.ref === undefined || typeof value.error.ref === "string")
  );
}

function parseUploadedImageAsset(value: unknown): UploadedImageAsset {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["asset"]) ||
    !isRecord(value.asset) ||
    !hasExactKeys(value.asset, [
      "image_asset_id",
      "media_type",
      "byte_size",
      "expires_at",
    ])
  ) {
    throw invalidResponse();
  }
  const asset = value.asset;
  if (
    typeof asset.image_asset_id !== "string" ||
    !isImageMediaType(asset.media_type) ||
    typeof asset.byte_size !== "number" ||
    !Number.isInteger(asset.byte_size) ||
    asset.byte_size <= 0 ||
    typeof asset.expires_at !== "string"
  ) {
    throw invalidResponse();
  }
  return {
    image_asset_id: asset.image_asset_id,
    media_type: asset.media_type,
    byte_size: asset.byte_size,
    expires_at: asset.expires_at,
  };
}

function isImageMediaType(
  value: unknown,
): value is UploadedImageAsset["media_type"] {
  return (
    value === "image/jpeg" || value === "image/png" || value === "image/webp"
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export const beautioErrorCodes = [
  "INVALID_INPUT",
  "INVENTORY_ITEM_NOT_FOUND",
  "INVENTORY_ITEM_TERMINAL",
  "OPENED_ON_CONFLICT",
  "UNAUTHORIZED",
  "PRODUCT_NOT_FOUND",
  "IMAGE_ASSET_NOT_FOUND",
  "IMAGE_ASSET_EXPIRED",
  "BATCH_CONFLICT",
  "UNSUPPORTED_MEDIA_TYPE",
  "UPLOAD_TOO_LARGE",
  "FILE_SOURCE_REJECTED",
  "UPLOAD_FAILED",
  "INTERNAL_ERROR",
] as const;

export type BeautioErrorCode = (typeof beautioErrorCodes)[number];

export class BeautioError extends Error {
  readonly code: BeautioErrorCode;
  readonly ref: string | undefined;

  /**
   * Creates a stable, externally distinguishable Beautio business error.
   *
   * @param code - The stable error code exposed by application adapters.
   * @param message - A human-readable explanation that does not replace the code.
   * @param ref - Optional safe input reference associated with the failure.
   */
  constructor(code: BeautioErrorCode, message: string, ref?: string) {
    super(message);
    this.name = "BeautioError";
    this.code = code;
    this.ref = ref;
  }
}

import { BeautioError } from "@beautio/domain";

export function unsupportedImage(): BeautioError {
  return new BeautioError(
    "UNSUPPORTED_MEDIA_TYPE",
    "image must be a decodable JPEG, PNG, or static WebP",
  );
}

export function isPixelLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /pixel limit|input image exceeds pixel limit/i.test(error.message)
  );
}

export function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("image storage operation was aborted");
  }
}

import { BeautioError } from "@beautio/domain";
import sharp from "sharp";
import { isPixelLimitError, unsupportedImage } from "./errors.ts";
import { MAX_IMAGE_PIXELS, toMediaType } from "./sharp-options.ts";
import type { InspectedImage } from "./types.ts";

/**
 * Decodes supported raster bytes and reports only facts needed by the upload use case.
 *
 * @param bytes - Untrusted candidate image bytes already bounded by the caller.
 * @returns Verified media type, dimensions, and animation state.
 */
export async function inspectManagedImage(
  bytes: Uint8Array,
): Promise<InspectedImage> {
  if (bytes.byteLength === 0) {
    throw unsupportedImage();
  }

  try {
    const image = sharp(bytes, {
      animated: true,
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    const mediaType = toMediaType(metadata.format);
    const width = metadata.width;
    const height = metadata.height;
    if (width === undefined || height === undefined || width < 1 || height < 1) {
      throw unsupportedImage();
    }
    if (width * height > MAX_IMAGE_PIXELS) {
      throw new BeautioError(
        "UPLOAD_TOO_LARGE",
        "image exceeds the 40 megapixel limit",
      );
    }

    const animated = (metadata.pages ?? 1) > 1;
    if (animated) {
      throw unsupportedImage();
    }

    // Force a full pixel decode. Metadata sniffing alone is not enough to accept
    // truncated or otherwise undecodable content as a managed image.
    await image.clone().raw().toBuffer();
    return { mediaType, width, height, animated: false };
  } catch (error) {
    if (error instanceof BeautioError) {
      throw error;
    }
    if (isPixelLimitError(error)) {
      throw new BeautioError(
        "UPLOAD_TOO_LARGE",
        "image exceeds the 40 megapixel limit",
      );
    }
    throw unsupportedImage();
  }
}

/** Shared inspector adapter for the application service dependency port. */
export const sharpImageInspector = { inspect: inspectManagedImage } as const;

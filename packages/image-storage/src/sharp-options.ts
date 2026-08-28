import sharp from "sharp";
import { unsupportedImage } from "./errors.ts";
import type { ManagedImageMediaType } from "./types.ts";

export const MAX_IMAGE_PIXELS = 40_000_000;

export function sharpInputOptions(): sharp.SharpOptions {
  return {
    autoOrient: true,
    failOn: "error",
    limitInputPixels: MAX_IMAGE_PIXELS,
    sequentialRead: true,
  };
}

export function toMediaType(
  format: string | undefined,
): ManagedImageMediaType {
  if (format === "jpeg") {
    return "image/jpeg";
  }
  if (format === "png") {
    return "image/png";
  }
  if (format === "webp") {
    return "image/webp";
  }
  throw unsupportedImage();
}

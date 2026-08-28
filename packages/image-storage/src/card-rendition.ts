import { BeautioError } from "@beautio/domain";
import sharp from "sharp";
import { decideCardCrop, mapCropToSource } from "./crop.ts";
import { isPixelLimitError, unsupportedImage } from "./errors.ts";
import {
  MAX_IMAGE_PIXELS,
  sharpInputOptions,
  toMediaType,
} from "./sharp-options.ts";
import type {
  CardImageRendition,
  ManagedImageMediaType,
} from "./types.ts";

const CARD_IMAGE_MAX_EDGE = 960;
const CROP_ANALYSIS_MAX_EDGE = 512;

/**
 * Creates a non-destructive card display rendition from a managed image.
 *
 * Near-white or transparent outer background is cropped only when conservative
 * subject-size, density, and edge-confidence checks pass. A confident crop
 * produces a static WebP whose longest edge is at most 960 pixels; its aspect
 * ratio is preserved and it is never padded or cropped to a forced card shape.
 * Otherwise an exact copy of the original bytes and media type is returned as
 * `unchanged`, together with the reason for that conservative fallback.
 *
 * @param bytes - Decodable JPEG, PNG, or static WebP source bytes.
 * @returns New rendition bytes together with the applied crop or explicit fallback reason.
 */
export async function createCardImageRendition(
  bytes: Uint8Array,
): Promise<CardImageRendition> {
  const source = await readRenditionSourceMetadata(bytes);
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  const analysis = await sharp(bytes, sharpInputOptions())
    .resize({
      width: CROP_ANALYSIS_MAX_EDGE,
      height: CROP_ANALYSIS_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const cropDecision = decideCardCrop(
    analysis.data,
    analysis.info.width,
    analysis.info.height,
  );
  if (cropDecision.crop === null) {
    return {
      outcome: "unchanged",
      bytes: Uint8Array.from(bytes),
      mediaType: source.mediaType,
      width: sourceWidth,
      height: sourceHeight,
      crop: null,
      fallbackReason: cropDecision.fallbackReason,
    };
  }

  const crop = mapCropToSource(
    cropDecision.crop,
    analysis.info.width,
    analysis.info.height,
    sourceWidth,
    sourceHeight,
  );
  const rendered = await sharp(bytes, sharpInputOptions())
    .extract(crop)
    .resize({
      width: CARD_IMAGE_MAX_EDGE,
      height: CARD_IMAGE_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 82, effort: 4, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });
  return {
    outcome: "rendered",
    bytes: rendered.data,
    mediaType: "image/webp",
    width: rendered.info.width,
    height: rendered.info.height,
    crop,
    fallbackReason: null,
  };
}

async function readRenditionSourceMetadata(bytes: Uint8Array): Promise<{
  readonly mediaType: ManagedImageMediaType;
  readonly width: number;
  readonly height: number;
}> {
  if (bytes.byteLength === 0) {
    throw unsupportedImage();
  }
  try {
    const metadata = await sharp(bytes, sharpInputOptions()).metadata();
    const mediaType = toMediaType(metadata.format);
    const width = metadata.autoOrient.width;
    const height = metadata.autoOrient.height;
    if (width < 1 || height < 1) {
      throw unsupportedImage();
    }
    if (width * height > MAX_IMAGE_PIXELS) {
      throw new BeautioError(
        "UPLOAD_TOO_LARGE",
        "image exceeds the 40 megapixel limit",
      );
    }
    if ((metadata.pages ?? 1) > 1) {
      throw unsupportedImage();
    }
    return { mediaType, width, height };
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

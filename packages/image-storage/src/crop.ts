import type {
  CardImageCropFallbackReason,
  ImageCropRectangle,
} from "./types.ts";

const NEAR_WHITE_CHANNEL_MINIMUM = 236;
const TRUSTED_BACKGROUND_EDGE_RATIO = 0.985;
const MIN_SUBJECT_WIDTH_RATIO = 0.12;
const MIN_SUBJECT_HEIGHT_RATIO = 0.18;
const MIN_SUBJECT_AREA_RATIO = 0.08;
const MIN_FOREGROUND_DENSITY = 0.35;
const SAFETY_MARGIN_RATIO = 0.08;
const MIN_CROP_AREA_REDUCTION_RATIO = 0.12;
const MAX_CROP_AREA_REDUCTION_RATIO = 0.7;

type CropDecision =
  | {
      readonly crop: ImageCropRectangle;
      readonly fallbackReason: null;
    }
  | {
      readonly crop: null;
      readonly fallbackReason: CardImageCropFallbackReason;
    };

interface ForegroundBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly pixelCount: number;
}

export function decideCardCrop(
  pixels: Uint8Array,
  width: number,
  height: number,
): CropDecision {
  const borderThickness = Math.min(
    8,
    Math.max(2, Math.ceil(Math.min(width, height) * 0.02)),
  );
  const edgeTotals = {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  };
  const edgeBackgrounds = {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  };
  let bounds: ForegroundBounds | null = null;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const background = isNearWhiteAfterFlattening(pixels, offset);
      countEdgePixel(
        x,
        y,
        width,
        height,
        borderThickness,
        background,
        edgeTotals,
        edgeBackgrounds,
      );
      if (!background) {
        bounds = extendForegroundBounds(bounds, x, y);
      }
    }
  }

  if (bounds === null) {
    return fallback("subject-not-found");
  }

  const subjectWidth = bounds.right - bounds.left + 1;
  const subjectHeight = bounds.bottom - bounds.top + 1;
  const subjectArea = subjectWidth * subjectHeight;
  if (
    subjectWidth / width < MIN_SUBJECT_WIDTH_RATIO ||
    subjectHeight / height < MIN_SUBJECT_HEIGHT_RATIO ||
    subjectArea / (width * height) < MIN_SUBJECT_AREA_RATIO
  ) {
    return fallback("subject-too-small");
  }
  if (bounds.pixelCount / subjectArea < MIN_FOREGROUND_DENSITY) {
    return fallback("foreground-too-sparse");
  }

  const trustedEdges = {
    left:
      edgeBackgrounds.left / edgeTotals.left >=
      TRUSTED_BACKGROUND_EDGE_RATIO,
    right:
      edgeBackgrounds.right / edgeTotals.right >=
      TRUSTED_BACKGROUND_EDGE_RATIO,
    top:
      edgeBackgrounds.top / edgeTotals.top >= TRUSTED_BACKGROUND_EDGE_RATIO,
    bottom:
      edgeBackgrounds.bottom / edgeTotals.bottom >=
      TRUSTED_BACKGROUND_EDGE_RATIO,
  };
  if (!Object.values(trustedEdges).some(Boolean)) {
    return fallback("background-not-confident");
  }

  const horizontalMargin = Math.max(
    2,
    Math.ceil(subjectWidth * SAFETY_MARGIN_RATIO),
  );
  const verticalMargin = Math.max(
    2,
    Math.ceil(subjectHeight * SAFETY_MARGIN_RATIO),
  );
  const left = trustedEdges.left
    ? Math.max(0, bounds.left - horizontalMargin)
    : 0;
  const right = trustedEdges.right
    ? Math.min(width, bounds.right + 1 + horizontalMargin)
    : width;
  const top = trustedEdges.top
    ? Math.max(0, bounds.top - verticalMargin)
    : 0;
  const bottom = trustedEdges.bottom
    ? Math.min(height, bounds.bottom + 1 + verticalMargin)
    : height;
  const crop = {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
  const reduction = 1 - (crop.width * crop.height) / (width * height);
  if (reduction > MAX_CROP_AREA_REDUCTION_RATIO) {
    return fallback("crop-too-aggressive");
  }
  if (reduction < MIN_CROP_AREA_REDUCTION_RATIO) {
    return fallback("no-meaningful-empty-margin");
  }
  return { crop, fallbackReason: null };
}

function isNearWhiteAfterFlattening(
  pixels: Uint8Array,
  offset: number,
): boolean {
  const alpha = pixels[offset + 3] ?? 255;
  const inverseAlpha = 255 - alpha;
  for (let channel = 0; channel < 3; channel += 1) {
    const value = pixels[offset + channel] ?? 0;
    const flattened = (value * alpha + 255 * inverseAlpha) / 255;
    if (flattened < NEAR_WHITE_CHANNEL_MINIMUM) {
      return false;
    }
  }
  return true;
}

function countEdgePixel(
  x: number,
  y: number,
  width: number,
  height: number,
  thickness: number,
  background: boolean,
  totals: Record<"left" | "right" | "top" | "bottom", number>,
  backgrounds: Record<"left" | "right" | "top" | "bottom", number>,
): void {
  for (const [edge, matches] of [
    ["left", x < thickness],
    ["right", x >= width - thickness],
    ["top", y < thickness],
    ["bottom", y >= height - thickness],
  ] as const) {
    if (matches) {
      totals[edge] += 1;
      if (background) {
        backgrounds[edge] += 1;
      }
    }
  }
}

function extendForegroundBounds(
  bounds: ForegroundBounds | null,
  x: number,
  y: number,
): ForegroundBounds {
  if (bounds === null) {
    return { left: x, top: y, right: x, bottom: y, pixelCount: 1 };
  }
  return {
    left: Math.min(bounds.left, x),
    top: Math.min(bounds.top, y),
    right: Math.max(bounds.right, x),
    bottom: Math.max(bounds.bottom, y),
    pixelCount: bounds.pixelCount + 1,
  };
}

export function mapCropToSource(
  crop: ImageCropRectangle,
  analysisWidth: number,
  analysisHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): ImageCropRectangle {
  const left = Math.floor((crop.left * sourceWidth) / analysisWidth);
  const top = Math.floor((crop.top * sourceHeight) / analysisHeight);
  const right = Math.ceil(
    ((crop.left + crop.width) * sourceWidth) / analysisWidth,
  );
  const bottom = Math.ceil(
    ((crop.top + crop.height) * sourceHeight) / analysisHeight,
  );
  return {
    left,
    top,
    width: Math.min(sourceWidth, right) - left,
    height: Math.min(sourceHeight, bottom) - top,
  };
}

function fallback(reason: CardImageCropFallbackReason): CropDecision {
  return { crop: null, fallbackReason: reason };
}

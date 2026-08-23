import { BeautioError } from "@beautio/domain";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";

const MAX_IMAGE_PIXELS = 40_000_000;
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CARD_IMAGE_MAX_EDGE = 960;
const CROP_ANALYSIS_MAX_EDGE = 512;
const NEAR_WHITE_CHANNEL_MINIMUM = 236;
const TRUSTED_BACKGROUND_EDGE_RATIO = 0.985;
const MIN_SUBJECT_WIDTH_RATIO = 0.12;
const MIN_SUBJECT_HEIGHT_RATIO = 0.18;
const MIN_SUBJECT_AREA_RATIO = 0.08;
const MIN_FOREGROUND_DENSITY = 0.35;
const SAFETY_MARGIN_RATIO = 0.08;
const MIN_CROP_AREA_REDUCTION_RATIO = 0.12;
const MAX_CROP_AREA_REDUCTION_RATIO = 0.7;
const EMPTY_BYTES = new Uint8Array();

export type ManagedImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export interface InspectedImage {
  readonly mediaType: ManagedImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly animated: boolean;
}

export interface ImageCropRectangle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type CardImageCropFallbackReason =
  | "subject-not-found"
  | "subject-too-small"
  | "foreground-too-sparse"
  | "background-not-confident"
  | "crop-too-aggressive"
  | "no-meaningful-empty-margin";

export type CardImageRendition =
  | {
      readonly outcome: "rendered";
      readonly bytes: Uint8Array;
      readonly mediaType: "image/webp";
      readonly width: number;
      readonly height: number;
      readonly crop: ImageCropRectangle;
      readonly fallbackReason: null;
    }
  | {
      readonly outcome: "unchanged";
      readonly bytes: Uint8Array;
      readonly mediaType: ManagedImageMediaType;
      readonly width: number;
      readonly height: number;
      readonly crop: null;
      readonly fallbackReason: CardImageCropFallbackReason;
    };

export interface StoredCardImageRendition {
  readonly mediaType: "image/webp";
  readonly bytes: Uint8Array;
}

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

/**
 * Caches non-authoritative card renditions beside the private original store.
 *
 * The deterministic `card-v1` sidecar path contains only a SHA-256 digest of
 * the validated opaque storage key. Positive and conservative-negative results
 * are cached before the original is read again, and rendering is serialized
 * across keys to bound native decoder memory. The original is never overwritten.
 * Deletion permanently retires the key for this provider process so a stale
 * read that already passed repository checks cannot recreate a sidecar.
 */
export class FileImageRenditionProvider {
  readonly #cardDirectory: string;
  readonly #renderCard: (
    bytes: Uint8Array,
  ) => Promise<CardImageRendition>;
  readonly #inFlight = new Map<
    string,
    Promise<StoredCardImageRendition | null>
  >();
  readonly #retired = new Set<string>();
  #renderTail: Promise<void> = Promise.resolve();

  /**
   * Creates a filesystem-backed card rendition cache.
   *
   * @param rootDirectory - Private image root shared with the original asset store.
   * @param renderCard - Optional renderer seam used by tests; production uses the Sharp renderer.
   */
  constructor(
    rootDirectory: string,
    renderCard: (
      bytes: Uint8Array,
    ) => Promise<CardImageRendition> = createCardImageRendition,
  ) {
    if (rootDirectory.trim().length === 0) {
      throw new BeautioError("INVALID_INPUT", "image storage root is required");
    }
    const root = resolve(rootDirectory);
    this.#cardDirectory = join(root, ".renditions", "card-v1");
    this.#renderCard = renderCard;
  }

  /**
   * Reads a cached card result or creates it once for concurrent local callers.
   *
   * A conservative renderer decline returns null and writes a private zero-byte
   * negative marker. Successful renditions are atomically persisted before return.
   *
   * @param storageKey - Valid opaque storage key of the immutable original asset.
   * @param loadOriginal - Lazy original reader called only after both caches miss and a render slot is held.
   * @returns WebP sidecar bytes, or null when the renderer deliberately declines.
   */
  async readOrCreateCard(
    storageKey: string,
    loadOriginal: () => Promise<Uint8Array>,
  ): Promise<StoredCardImageRendition | null> {
    const paths = this.pathsFor(storageKey);
    if (this.#retired.has(paths.card)) {
      return null;
    }
    let task = this.#inFlight.get(paths.card);
    if (task === undefined) {
      task = this.readOrCreateAtPaths(paths, loadOriginal);
      this.#inFlight.set(paths.card, task);
    }

    try {
      return cloneStoredRendition(await task);
    } finally {
      if (this.#inFlight.get(paths.card) === task) {
        this.#inFlight.delete(paths.card);
      }
    }
  }

  /**
   * Idempotently deletes the known card-v1 sidecar for one original asset.
   *
   * The key is tombstoned before the first await. Active generation is allowed
   * to settle, then both positive and negative caches are removed. Later stale
   * reads in this process cannot recreate either sidecar after cleanup.
   *
   * @param storageKey - Valid opaque storage key of the original managed image.
   * @returns Nothing once the known sidecar is absent.
   */
  async deleteForAsset(storageKey: string): Promise<void> {
    const paths = this.pathsFor(storageKey);
    this.#retired.add(paths.card);
    const active = this.#inFlight.get(paths.card);
    if (active !== undefined) {
      await active.catch(() => undefined);
    }
    await deleteOptionalFile(paths.card);
    await deleteOptionalFile(paths.negative);
  }

  private async readOrCreateAtPaths(
    paths: CardCachePaths,
    loadOriginal: () => Promise<Uint8Array>,
  ): Promise<StoredCardImageRendition | null> {
    const cached = await readCachedCard(paths);
    if (cached !== undefined) {
      return cached;
    }

    return this.runRenderSerially(async () => {
      if (this.#retired.has(paths.card)) return null;
      const rechecked = await readCachedCard(paths);
      if (rechecked !== undefined) return rechecked;

      const originalBytes = await loadOriginal();
      if (this.#retired.has(paths.card)) return null;
      const rendered = await this.#renderCard(originalBytes);
      if (this.#retired.has(paths.card)) return null;

      if (rendered.outcome === "unchanged") {
        await writePrivateFileAtomically(
          this.#cardDirectory,
          paths.negative,
          EMPTY_BYTES,
        );
        if (this.#retired.has(paths.card)) {
          await deleteOptionalFile(paths.negative);
        }
        return null;
      }

      await writePrivateFileAtomically(
        this.#cardDirectory,
        paths.card,
        rendered.bytes,
      );
      if (this.#retired.has(paths.card)) {
        await deleteOptionalFile(paths.card);
        return null;
      }
      return { mediaType: "image/webp", bytes: rendered.bytes };
    });
  }

  private pathsFor(storageKey: string): CardCachePaths {
    assertStorageKey(storageKey);
    const digest = createHash("sha256").update(storageKey).digest("hex");
    return {
      card: join(this.#cardDirectory, `${digest}.webp`),
      negative: join(this.#cardDirectory, `${digest}.unchanged`),
    };
  }

  private async runRenderSerially<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#renderTail;
    let release!: () => void;
    this.#renderTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/**
 * Stores managed image bytes under opaque server-generated keys outside the web root.
 */
export class FileImageAssetStorage {
  readonly #root: string;

  /**
   * Creates a filesystem-backed image store.
   *
   * @param rootDirectory - Controlled private directory, never a public URL path.
   */
  constructor(rootDirectory: string) {
    if (rootDirectory.trim().length === 0) {
      throw new BeautioError("INVALID_INPUT", "image storage root is required");
    }
    this.#root = resolve(rootDirectory);
  }

  /**
   * Persists bytes once under a validated opaque storage key.
   *
   * @param storageKey - Server-generated key containing no path separators.
   * @param bytes - Previously validated image bytes.
   * @param signal - Optional deadline signal for a bounded HTTP Action upload.
   * @returns Nothing after the durable file handle has been synced and closed.
   */
  async put(
    storageKey: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const path = this.pathFor(storageKey);
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const handle = await open(path, "wx", 0o600);
    try {
      if (signal === undefined) {
        await handle.writeFile(bytes);
      } else {
        await handle.writeFile(bytes, { signal });
      }
      await handle.sync();
      throwIfAborted(signal);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
    await handle.close();
  }

  /**
   * Reads bytes for a previously persisted opaque storage key.
   *
   * @param storageKey - Internal key read from trusted ImageAsset metadata.
   * @returns A fresh buffer containing the stored bytes.
   */
  async get(storageKey: string): Promise<Uint8Array> {
    return readFile(this.pathFor(storageKey));
  }

  /**
   * Deletes one stored object; an already absent object is treated as deleted.
   *
   * @param storageKey - Internal key read from trusted ImageAsset metadata.
   * @returns Nothing once the object is absent.
   */
  async delete(storageKey: string): Promise<void> {
    try {
      await unlink(this.pathFor(storageKey));
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }

  /**
   * Lists valid opaque object keys so cleanup can discover metadata-free orphans.
   *
   * @returns Valid storage keys currently present in the private root.
   */
  async listKeys(): Promise<readonly string[]> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.#root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && STORAGE_KEY_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  private pathFor(storageKey: string): string {
    assertStorageKey(storageKey);
    const path = resolve(join(this.#root, storageKey));
    if (path === this.#root || !path.startsWith(`${this.#root}/`)) {
      throw new BeautioError("INVALID_INPUT", "invalid image storage key");
    }
    return path;
  }
}

function toMediaType(format: string | undefined): ManagedImageMediaType {
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

async function readOptionalFile(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
}

interface CardCachePaths {
  readonly card: string;
  readonly negative: string;
}

async function readCachedCard(
  paths: CardCachePaths,
): Promise<StoredCardImageRendition | null | undefined> {
  const card = await readOptionalFile(paths.card);
  if (card !== null) {
    return { mediaType: "image/webp", bytes: card };
  }
  const negative = await readOptionalFile(paths.negative);
  return negative === null ? undefined : null;
}

async function deleteOptionalFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

async function writePrivateFileAtomically(
  directory: string,
  destination: string,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}-${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  try {
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function cloneStoredRendition(
  rendition: StoredCardImageRendition | null,
): StoredCardImageRendition | null {
  if (rendition === null) {
    return null;
  }
  return {
    mediaType: rendition.mediaType,
    bytes: Uint8Array.from(rendition.bytes),
  };
}

function assertStorageKey(storageKey: string): void {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) {
    throw new BeautioError("INVALID_INPUT", "invalid image storage key");
  }
}

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

function decideCardCrop(
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

function sharpInputOptions(): sharp.SharpOptions {
  return {
    autoOrient: true,
    failOn: "error",
    limitInputPixels: MAX_IMAGE_PIXELS,
    sequentialRead: true,
  };
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

function mapCropToSource(
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

function unsupportedImage(): BeautioError {
  return new BeautioError(
    "UNSUPPORTED_MEDIA_TYPE",
    "image must be a decodable JPEG, PNG, or static WebP",
  );
}

function isPixelLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /pixel limit|input image exceeds pixel limit/i.test(error.message)
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("image storage operation was aborted");
  }
}

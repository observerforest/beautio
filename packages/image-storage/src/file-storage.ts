import { BeautioError } from "@beautio/domain";
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCardImageRendition } from "./card-rendition.ts";
import { isMissingFile, throwIfAborted } from "./errors.ts";
import {
  EMPTY_BYTES,
  STORAGE_KEY_PATTERN,
  assertStorageKey,
  cloneStoredRendition,
  deleteOptionalFile,
  readCachedCard,
  writePrivateFileAtomically,
  type CardCachePaths,
} from "./file-io.ts";
import type {
  CardImageRendition,
  StoredCardImageRendition,
} from "./types.ts";

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

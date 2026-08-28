import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { BeautioError } from "@beautio/domain";
import { isMissingFile } from "./errors.ts";
import type { StoredCardImageRendition } from "./types.ts";

export const STORAGE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const EMPTY_BYTES = new Uint8Array();

export interface CardCachePaths {
  readonly card: string;
  readonly negative: string;
}

export async function readCachedCard(
  paths: CardCachePaths,
): Promise<StoredCardImageRendition | null | undefined> {
  const card = await readOptionalFile(paths.card);
  if (card !== null) {
    return { mediaType: "image/webp", bytes: card };
  }
  const negative = await readOptionalFile(paths.negative);
  return negative === null ? undefined : null;
}

export async function deleteOptionalFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

export async function writePrivateFileAtomically(
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

export function cloneStoredRendition(
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

export function assertStorageKey(storageKey: string): void {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) {
    throw new BeautioError("INVALID_INPUT", "invalid image storage key");
  }
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

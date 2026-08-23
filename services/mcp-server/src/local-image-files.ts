import { BeautioError } from "@beautio/domain";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export interface McpImageFileReference {
  readonly client_ref: string;
  readonly file_path: string;
}

export interface McpImageBytes {
  readonly source_ref: string;
  readonly bytes: Uint8Array;
}

/**
 * Reads MCP image inputs only from the configured canonical upload root.
 *
 * @param images - Strictly parsed MCP file references.
 * @param configuredRoot - Absolute directory controlled by the local caller.
 * @returns Bounded byte sources with paths removed before the shared use case.
 */
export async function readMcpImageFiles(
  images: readonly McpImageFileReference[],
  configuredRoot: string,
): Promise<readonly McpImageBytes[]> {
  if (!isAbsolute(configuredRoot)) {
    throw rejectedSource();
  }

  let canonicalRoot: string;
  const lexicalRoot = resolve(configuredRoot);
  try {
    canonicalRoot = await realpath(configuredRoot);
    if (!(await lstat(canonicalRoot)).isDirectory()) {
      throw rejectedSource();
    }
  } catch (error) {
    if (error instanceof BeautioError) {
      throw error;
    }
    throw rejectedSource();
  }

  let totalBytes = 0;
  const output: McpImageBytes[] = [];
  for (const image of images) {
    const bytes = await readOne(image.file_path, lexicalRoot, canonicalRoot);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new BeautioError(
        "UPLOAD_TOO_LARGE",
        "image upload exceeds the 50 MiB total limit",
      );
    }
    output.push({ source_ref: image.client_ref, bytes });
  }
  return output;
}

async function readOne(
  filePath: string,
  lexicalRoot: string,
  canonicalRoot: string,
): Promise<Uint8Array> {
  if (!isAbsolute(filePath) || filePath.startsWith("file://")) {
    throw rejectedSource();
  }

  try {
    const lexicalPath = resolve(filePath);
    const lexicalRelativePath = relative(lexicalRoot, lexicalPath);
    if (
      lexicalRelativePath.length === 0 ||
      lexicalRelativePath.startsWith("..") ||
      isAbsolute(lexicalRelativePath)
    ) {
      throw rejectedSource();
    }
    const canonicalPath = await realpath(lexicalPath);
    const pathFromRoot = relative(canonicalRoot, canonicalPath);
    if (
      pathFromRoot.length === 0 ||
      pathFromRoot.startsWith("..") ||
      isAbsolute(pathFromRoot) ||
      canonicalPath !== resolve(canonicalRoot, lexicalRelativePath)
    ) {
      throw rejectedSource();
    }

    const handle = await open(
      canonicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stats = await handle.stat();
      const reopenedCanonicalPath = await realpath(lexicalPath);
      const pathStats = await lstat(canonicalPath);
      if (
        reopenedCanonicalPath !== canonicalPath ||
        !stats.isFile() ||
        !pathStats.isFile() ||
        stats.dev !== pathStats.dev ||
        stats.ino !== pathStats.ino
      ) {
        throw rejectedSource();
      }
      if (stats.size > MAX_FILE_BYTES) {
        throw new BeautioError(
          "UPLOAD_TOO_LARGE",
          "image exceeds the 20 MiB limit",
        );
      }
      const bytes = await readBoundedFile(handle);
      if (bytes.byteLength > MAX_FILE_BYTES) {
        throw new BeautioError(
          "UPLOAD_TOO_LARGE",
          "image exceeds the 20 MiB limit",
        );
      }
      return bytes;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof BeautioError) {
      throw error;
    }
    throw rejectedSource();
  }
}

async function readBoundedFile(handle: FileHandle): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  return bytes.subarray(0, offset);
}

function rejectedSource(): BeautioError {
  return new BeautioError(
    "FILE_SOURCE_REJECTED",
    "MCP file source is not an allowed regular file",
  );
}

import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAXIMUM_CREDENTIAL_FILE_BYTES = 8 * 1024;

export interface ProductionObserveCredentials {
  readonly productionOrigin: string;
  readonly productionAdminBearerToken: string;
}

/**
 * Reads the production observe origin and Admin token from one private file.
 *
 * The file must be an absolute, current-user-owned, non-symlink regular file
 * with exact 0600 permissions. Its supported labels are `URL` and `Admin Key`;
 * unrelated labelled values, such as an Action key, are deliberately ignored.
 *
 * @param filePath - Absolute private credential file path.
 * @returns The two credentials needed by the GET-only local observer.
 */
export async function readProductionObserveCredentials(
  filePath: string,
): Promise<ProductionObserveCredentials> {
  if (!isAbsolute(filePath) || typeof process.getuid !== "function") {
    throw invalidCredentialFile();
  }

  let handle: FileHandle | undefined;
  try {
    const pathStats = await lstat(filePath);
    if (
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      pathStats.uid !== process.getuid() ||
      (pathStats.mode & 0o777) !== 0o600 ||
      pathStats.size < 1 ||
      pathStats.size > MAXIMUM_CREDENTIAL_FILE_BYTES
    ) {
      throw invalidCredentialFile();
    }

    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino ||
      openedStats.uid !== process.getuid() ||
      (openedStats.mode & 0o777) !== 0o600 ||
      openedStats.size !== pathStats.size
    ) {
      throw invalidCredentialFile();
    }

    const bytes = await readBounded(
      handle,
      MAXIMUM_CREDENTIAL_FILE_BYTES + 1,
    );
    if (bytes.byteLength > MAXIMUM_CREDENTIAL_FILE_BYTES) {
      throw invalidCredentialFile();
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseCredentialText(text);
  } catch {
    throw invalidCredentialFile();
  } finally {
    await handle?.close();
  }
}

function parseCredentialText(text: string): ProductionObserveCredentials {
  let productionOrigin: string | undefined;
  let productionAdminBearerToken: string | undefined;

  for (const line of text.split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const label = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (label === "URL") {
      if (productionOrigin !== undefined || value.length === 0) {
        throw invalidCredentialFile();
      }
      productionOrigin = value;
    } else if (label === "Admin Key") {
      if (
        productionAdminBearerToken !== undefined ||
        value.length === 0 ||
        /\s/u.test(value)
      ) {
        throw invalidCredentialFile();
      }
      productionAdminBearerToken = value;
    }
  }

  if (
    productionOrigin === undefined ||
    productionAdminBearerToken === undefined
  ) {
    throw invalidCredentialFile();
  }
  return {
    productionOrigin: validateProductionOrigin(productionOrigin),
    productionAdminBearerToken,
  };
}

function validateProductionOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidCredentialFile();
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname.length === 0 ||
    url.port.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw invalidCredentialFile();
  }
  return url.origin;
}

async function readBounded(
  handle: FileHandle,
  maximumBytes: number,
): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(maximumBytes);
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

function invalidCredentialFile(): Error {
  return new Error(
    "production observe credentials must be a valid current-user 0600 regular file",
  );
}

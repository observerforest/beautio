import { realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE = "no-cache";
const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/i;

const CONTENT_TYPES = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

export interface StaticWebRoot {
  readonly realPath: string;
}

/**
 * Resolves a deployment-controlled static web directory once at process startup.
 *
 * @param rootDirectory - Absolute path to an existing built-web directory.
 * @returns A canonical root safe to reuse for individual HTTP requests.
 * @throws When the path is relative, missing, inaccessible, or not a directory.
 */
export function createStaticWebRoot(rootDirectory: string): StaticWebRoot {
  const trimmed = rootDirectory.trim();
  if (!isAbsolute(trimmed)) {
    throw new Error("BEAUTIO_WEB_ROOT must be an absolute directory path");
  }

  try {
    const realPath = realpathSync(trimmed);
    if (!statSync(realPath).isDirectory()) {
      throw new Error("not a directory");
    }
    return { realPath };
  } catch {
    throw new Error("BEAUTIO_WEB_ROOT must identify an existing directory");
  }
}

/**
 * Serves one regular file beneath a canonical built-web root.
 *
 * Only GET and HEAD are eligible. Reserved API namespaces, dot segments,
 * dotfiles, encoded separators, backslashes, NUL bytes, directories, and
 * symlinks escaping the root are rejected.
 *
 * @param root - Canonical deployment-controlled web root.
 * @param pathname - Encoded URL pathname from the current HTTP request.
 * @param method - Current HTTP method.
 * @param response - Node response that receives a matching static file.
 * @returns True only when a file response was written; false for every miss.
 */
export async function tryServeStaticWeb(
  root: StaticWebRoot,
  pathname: string,
  method: string | undefined,
  response: ServerResponse,
): Promise<boolean> {
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }

  const candidate = candidatePath(root.realPath, pathname);
  if (candidate === null) {
    return false;
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidate.path);
  } catch (error) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }
  if (!isWithinRoot(root.realPath, canonicalPath)) {
    return false;
  }

  const fileStats = await stat(canonicalPath);
  if (!fileStats.isFile()) {
    return false;
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(canonicalPath);
  } catch (error) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }

  response.writeHead(200, {
    "cache-control": candidate.publicPath.startsWith("/assets/")
      ? IMMUTABLE_CACHE
      : REVALIDATE_CACHE,
    "content-length": String(bytes.byteLength),
    "content-type": contentType(canonicalPath),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(method === "HEAD" ? undefined : bytes);
  return true;
}

interface StaticCandidate {
  readonly path: string;
  readonly publicPath: string;
}

function candidatePath(root: string, pathname: string): StaticCandidate | null {
  if (ENCODED_PATH_SEPARATOR.test(pathname)) {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (
    !decoded.startsWith("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0")
  ) {
    return null;
  }

  const publicPath = decoded === "/" ? "/index.html" : decoded;
  if (
    isReservedStaticPath(publicPath, "/api") ||
    isReservedStaticPath(publicPath, "/openapi")
  ) {
    return null;
  }
  const segments = publicPath.slice(1).split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith("."),
    )
  ) {
    return null;
  }

  const path = resolve(root, ...segments);
  return isWithinRoot(root, path) ? { path, publicPath } : null;
}

function isReservedStaticPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isWithinRoot(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot.length > 0 &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function contentType(path: string): string {
  return CONTENT_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream";
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

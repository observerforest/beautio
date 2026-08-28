import {
  imageAssetIdSchema,
  inventoryListOutputSchema,
  isoDateSchema,
} from "@beautio/contracts";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { tokensEqual } from "./bearer.ts";
import {
  createStaticWebRoot,
  tryServeStaticWeb,
  type StaticWebRoot,
} from "./static-web.ts";

const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;
const DEFAULT_MAXIMUM_INVENTORY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAXIMUM_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/i;

export type ProductionObserveFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ProductionObserveHandlerOptions {
  readonly localBearerToken: string;
  readonly productionAdminBearerToken: string;
  readonly productionOrigin: string;
  readonly expectedProductionOrigin: string;
  readonly webRoot: string;
  readonly upstreamFetch?: ProductionObserveFetch;
  readonly upstreamTimeoutMs?: number;
  readonly maximumInventoryBytes?: number;
  readonly maximumImageBytes?: number;
}

interface ValidatedProductionObserveOptions {
  readonly localBearerToken: string;
  readonly productionAdminBearerToken: string;
  readonly productionOrigin: string;
  readonly staticWebRoot: StaticWebRoot;
  readonly upstreamFetch: ProductionObserveFetch;
  readonly upstreamTimeoutMs: number;
  readonly maximumInventoryBytes: number;
  readonly maximumImageBytes: number;
}

interface InventoryUpstreamRoute {
  readonly kind: "inventory";
  readonly pathAndQuery: string;
  readonly accept: string;
  readonly maximumBytes: number;
  readonly asOf: string;
}

interface ImageUpstreamRoute {
  readonly kind: "image";
  readonly pathAndQuery: string;
  readonly accept: string;
  readonly maximumBytes: number;
}

type UpstreamRoute = InventoryUpstreamRoute | ImageUpstreamRoute;

/**
 * Creates a loopback-facing, GET-only adapter for observing production data.
 *
 * The browser authenticates with a separate local token. The production Admin
 * token is added only to two fixed upstream GET routes and is never forwarded
 * from a browser header, returned in a response, or persisted by this adapter.
 *
 * @param options - Local authentication, production origin, and built Web root.
 * @returns A Node request listener that serves the Web build and fixed reads.
 */
export function createProductionObserveHandler(
  options: ProductionObserveHandlerOptions,
): RequestListener {
  const configuration = validateOptions(options);
  return (request, response) => {
    void routeProductionObserveRequest(
      configuration,
      request,
      response,
    ).catch(() => {
      if (!response.headersSent) {
        sendObserveError(
          response,
          500,
          "INTERNAL_ERROR",
          "本地生产观察服务无法完成请求。",
        );
        return;
      }
      response.destroy();
    });
  };
}

async function routeProductionObserveRequest(
  options: ValidatedProductionObserveOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!hasExpectedLoopbackAuthority(request)) {
    request.resume();
    sendObserveError(
      response,
      421,
      "MISDIRECTED_REQUEST",
      "本地生产观察服务拒绝了非预期的访问地址。",
    );
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendObserveJson(response, 200, {
      status: "ok",
      mode: "production-observe",
      access: "read-only",
    });
    return;
  }

  if (isReservedPath(url.pathname, "/api")) {
    if (!hasLocalBearer(request, options.localBearerToken)) {
      request.resume();
      sendObserveError(
        response,
        401,
        "UNAUTHORIZED",
        "有效的本地观察密钥是必需的。",
      );
      return;
    }
    if (request.method !== "GET") {
      request.resume();
      sendObserveError(
        response,
        405,
        "READ_ONLY_MODE",
        "生产观察模式只允许读取，不会转发任何写请求。",
      );
      return;
    }

    const route = parseUpstreamRoute(
      url,
      options.maximumInventoryBytes,
      options.maximumImageBytes,
    );
    if (route === null) {
      sendObserveError(
        response,
        404,
        "ROUTE_NOT_ALLOWED",
        "该接口不在生产只读允许列表中。",
      );
      return;
    }
    await proxyProductionRead(options, route, response);
    return;
  }

  if (
    isReservedPath(url.pathname, "/openapi") ||
    isReservedPath(url.pathname, "/mcp")
  ) {
    sendObserveError(
      response,
      404,
      "ROUTE_NOT_ALLOWED",
      "该接口未在本地生产观察模式开放。",
    );
    return;
  }

  if (
    await tryServeStaticWeb(
      options.staticWebRoot,
      url.pathname,
      request.method,
      response,
    )
  ) {
    return;
  }
  sendObserveError(response, 404, "INVALID_INPUT", "Route not found.");
}

function parseUpstreamRoute(
  url: URL,
  maximumInventoryBytes: number,
  maximumImageBytes: number,
): UpstreamRoute | null {
  if (url.pathname === "/api/inventory") {
    const entries = [...url.searchParams.entries()];
    if (
      entries.length !== 1 ||
      entries[0]?.[0] !== "as_of" ||
      !isoDateSchema.safeParse(entries[0]?.[1]).success
    ) {
      return null;
    }
    return {
      kind: "inventory",
      pathAndQuery: `${url.pathname}?${url.searchParams.toString()}`,
      accept: "application/json",
      maximumBytes: maximumInventoryBytes,
      asOf: entries[0][1],
    };
  }

  const imageAssetId = parseImageAssetId(url.pathname);
  if (imageAssetId === null || !hasAllowedImageQuery(url.searchParams)) {
    return null;
  }
  const query = url.searchParams.toString();
  return {
    kind: "image",
    pathAndQuery: `/api/image-assets/${encodeURIComponent(imageAssetId)}/content${
      query.length === 0 ? "" : `?${query}`
    }`,
    accept: "image/jpeg,image/png,image/webp",
    maximumBytes: maximumImageBytes,
  };
}

function parseImageAssetId(pathname: string): string | null {
  if (ENCODED_PATH_SEPARATOR.test(pathname)) {
    return null;
  }
  const match = /^\/api\/image-assets\/([^/]+)\/content$/.exec(pathname);
  if (match === null || match[1] === undefined) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const parsed = imageAssetIdSchema.safeParse(decoded);
  if (
    decoded.length === 0 ||
    decoded.length > 512 ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(decoded) ||
    !parsed.success ||
    parsed.data !== decoded
  ) {
    return null;
  }
  return parsed.data;
}

function hasAllowedImageQuery(searchParams: URLSearchParams): boolean {
  const entries = [...searchParams.entries()];
  return (
    entries.length === 0 ||
    (entries.length === 1 &&
      entries[0]?.[0] === "variant" &&
      entries[0]?.[1] === "card")
  );
}

async function proxyProductionRead(
  options: ValidatedProductionObserveOptions,
  route: UpstreamRoute,
  response: ServerResponse,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.upstreamTimeoutMs);
  timeout.unref();
  try {
    const upstream = await options.upstreamFetch(
      new URL(route.pathAndQuery, `${options.productionOrigin}/`),
      {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: route.accept,
          authorization: `Bearer ${options.productionAdminBearerToken}`,
          "user-agent": "Beautio-Production-Observe/1",
        },
      },
    );
    await forwardUpstreamResponse(route, upstream, response);
  } catch {
    if (!response.headersSent) {
      sendObserveError(
        response,
        502,
        "UPSTREAM_UNAVAILABLE",
        "生产只读数据暂时无法连接。",
      );
    } else {
      response.destroy();
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function forwardUpstreamResponse(
  route: UpstreamRoute,
  upstream: Response,
  response: ServerResponse,
): Promise<void> {
  if (upstream.status >= 300 && upstream.status < 400) {
    await discardBody(upstream);
    sendObserveError(
      response,
      502,
      "UPSTREAM_REDIRECT_REJECTED",
      "生产只读接口返回了未允许的重定向。",
    );
    return;
  }
  if (!upstream.ok) {
    await discardBody(upstream);
    if (route.kind === "image" && upstream.status === 404) {
      sendObserveError(
        response,
        404,
        "IMAGE_ASSET_NOT_FOUND",
        "生产环境中未找到该图片。",
      );
      return;
    }
    sendObserveError(
      response,
      502,
      "UPSTREAM_ERROR",
      "生产只读接口暂时无法完成读取。",
    );
    return;
  }

  const contentType = normalizedContentType(upstream.headers.get("content-type"));
  if (!isAllowedContentType(route.kind, contentType)) {
    await discardBody(upstream);
    sendObserveError(
      response,
      502,
      "UPSTREAM_CONTENT_REJECTED",
      "生产只读接口返回了未允许的内容类型。",
    );
    return;
  }

  const bytes = await readLimitedBytes(upstream, route.maximumBytes);
  if (bytes === null) {
    sendObserveError(
      response,
      502,
      "UPSTREAM_RESPONSE_TOO_LARGE",
      "生产只读接口返回的数据超过本地观察上限。",
    );
    return;
  }
  if (route.kind === "inventory") {
    const body = parseInventoryResponse(bytes, route.asOf);
    if (body === null) {
      sendObserveError(
        response,
        502,
        "UPSTREAM_CONTENT_REJECTED",
        "生产只读接口返回了无法验证的库存数据。",
      );
      return;
    }
    sendObserveJson(response, 200, body);
    return;
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": String(bytes.byteLength),
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-beautio-mode": "production-observe",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(bytes);
}

function parseInventoryResponse(bytes: Buffer, expectedAsOf: string): unknown | null {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const parsed = inventoryListOutputSchema.safeParse(body);
  return parsed.success && parsed.data.as_of === expectedAsOf
    ? parsed.data
    : null;
}

async function readLimitedBytes(
  response: Response,
  maximumBytes: number,
): Promise<Buffer | null> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maximumBytes
    ) {
      await discardBody(response);
      return null;
    }
  }
  if (response.body === null) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return Buffer.concat(chunks, totalBytes);
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response has already been rejected; cancellation is best effort.
  }
}

function hasLocalBearer(
  request: IncomingMessage,
  expectedToken: string,
): boolean {
  const header = request.headers.authorization;
  const match = header === undefined ? null : /^Bearer ([^\s]+)$/i.exec(header);
  return match !== null && tokensEqual(match[1] ?? "", expectedToken);
}

function hasExpectedLoopbackAuthority(request: IncomingMessage): boolean {
  const localPort = request.socket.localPort;
  if (
    request.socket.localAddress !== "127.0.0.1" ||
    localPort === undefined ||
    !Number.isInteger(localPort)
  ) {
    return false;
  }

  const hostValues: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "host") {
      hostValues.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return (
    hostValues.length === 1 &&
    hostValues[0] === `127.0.0.1:${localPort}`
  );
}

function validateOptions(
  options: ProductionObserveHandlerOptions,
): ValidatedProductionObserveOptions {
  const localBearerToken = requiredSecret(
    options.localBearerToken,
    "local observe token",
  );
  const productionAdminBearerToken = requiredSecret(
    options.productionAdminBearerToken,
    "production Admin token",
  );
  if (tokensEqual(localBearerToken, productionAdminBearerToken)) {
    throw new Error("local observe token must differ from production Admin token");
  }
  const productionOrigin = validateProductionOrigin(options.productionOrigin);
  const expectedProductionOrigin = validateProductionOrigin(
    options.expectedProductionOrigin,
  );
  if (productionOrigin !== expectedProductionOrigin) {
    throw new Error(
      "production origin does not match the independently configured expected origin",
    );
  }
  return {
    localBearerToken,
    productionAdminBearerToken,
    productionOrigin,
    staticWebRoot: createStaticWebRoot(options.webRoot),
    upstreamFetch: options.upstreamFetch ?? globalThis.fetch,
    upstreamTimeoutMs: positiveInteger(
      options.upstreamTimeoutMs,
      DEFAULT_UPSTREAM_TIMEOUT_MS,
    ),
    maximumInventoryBytes: positiveInteger(
      options.maximumInventoryBytes,
      DEFAULT_MAXIMUM_INVENTORY_BYTES,
    ),
    maximumImageBytes: positiveInteger(
      options.maximumImageBytes,
      DEFAULT_MAXIMUM_IMAGE_BYTES,
    ),
  };
}

function requiredSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /\s/u.test(trimmed)) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function validateProductionOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("production origin must be an HTTPS origin");
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
    throw new Error("production origin must be an HTTPS origin");
  }
  return url.origin;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function isAllowedContentType(
  kind: UpstreamRoute["kind"],
  contentType: string,
): boolean {
  return kind === "inventory"
    ? contentType === "application/json"
    : IMAGE_CONTENT_TYPES.has(contentType);
}

function normalizedContentType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isReservedPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function sendObserveJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": String(bytes.byteLength),
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-beautio-mode": "production-observe",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...extraHeaders,
  });
  response.end(bytes);
}

function sendObserveError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  sendObserveJson(
    response,
    statusCode,
    { error: { code, message } },
    statusCode === 405 ? { allow: "GET" } : {},
  );
}

import { BeautioError } from "@beautio/domain";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FILE_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 40_000;
const OPENAI_ACTION_FILE_HOST_ROOT = "oaiusercontent.com";

// Snapshot of the allocated IPv6 global-unicast blocks in IANA's registry.
// Unlisted 2000::/3 space is reserved for future allocation and therefore
// must not be treated as a public Action download target.
const ALLOCATED_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["2001:200::", 23],
  ["2001:400::", 23],
  ["2001:600::", 23],
  ["2001:800::", 22],
  ["2001:c00::", 23],
  ["2001:e00::", 23],
  ["2001:1200::", 23],
  ["2001:1400::", 22],
  ["2001:1800::", 23],
  ["2001:1a00::", 23],
  ["2001:1c00::", 22],
  ["2001:2000::", 19],
  ["2001:4000::", 23],
  ["2001:4200::", 23],
  ["2001:4400::", 23],
  ["2001:4600::", 23],
  ["2001:4800::", 23],
  ["2001:4a00::", 23],
  ["2001:4c00::", 23],
  ["2001:5000::", 20],
  ["2001:8000::", 19],
  ["2001:a000::", 20],
  ["2001:b000::", 20],
  ["2003::", 18],
  ["2400::", 12],
  ["2410::", 12],
  ["2600::", 12],
  ["2610::", 23],
  ["2620::", 23],
  ["2630::", 12],
  ["2800::", 12],
  ["2a00::", 12],
  ["2a10::", 12],
  ["2c00::", 12],
] as const) {
  ALLOCATED_PUBLIC_IPV6.addSubnet(network, prefix, "ipv6");
}

const NON_PUBLIC_IPV6_EXCEPTIONS = new BlockList();
NON_PUBLIC_IPV6_EXCEPTIONS.addSubnet("2001:db8::", 32, "ipv6");

export interface ActionFileReference {
  readonly name: string;
  readonly id: string;
  readonly mime_type: string;
  readonly download_link: string;
}

export interface DownloadedActionImage {
  readonly source_ref: string;
  readonly bytes: Uint8Array;
}

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type HostResolver = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;

export type PinnedActionRequester = (
  url: URL,
  address: ResolvedAddress,
  maximumBytes: number,
  overallSignal: AbortSignal,
) => Promise<{
  readonly bytes: Uint8Array;
  readonly redirectLocation: string | null;
}>;

export interface ActionDownloadTiming {
  readonly fileTimeoutMs?: number;
  readonly actionTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Parses the mandatory Action download allowlist.
 *
 * @param value - Comma-separated hostnames from deployment configuration.
 * @returns Lower-cased exact hosts. The explicit oaiusercontent.com entry also
 * accepts that root's dot-boundary subdomains during target validation.
 */
export function parseActionFileHostAllowlist(value: string): ReadonlySet<string> {
  const hosts = value
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
  if (hosts.length === 0) {
    throw new Error("BEAUTIO_ACTION_FILE_HOST_ALLOWLIST is required");
  }
  for (const host of hosts) {
    if (!isHostname(host)) {
      throw new Error("BEAUTIO_ACTION_FILE_HOST_ALLOWLIST contains an invalid host");
    }
  }
  return new Set(hosts);
}

/**
 * Downloads short-lived Action files within the frozen count, time, and byte limits.
 *
 * Every connection is pinned to an address resolved and checked immediately before
 * connecting. Redirects repeat host allowlist and public-address validation.
 *
 * @param references - Runtime file objects supplied by ChatGPT Actions.
 * @param allowedHosts - Deployment-configured exact hosts, including the optional
 * oaiusercontent.com root that enables its dot-boundary subdomains.
 * @param resolver - Injectable DNS resolver used to make rebinding checks testable.
 * @param requester - HTTPS transport that pins each request to a checked address.
 * @param timing - Optional shorter deterministic timeouts used by automated tests.
 * @returns Bytes keyed by the upstream file ID for the shared upload use case.
 */
export async function downloadActionImages(
  references: readonly ActionFileReference[],
  allowedHosts: ReadonlySet<string>,
  resolver: HostResolver = resolveHost,
  requester: PinnedActionRequester = requestPinned,
  timing: ActionDownloadTiming = {},
): Promise<readonly DownloadedActionImage[]> {
  if (references.length < 1 || references.length > 10) {
    throw new BeautioError(
      "INVALID_INPUT",
      "Action files must contain 1 through 10 items",
    );
  }
  const fileTimeoutMs = positiveTimeout(timing.fileTimeoutMs, FILE_TIMEOUT_MS);
  const actionTimeoutMs = positiveTimeout(
    timing.actionTimeoutMs,
    ACTION_TIMEOUT_MS,
  );
  const overallController = new AbortController();
  const overallTimeout = setTimeout(
    () => overallController.abort(),
    actionTimeoutMs,
  );
  overallTimeout.unref();
  const overallSignal =
    timing.signal === undefined
      ? overallController.signal
      : AbortSignal.any([overallController.signal, timing.signal]);
  let totalBytes = 0;
  const downloaded: DownloadedActionImage[] = [];

  try {
    for (const reference of references) {
      const remainingBytes = MAX_TOTAL_BYTES - totalBytes;
      if (remainingBytes <= 0) {
        throw tooLarge("image upload exceeds the 50 MiB total limit");
      }
      const bytes = await downloadOne(
        parseDownloadUrl(reference.download_link),
        allowedHosts,
        resolver,
        requester,
        Math.min(MAX_FILE_BYTES, remainingBytes),
        overallSignal,
        fileTimeoutMs,
      );
      totalBytes += bytes.byteLength;
      downloaded.push({ source_ref: reference.id, bytes });
    }
    return downloaded;
  } catch (error) {
    if (error instanceof BeautioError) {
      throw error;
    }
    throw new BeautioError("UPLOAD_FAILED", "Action file download failed");
  } finally {
    clearTimeout(overallTimeout);
  }
}

/**
 * Returns whether an address is publicly routable for this download boundary.
 *
 * @param address - A literal IPv4 or IPv6 address returned by DNS.
 * @returns True only for addresses outside local, private, link-local, and reserved ranges.
 */
export function isPublicActionAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    const third = octets[2] ?? -1;
    if (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 88 && third === 99) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51) ||
      (first === 203 && second === 0) ||
      first >= 224
    ) {
      return false;
    }
    return true;
  }
  if (family === 6) {
    return (
      ALLOCATED_PUBLIC_IPV6.check(address, "ipv6") &&
      !NON_PUBLIC_IPV6_EXCEPTIONS.check(address, "ipv6")
    );
  }
  return false;
}

async function downloadOne(
  initialUrl: URL,
  allowedHosts: ReadonlySet<string>,
  resolver: HostResolver,
  requester: PinnedActionRequester,
  maximumBytes: number,
  overallSignal: AbortSignal,
  fileTimeoutMs: number,
): Promise<Uint8Array> {
  const fileController = new AbortController();
  const fileTimeout = setTimeout(() => fileController.abort(), fileTimeoutMs);
  fileTimeout.unref();
  const signal = AbortSignal.any([overallSignal, fileController.signal]);
  try {
    let currentUrl = initialUrl;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const addresses = await abortable(
        validateDownloadTarget(currentUrl, allowedHosts, resolver),
        signal,
      );
      const response = await abortable(
        requester(
          currentUrl,
          addresses[0] as ResolvedAddress,
          maximumBytes,
          signal,
        ),
        signal,
      );
      if (response.redirectLocation === null) {
        if (response.bytes.byteLength > maximumBytes) {
          throw tooLarge("image upload exceeds its byte limit");
        }
        return response.bytes;
      }
      if (redirectCount === MAX_REDIRECTS) {
        throw new BeautioError(
          "FILE_SOURCE_REJECTED",
          "Action file exceeded the redirect limit",
        );
      }
      currentUrl = new URL(response.redirectLocation, currentUrl);
    }
    throw new BeautioError("UPLOAD_FAILED", "Action file download failed");
  } finally {
    clearTimeout(fileTimeout);
  }
}

async function validateDownloadTarget(
  url: URL,
  allowedHosts: ReadonlySet<string>,
  resolver: HostResolver,
): Promise<readonly ResolvedAddress[]> {
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !isAllowedActionFileHostname(url.hostname, allowedHosts)
  ) {
    throw rejectedSource();
  }

  const literalFamily = isIP(url.hostname);
  const addresses =
    literalFamily === 0
      ? await resolver(url.hostname)
      : [{ address: url.hostname, family: literalFamily } as ResolvedAddress];
  if (
    addresses.length === 0 ||
    addresses.some((entry) => !isPublicActionAddress(entry.address))
  ) {
    throw rejectedSource();
  }
  return addresses;
}

/**
 * Applies exact configured hosts plus the explicitly enabled OpenAI file-host root.
 *
 * The WHATWG URL parser preserves a trailing dot in `hostname`, so equality and
 * the leading-dot suffix check both reject fully-qualified trailing-dot variants.
 *
 * @param hostname - WHATWG URL hostname from an initial URL or redirect.
 * @param allowedHosts - Lower-cased exact hosts parsed from deployment configuration.
 * @returns Whether the hostname is an exact configured host or a valid dot-boundary
 * subdomain of an explicitly configured oaiusercontent.com root.
 */
function isAllowedActionFileHostname(
  hostname: string,
  allowedHosts: ReadonlySet<string>,
): boolean {
  const normalizedHostname = hostname.toLowerCase();
  if (allowedHosts.has(normalizedHostname)) {
    return true;
  }
  return (
    allowedHosts.has(OPENAI_ACTION_FILE_HOST_ROOT) &&
    isHostname(normalizedHostname) &&
    normalizedHostname.endsWith(`.${OPENAI_ACTION_FILE_HOST_ROOT}`)
  );
}

async function resolveHost(hostname: string): Promise<readonly ResolvedAddress[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.flatMap((result) =>
    result.family === 4 || result.family === 6
      ? [{ address: result.address, family: result.family }]
      : [],
  );
}

/**
 * Performs one HTTPS request while pinning the socket to a previously checked IP.
 *
 * @param url - Validated HTTPS URL whose hostname remains the TLS server name.
 * @param address - Public address selected from the immediately preceding DNS result.
 * @param maximumBytes - Maximum response bytes accepted for this request.
 * @param overallSignal - Combined file/action cancellation signal.
 * @returns Response bytes or a redirect location without following it implicitly.
 */
export function requestPinned(
  url: URL,
  address: ResolvedAddress,
  maximumBytes: number,
  overallSignal: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly redirectLocation: string | null }> {
  return new Promise((resolve, reject) => {
    const lookup: LookupFunction = (_hostname, options, callback) => {
      // Node 20+ may enable autoSelectFamily and request the `all: true`
      // callback shape even though this transport deliberately pins one IP.
      if (options.all === true) {
        callback(null, [address]);
        return;
      }
      callback(null, address.address, address.family);
    };
    const request = httpsRequest(
      url,
      {
        headers: { accept: "image/jpeg, image/png, image/webp" },
        lookup,
        servername: url.hostname,
        signal: overallSignal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.destroy();
          finish(() => {
            if (location === undefined) {
              reject(new BeautioError("UPLOAD_FAILED", "redirect has no location"));
            } else {
              resolve({ bytes: new Uint8Array(), redirectLocation: location });
            }
          });
          return;
        }
        if (status < 200 || status >= 300) {
          response.destroy();
          finish(() => reject(new BeautioError("UPLOAD_FAILED", "Action file download failed")));
          return;
        }

        const contentLength = Number(response.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
          response.destroy();
          finish(() => reject(tooLarge("image upload exceeds its byte limit")));
          return;
        }

        const chunks: Buffer[] = [];
        let byteLength = 0;
        response.on("data", (chunk: Buffer) => {
          byteLength += chunk.byteLength;
          if (byteLength > maximumBytes) {
            response.destroy(tooLarge("image upload exceeds its byte limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", (error) => finish(() => reject(error)));
        response.once("end", () =>
          finish(() =>
            resolve({
              bytes: Buffer.concat(chunks, byteLength),
              redirectLocation: null,
            }),
          ),
        );
      },
    );
    request.once("error", (error) =>
      finish(() => {
        if (error instanceof BeautioError) {
          reject(error);
        } else {
          reject(new BeautioError("UPLOAD_FAILED", "Action file download failed"));
        }
      }),
    );
    request.end();

    let finished = false;
    function finish(operation: () => void): void {
      if (finished) {
        return;
      }
      finished = true;
      operation();
    }
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new BeautioError("UPLOAD_FAILED", "Action file download timed out"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(new BeautioError("UPLOAD_FAILED", "Action file download timed out"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function isHostname(value: string): boolean {
  if (value.length > 253 || value.includes(":")) {
    return isIP(value) !== 0;
  }
  return value
    .split(".")
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    );
}

function parseDownloadUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw rejectedSource();
  }
}

function rejectedSource(): BeautioError {
  return new BeautioError(
    "FILE_SOURCE_REJECTED",
    "Action file source is not allowed",
  );
}

function tooLarge(message: string): BeautioError {
  return new BeautioError("UPLOAD_TOO_LARGE", message);
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

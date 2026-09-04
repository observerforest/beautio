const MAX_RAW_SEGMENT_CODE_UNITS = 2048;
const MAX_DECODED_SEGMENT_CODE_UNITS = 1024;
const CONTROL_CHARACTER = /\p{Cc}/u;
const ENCODED_OCTET = /%[0-9A-Fa-f]{2}/;

/**
 * Extracts one opaque path segment without accepting encoded separators or a
 * second decoding pass. Literal percent signs remain supported when the wire
 * representation uses `%25`, unless the decoded value itself looks encoded.
 */
export function routeId(
  pathname: string,
  prefix: string,
  suffix: string,
): string | null {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null;
  }

  const segmentEnd =
    suffix.length === 0 ? pathname.length : pathname.length - suffix.length;
  if (segmentEnd <= prefix.length) {
    return null;
  }

  const encoded = pathname.slice(prefix.length, segmentEnd);
  if (
    encoded.length > MAX_RAW_SEGMENT_CODE_UNITS ||
    encoded.includes("/") ||
    encoded.includes("\\")
  ) {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }

  if (
    decoded.length === 0 ||
    decoded.length > MAX_DECODED_SEGMENT_CODE_UNITS ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    CONTROL_CHARACTER.test(decoded) ||
    ENCODED_OCTET.test(decoded)
  ) {
    return null;
  }

  return decoded;
}

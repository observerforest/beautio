import { isIP } from "node:net";

const DEFAULT_API_HOST = "127.0.0.1";
const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const HOST_LABEL = /^[A-Za-z0-9-]+$/;

/**
 * Resolves the interface host used by the managed HTTP server.
 *
 * @param value - Optional IPv4, IPv6, or ASCII DNS hostname from deployment configuration.
 * @returns The validated configured host, or loopback when the variable is absent.
 * @throws When a present value is empty, URL-shaped, or not a valid host.
 */
export function parseApiHost(value: string | undefined): string {
  if (value === undefined) {
    return DEFAULT_API_HOST;
  }
  const host = value.trim();
  if (host.length === 0 || (!isIP(host) && !isHostname(host))) {
    throw new Error("BEAUTIO_API_HOST must be a valid non-empty host");
  }
  return host;
}

function isHostname(value: string): boolean {
  if (value.length > MAX_HOSTNAME_LENGTH) {
    return false;
  }
  const labels = value.split(".");
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= MAX_LABEL_LENGTH &&
      HOST_LABEL.test(label) &&
      !label.startsWith("-") &&
      !label.endsWith("-"),
  );
}

import { BeautioError } from "@beautio/domain";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

const MAXIMUM_ASSERTION_LENGTH = 16_384;
const CLOUDFLARE_ACCESS_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

export interface CloudflareAccessJwtOptions {
  readonly issuer: string;
  readonly audience: string;
}

export type AccessJwtVerifier = (assertion: string) => Promise<void>;

/**
 * Builds the origin-side verifier for Cloudflare Access identity assertions.
 *
 * @param options - Exact Access issuer and application audience.
 * @param keyResolver - Optional trusted key resolver used by isolated tests.
 * @returns A verifier that resolves only for a currently valid Access assertion.
 */
export function createCloudflareAccessJwtVerifier(
  options: CloudflareAccessJwtOptions,
  keyResolver?: JWTVerifyGetKey,
): AccessJwtVerifier {
  const issuer = validateAccessIssuer(options.issuer);
  const audience = requiredBoundedValue(
    options.audience,
    "BEAUTIO_ACCESS_AUDIENCE",
    512,
  );
  const resolver =
    keyResolver ??
    createRemoteJWKSet(new URL("/cdn-cgi/access/certs", `${issuer}/`));

  return async (assertion: string): Promise<void> => {
    if (
      assertion.length === 0 ||
      assertion.length > MAXIMUM_ASSERTION_LENGTH ||
      assertion.trim() !== assertion
    ) {
      throw unauthorized();
    }
    try {
      await jwtVerify(assertion, resolver, {
        issuer,
        audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "nbf"],
      });
    } catch {
      throw unauthorized();
    }
  };
}

function validateAccessIssuer(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      "BEAUTIO_ACCESS_TEAM_DOMAIN must be an HTTPS Cloudflare Access origin",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !CLOUDFLARE_ACCESS_HOST_PATTERN.test(url.hostname)
  ) {
    throw new Error(
      "BEAUTIO_ACCESS_TEAM_DOMAIN must be an HTTPS Cloudflare Access origin",
    );
  }
  return url.origin;
}

function requiredBoundedValue(
  value: string,
  name: string,
  maximumLength: number,
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximumLength) {
    throw new Error(
      `${name} is required and must be at most ${maximumLength} characters`,
    );
  }
  return trimmed;
}

function unauthorized(): BeautioError {
  return new BeautioError(
    "UNAUTHORIZED",
    "valid Cloudflare Access authentication is required",
  );
}

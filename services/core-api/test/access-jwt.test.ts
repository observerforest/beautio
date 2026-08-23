import assert from "node:assert/strict";
import test, { before } from "node:test";
import { BeautioError } from "@beautio/domain";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTVerifyGetKey,
} from "jose";
import { createCloudflareAccessJwtVerifier } from "../src/access-jwt.ts";

const ISSUER = "https://beautio-test.cloudflareaccess.com";
const AUDIENCE = "test-access-audience";
const EMAIL = "owner@example.test";

let privateKey: CryptoKey;
let rotatedPrivateKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;

before(async () => {
  const pair = await generateKeyPair("RS256");
  const rotatedPair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  rotatedPrivateKey = rotatedPair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  const rotatedPublicJwk = await exportJWK(rotatedPair.publicKey);
  keyResolver = createLocalJWKSet({
    keys: [
      { ...publicJwk, alg: "RS256", kid: "test-key", use: "sig" },
      {
        ...rotatedPublicJwk,
        alg: "RS256",
        kid: "rotated-key",
        use: "sig",
      },
    ],
  });
});

test("Cloudflare Access verifier accepts valid application assertions and key rotation", async () => {
  const verify = createCloudflareAccessJwtVerifier(
    {
      issuer: ISSUER,
      audience: AUDIENCE,
    },
    keyResolver,
  );

  await verify(await signAccessToken());
  await verify(await signAccessToken({ email: "other@example.test" }));
  await verify(
    await signAccessToken({ key: rotatedPrivateKey, kid: "rotated-key" }),
  );

  const roguePair = await generateKeyPair("RS256");

  for (const token of [
    await signAccessToken({ audience: "wrong-audience" }),
    await signAccessToken({ issuer: "https://other.cloudflareaccess.com" }),
    await signAccessToken({ expiresAt: 1 }),
    await signAccessToken({ notBefore: Math.floor(Date.now() / 1000) + 600 }),
    await signAccessToken({ includeExpiration: false }),
    await signAccessToken({ includeNotBefore: false }),
    await signAccessToken({ kid: "unknown-key" }),
    await signAccessToken({ key: roguePair.privateKey }),
  ]) {
    await assert.rejects(() => verify(token), isUnauthorized);
  }
});

test("Cloudflare Access verifier rejects malformed assertions without details", async () => {
  const verify = createCloudflareAccessJwtVerifier(
    { issuer: ISSUER, audience: AUDIENCE },
    keyResolver,
  );

  for (const assertion of ["", " token ", "not-a-jwt", "x".repeat(16_385)]) {
    await assert.rejects(() => verify(assertion), isUnauthorized);
  }
});

test("Cloudflare Access verifier restricts issuer and audience configuration", () => {
  const base = {
    issuer: ISSUER,
    audience: AUDIENCE,
  };
  for (const issuer of [
    "http://beautio-test.cloudflareaccess.com",
    "https://beautio-test.cloudflareaccess.com/path",
    "https://beautio-test.cloudflareaccess.com:8443",
    "https://cloudflareaccess.com",
    "https://beautio-test.cloudflareaccess.com.evil.example",
    "https://nested.beautio-test.cloudflareaccess.com",
  ]) {
    assert.throws(
      () => createCloudflareAccessJwtVerifier({ ...base, issuer }, keyResolver),
      /HTTPS Cloudflare Access origin/,
    );
  }
  assert.throws(
    () =>
      createCloudflareAccessJwtVerifier(
        { ...base, audience: " " },
        keyResolver,
      ),
    /BEAUTIO_ACCESS_AUDIENCE/,
  );
});

interface TokenOverrides {
  readonly email?: string;
  readonly audience?: string;
  readonly issuer?: string;
  readonly expiresAt?: number;
  readonly notBefore?: number;
  readonly includeExpiration?: boolean;
  readonly includeNotBefore?: boolean;
  readonly key?: CryptoKey;
  readonly kid?: string;
}

async function signAccessToken(overrides: TokenOverrides = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let token = new SignJWT({
    email: overrides.email ?? EMAIL,
    type: "app",
  })
    .setProtectedHeader({ alg: "RS256", kid: overrides.kid ?? "test-key" })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject("test-user")
    .setIssuedAt(now);
  if (overrides.includeNotBefore !== false) {
    token = token.setNotBefore(overrides.notBefore ?? now - 1);
  }
  if (overrides.includeExpiration !== false) {
    token = token.setExpirationTime(overrides.expiresAt ?? now + 300);
  }
  return token.sign(overrides.key ?? privateKey);
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof BeautioError && error.code === "UNAUTHORIZED";
}

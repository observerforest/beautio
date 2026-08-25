import { BeautioError } from "@beautio/domain";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function requireBearer(
  request: IncomingMessage,
  expectedToken: string,
): void {
  const header = request.headers.authorization;
  const match = header === undefined ? null : /^Bearer ([^\s]+)$/i.exec(header);
  if (match === null || !tokensEqual(match[1] ?? "", expectedToken)) {
    throw new BeautioError(
      "UNAUTHORIZED",
      "valid bearer authorization is required",
    );
  }
}

export function tokensEqual(first: string, second: string): boolean {
  const firstBytes = Buffer.from(first);
  const secondBytes = Buffer.from(second);
  return (
    firstBytes.byteLength === secondBytes.byteLength &&
    timingSafeEqual(firstBytes, secondBytes)
  );
}

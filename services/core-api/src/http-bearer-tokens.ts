import { tokensEqual } from "./bearer.ts";

export interface HttpBearerTokenInput {
  readonly customGptBearerToken: string;
  readonly actionBearerToken: string;
  readonly adminBearerToken: string;
}

export interface HttpBearerTokens {
  readonly customGptBearerToken: string;
  readonly actionBearerToken: string;
  readonly adminBearerToken: string;
}

/**
 * Normalizes and validates the three isolated HTTP bearer identities.
 *
 * @param input - Raw Custom GPT, Codex Action, and Admin bearer values.
 * @returns Trimmed, pairwise-distinct bearer values.
 * @throws When any value is empty or any two values are equal after trimming.
 */
export function validateHttpBearerTokens(
  input: HttpBearerTokenInput,
): HttpBearerTokens {
  const customGptBearerToken = input.customGptBearerToken.trim();
  const actionBearerToken = input.actionBearerToken.trim();
  const adminBearerToken = input.adminBearerToken.trim();
  if (
    customGptBearerToken.length === 0 ||
    actionBearerToken.length === 0 ||
    adminBearerToken.length === 0
  ) {
    throw new Error("all Beautio HTTP bearer tokens are required");
  }
  if (
    tokensEqual(customGptBearerToken, actionBearerToken) ||
    tokensEqual(customGptBearerToken, adminBearerToken) ||
    tokensEqual(actionBearerToken, adminBearerToken)
  ) {
    throw new Error("Beautio HTTP bearer tokens must be different");
  }
  return {
    customGptBearerToken,
    actionBearerToken,
    adminBearerToken,
  };
}

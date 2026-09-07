import { bearerAuthSecurityScheme } from "./openapi/common.ts";
import { customGptCreateActionPaths } from "./openapi/create-action.ts";
import { customGptFactActionPaths } from "./openapi/fact-actions.ts";
import { customGptImageActionPaths } from "./openapi/image-actions.ts";
import { customGptReadActionPaths } from "./openapi/read-actions.ts";

/**
 * OpenAPI 3.1 document for the public Custom GPT Action surface.
 *
 * The V1 suffix is retained for compatibility with existing imports and the
 * versioned public document route.
 */
export const beautioActionsOpenApiV1 = {
  openapi: "3.1.0",
  info: {
    title: "Beautio confirmed inventory actions",
    version: "2.0.0",
    description:
      "Authenticated inventory tools with three read operations and eight consequential writes. Use writes only after explicit user confirmation and assign replay-safe command UUIDs. After an uncertain or completed write, use read-only status and inventory reads to verify the recorded outcome instead of resubmitting it.",
  },
  paths: {
    ...customGptReadActionPaths,
    ...customGptFactActionPaths,
    ...customGptCreateActionPaths,
    ...customGptImageActionPaths,
  },
  components: {
    schemas: {},
    securitySchemes: {
      bearerAuth: bearerAuthSecurityScheme,
    },
  },
} as const;

type PublicBeautioActionsOpenApiV1 = typeof beautioActionsOpenApiV1 & {
  readonly servers: readonly [{ readonly url: string }];
};

/**
 * Creates the Action document for a specific public HTTPS origin.
 *
 * The V1 suffix is retained for compatibility with the existing public API.
 *
 * @param publicOrigin - Normalized HTTPS origin used by Custom GPT, or undefined for local tests.
 * @returns The immutable base schema locally, or a copy with one explicit public server.
 */
export function createBeautioActionsOpenApiV1(
  publicOrigin: string,
): PublicBeautioActionsOpenApiV1;
export function createBeautioActionsOpenApiV1(
  publicOrigin?: undefined,
): typeof beautioActionsOpenApiV1;
export function createBeautioActionsOpenApiV1(
  publicOrigin?: string,
): typeof beautioActionsOpenApiV1 | PublicBeautioActionsOpenApiV1;
export function createBeautioActionsOpenApiV1(
  publicOrigin?: string,
): typeof beautioActionsOpenApiV1 | PublicBeautioActionsOpenApiV1 {
  if (publicOrigin === undefined) {
    return beautioActionsOpenApiV1;
  }
  return {
    ...beautioActionsOpenApiV1,
    servers: [{ url: publicOrigin }],
  };
}

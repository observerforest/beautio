export interface RemoteMcpEnvironment {
  readonly publicOrigin: string;
  readonly accessIssuer: string;
  readonly accessAudience: string;
}

/**
 * Parses the explicit remote-MCP feature gate and its required private config.
 *
 * @param environment - Process environment or an isolated test fixture.
 * @returns Null when disabled, otherwise the complete fail-closed configuration.
 */
export function parseRemoteMcpEnvironment(
  environment: NodeJS.ProcessEnv,
): RemoteMcpEnvironment | null {
  const enabled = environment.BEAUTIO_REMOTE_MCP_ENABLED?.trim();
  if (enabled === undefined || enabled === "false") {
    return null;
  }
  if (enabled !== "true") {
    throw new Error("BEAUTIO_REMOTE_MCP_ENABLED must be true or false");
  }

  const host = requiredEnvironment(
    environment,
    "BEAUTIO_REMOTE_MCP_HOST",
  ).toLowerCase();
  if (!isDnsHostname(host)) {
    throw new Error("BEAUTIO_REMOTE_MCP_HOST must be one exact DNS hostname");
  }

  return {
    publicOrigin: `https://${host}`,
    accessIssuer: requiredEnvironment(
      environment,
      "BEAUTIO_ACCESS_TEAM_DOMAIN",
    ),
    accessAudience: requiredEnvironment(
      environment,
      "BEAUTIO_ACCESS_AUDIENCE",
    ),
  };
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required when remote MCP is enabled`);
  }
  return value;
}

function isDnsHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value.endsWith(".")) {
    return false;
  }
  const labels = value.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  );
}

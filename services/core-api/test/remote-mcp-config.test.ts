import assert from "node:assert/strict";
import test from "node:test";
import { parseRemoteMcpEnvironment } from "../src/remote-mcp-config.ts";

test("remote MCP is absent unless explicitly enabled", () => {
  assert.equal(parseRemoteMcpEnvironment({}), null);
  assert.equal(
    parseRemoteMcpEnvironment({ BEAUTIO_REMOTE_MCP_ENABLED: " false " }),
    null,
  );
  assert.throws(
    () =>
      parseRemoteMcpEnvironment({ BEAUTIO_REMOTE_MCP_ENABLED: "yes" }),
    /must be true or false/,
  );
});

test("enabled remote MCP requires a complete exact-host configuration", () => {
  const complete = {
    BEAUTIO_REMOTE_MCP_ENABLED: "true",
    BEAUTIO_REMOTE_MCP_HOST: "MCP.Beautio.Example",
    BEAUTIO_ACCESS_TEAM_DOMAIN: "https://beautio.cloudflareaccess.com",
    BEAUTIO_ACCESS_AUDIENCE: "test-audience",
  };
  assert.deepEqual(parseRemoteMcpEnvironment(complete), {
    publicOrigin: "https://mcp.beautio.example",
    accessIssuer: "https://beautio.cloudflareaccess.com",
    accessAudience: "test-audience",
  });

  for (const name of [
    "BEAUTIO_REMOTE_MCP_HOST",
    "BEAUTIO_ACCESS_TEAM_DOMAIN",
    "BEAUTIO_ACCESS_AUDIENCE",
  ] as const) {
    assert.throws(
      () => parseRemoteMcpEnvironment({ ...complete, [name]: " " }),
      new RegExp(name),
    );
  }
});

test("remote MCP host rejects schemes, ports, paths, and lookalike labels", () => {
  const base = {
    BEAUTIO_REMOTE_MCP_ENABLED: "true",
    BEAUTIO_ACCESS_TEAM_DOMAIN: "https://beautio.cloudflareaccess.com",
    BEAUTIO_ACCESS_AUDIENCE: "test-audience",
  };
  for (const host of [
    "https://mcp.beautio.example",
    "mcp.beautio.example:443",
    "mcp.beautio.example/path",
    "mcp.beautio.example.",
    "-mcp.beautio.example",
    "mcp..beautio.example",
  ]) {
    assert.throws(
      () =>
        parseRemoteMcpEnvironment({
          ...base,
          BEAUTIO_REMOTE_MCP_HOST: host,
        }),
      /one exact DNS hostname/,
    );
  }
});

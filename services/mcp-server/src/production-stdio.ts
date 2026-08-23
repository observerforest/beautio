import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createProductionBeautioMcpServer } from "./production-server.ts";
import { createRemoteBeautioClient } from "./remote-client.ts";

const origin = requiredEnvironment("BEAUTIO_REMOTE_ORIGIN");
const tokenFilePath = requiredEnvironment("BEAUTIO_ACTION_TOKEN_FILE");
const uploadRoot = requiredEnvironment("BEAUTIO_MCP_UPLOAD_ROOT");

const remoteClient = await createRemoteBeautioClient({
  origin,
  tokenFilePath,
});
const handle = serveStdio(
  () => createProductionBeautioMcpServer(remoteClient, { uploadRoot }),
  {
    onerror: () => {
      console.error("Beautio production MCP transport error.");
    },
  },
);

const close = async (): Promise<void> => {
  await handle.close();
};

process.once("SIGINT", () => {
  void close().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

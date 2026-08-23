import { InventoryApplicationService } from "@beautio/application";
import { SqliteInventoryRepository } from "@beautio/database";
import {
  FileImageAssetStorage,
  FileImageRenditionProvider,
  sharpImageInspector,
} from "@beautio/image-storage";
import { createServer } from "node:http";
import { createCloudflareAccessJwtVerifier } from "./access-jwt.ts";
import { parseActionFileHostAllowlist } from "./action-download.ts";
import { parseApiHost } from "./api-host.ts";
import { createCoreApiHandler } from "./index.ts";
import { createReadOnlyMcpRoute } from "./read-only-mcp.ts";
import { parseRemoteMcpEnvironment } from "./remote-mcp-config.ts";

const databasePath = requiredEnvironment("BEAUTIO_DB_PATH");
const imageStorageRoot = requiredEnvironment("BEAUTIO_IMAGE_STORAGE_ROOT");
const actionBearerToken = requiredEnvironment("BEAUTIO_ACTION_BEARER_TOKEN");
const adminBearerToken = requiredEnvironment("BEAUTIO_ADMIN_BEARER_TOKEN");
const actionFileHosts = parseActionFileHostAllowlist(
  requiredEnvironment("BEAUTIO_ACTION_FILE_HOST_ALLOWLIST"),
);
const publicOrigin = optionalEnvironment("BEAUTIO_PUBLIC_ORIGIN");
const webRoot = optionalEnvironment("BEAUTIO_WEB_ROOT");
const host = parseApiHost(process.env.BEAUTIO_API_HOST);
const port = parsePort(process.env.BEAUTIO_API_PORT);
const remoteMcpEnvironment = parseRemoteMcpEnvironment(process.env);

const repository = new SqliteInventoryRepository(databasePath);
const application = new InventoryApplicationService(repository, {
  imageStorage: new FileImageAssetStorage(imageStorageRoot),
  imageInspector: sharpImageInspector,
  imageRenditions: new FileImageRenditionProvider(imageStorageRoot),
});
const readOnlyMcp =
  remoteMcpEnvironment === null
    ? null
    : createReadOnlyMcpRoute(application, {
        publicOrigin: remoteMcpEnvironment.publicOrigin,
        verifyAccessJwt: createCloudflareAccessJwtVerifier({
          issuer: remoteMcpEnvironment.accessIssuer,
          audience: remoteMcpEnvironment.accessAudience,
        }),
        onError: () =>
          console.error("Beautio read-only MCP request could not be completed."),
      });
const handler = createCoreApiHandler(application, {
  actionBearerToken,
  adminBearerToken,
  actionFileHosts,
  ...(publicOrigin === undefined ? {} : { publicOrigin }),
  ...(webRoot === undefined ? {} : { webRoot }),
  ...(readOnlyMcp === null ? {} : { readOnlyMcp }),
});

await application.cleanupExpiredImageAssets();
let cleanupRunning = false;
const cleanupInterval = setInterval(() => {
  if (cleanupRunning) {
    return;
  }
  cleanupRunning = true;
  void application
    .cleanupExpiredImageAssets()
    .catch(() => console.error("Beautio image cleanup failed; it will retry."))
    .finally(() => {
      cleanupRunning = false;
    });
}, 60 * 60 * 1000);
cleanupInterval.unref();

const server = createServer(handler);
server.listen(port, host, () => {
  console.log(`Beautio managed API listening on ${host}:${port}`);
});

let closing = false;
const close = (): void => {
  if (closing) {
    return;
  }
  closing = true;
  clearInterval(cleanupInterval);
  void (readOnlyMcp?.close() ?? Promise.resolve())
    .catch(() =>
      console.error("Beautio read-only MCP shutdown could not be completed."),
    )
    .finally(() => {
      server.close(() => {
        repository.close();
      });
    });
};

process.once("SIGINT", close);
process.once("SIGTERM", close);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return 8787;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("BEAUTIO_API_PORT must be an integer between 1 and 65535");
  }
  return port;
}

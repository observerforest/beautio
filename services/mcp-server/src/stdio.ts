import { InventoryApplicationService } from "@beautio/application";
import { SqliteInventoryRepository } from "@beautio/database";
import {
  FileImageAssetStorage,
  FileImageRenditionProvider,
  sharpImageInspector,
} from "@beautio/image-storage";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createBeautioMcpServer } from "./index.ts";

const databasePath = requiredEnvironment("BEAUTIO_DB_PATH");
const uploadRoot = requiredEnvironment("BEAUTIO_MCP_UPLOAD_ROOT");
const imageStorageRoot = requiredEnvironment("BEAUTIO_IMAGE_STORAGE_ROOT");

const repository = new SqliteInventoryRepository(databasePath);
const application = new InventoryApplicationService(repository, {
  imageStorage: new FileImageAssetStorage(imageStorageRoot),
  imageInspector: sharpImageInspector,
  imageRenditions: new FileImageRenditionProvider(imageStorageRoot),
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

const handle = serveStdio(
  () => createBeautioMcpServer(application, { uploadRoot }),
  {
    onerror: (error) => {
      console.error(error);
    },
  },
);

const close = async (): Promise<void> => {
  clearInterval(cleanupInterval);
  await handle.close();
  repository.close();
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

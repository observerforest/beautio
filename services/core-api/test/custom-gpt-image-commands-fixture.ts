import { CommandExecutionService, CustomGptImageCommandService, CustomGptReadService, InventoryApplicationService } from "@beautio/application";
import { SqliteInventoryRepository } from "@beautio/database";
import { FileImageAssetStorage, sharpImageInspector } from "@beautio/image-storage";
import { createInventoryItem, createProduct } from "@beautio/domain";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import sharp from "sharp";
import { createCoreApiHandler, type CoreApiHandlerOptions } from "../src/index.ts";
import type { CustomGptImageActionApplication } from "../src/custom-gpt-image-action-route.ts";

export const imageCustomGptToken = "test-custom-gpt-image-token";
export const imageCodexToken = "test-codex-image-token";
export const imageAdminToken = "test-admin-image-token";
export const imageCommandId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
export const imageUploadBody = (command = 1, count = 1) => ({ command_id: imageCommandId(command), openaiFileIdRefs: Array.from({ length: count }, (_, index) => ({ name: `synthetic-${index}.png`, id: `file-${index}`, mime_type: "image/png", download_link: `https://files.example.test/image-${index}?signature=synthetic` })) });
export interface ImageActionFixtureOptions {
  readonly enabled?: boolean;
  readonly coreOptions?: Partial<CoreApiHandlerOptions>;
  readonly createCommands?: (service: CustomGptImageCommandService) => CustomGptImageActionApplication;
  readonly createLoader?: (bytes: Uint8Array) => NonNullable<CoreApiHandlerOptions["actionDownloader"]>;
}
/** @param service - Real service. @param overrides - Narrow test seams. @returns Bound delegates preserving private service receivers. */
export function bindImageCommands(service: CustomGptImageCommandService, overrides: Partial<CustomGptImageActionApplication> = {}): CustomGptImageActionApplication {
  return { prepareUpload: service.prepareUpload.bind(service), claimPreparedUpload: service.claimPreparedUpload.bind(service),
    prepareOwnedUpload: service.prepareOwnedUpload.bind(service), executePreparedUpload: service.executePreparedUpload.bind(service),
    discardPreparedUpload: service.discardPreparedUpload.bind(service), prepareSetDisplayImage: service.prepareSetDisplayImage.bind(service),
    executePreparedSetDisplayImage: service.executePreparedSetDisplayImage.bind(service), ...overrides };
}
/** @param context - Test cleanup lifecycle. @param options - Local dependency seams. @returns Real local HTTP, SQLite and synthetic-image fixture. */
export async function imageActionFixture(context: TestContext, options: ImageActionFixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "beautio-image-actions-"));
  const databasePath = join(directory, "inventory.sqlite");
  const repository = new SqliteInventoryRepository(databasePath);
  const database = new DatabaseSync(databasePath);
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#aabbcc" } }).png().toBuffer();
  const storage = new FileImageAssetStorage(join(directory, "images"));
  const clock = () => new Date("2026-09-05T00:00:00.000Z");
  const application = new InventoryApplicationService(repository, { clock, imageStorage: storage, imageInspector: sharpImageInspector });
  await repository.importInventoryData({ products: [createProduct({ id: "product", name: "Synthetic product" })], inventoryItems: [createInventoryItem({ id: "bottle", productId: "product", lifecycleStatus: "unopened" })] });
  const commands = new CommandExecutionService(repository, clock);
  const reads = new CustomGptReadService(application, repository, commands);
  let generated = 100;
  const service = new CustomGptImageCommandService(repository, commands, application, storage, { clock, idGenerator: () => imageCommandId(generated++) });
  let downloads = 0;
  const loader = options.createLoader?.(bytes) ?? (async (refs) => refs.map((ref) => ({ source_ref: ref.id, bytes })));
  const server = createServer(createCoreApiHandler(application, {
    customGptBearerToken: imageCustomGptToken, actionBearerToken: imageCodexToken, adminBearerToken: imageAdminToken,
    actionFileHosts: new Set(["files.example.test"]), customGptReads: reads,
    actionDownloader: async (...args) => { downloads++; return loader(...args); },
    ...(options.enabled === false ? {} : { customGptImageCommands: options.createCommands?.(service) ?? service }), ...options.coreOptions,
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); database.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { application, commands, reads, service, repository, database, storage, bytes, server, origin, downloads: () => downloads,
    request: (method: string, path: string, body: unknown, token: string | null = imageCustomGptToken, contentType = "application/json") => fetch(origin + path, {
      method, headers: { "content-type": contentType, ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  };
}
/** @param url - Local fixture URL. @param body - Synthetic upload JSON. @returns A client that can disconnect without an unhandled request error. */
export function abortableImageRequest(url: string, body: unknown) {
  const payload = JSON.stringify(body);
  const closed = Promise.withResolvers<void>();
  const request = httpRequest(url, { method: "POST", headers: { authorization: `Bearer ${imageCustomGptToken}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (response) => response.resume());
  request.on("error", () => undefined); request.once("close", () => closed.resolve()); request.end(payload);
  return { request, closed: closed.promise };
}

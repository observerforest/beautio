import { CommandExecutionService, CustomGptImageCommandService, CustomGptReadService, InventoryApplicationService, type CustomGptImageCommandServiceOptions, type ImageCommandRepository, type ImageCommandStorage } from "@beautio/application";
import { join, dirname } from "node:path";
import type { TestContext } from "node:test";
import { FileImageAssetStorage } from "../../image-storage/src/index.ts";
import { metadata, revisionFixture } from "./revision-test-fixtures.ts";
import type { DatabaseSync } from "node:sqlite";
export const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
export const clock = () => new Date("2026-09-05T00:00:00.000Z");
export const uploadBody = (command = 1, count = 2) => ({ command_id: uuid(command), openaiFileIdRefs: Array.from({ length: count }, (_, index) => ({ id: `file-${index}`, name: `synthetic-${index}.png`, mime_type: "image/png", download_link: `https://files.example.invalid/synthetic-${index}?signature=synthetic` })) });
export async function imageFixture(context: TestContext) {
  const fixture = await revisionFixture(context);
  const directory = join(dirname(fixture.databasePath), "images");
  const storage = new FileImageAssetStorage(directory);
  const application = new InventoryApplicationService(fixture.repository, { clock, imageStorage: storage, imageInspector: { async inspect() { return { mediaType: "image/png", width: 1, height: 1, animated: false }; } } });
  const commands = new CommandExecutionService(fixture.repository, clock);
  const reads = new CustomGptReadService(application, fixture.repository, commands);
  const port = (overrides: Partial<ImageCommandRepository> = {}): ImageCommandRepository => ({
    stageImageUploadCommand: fixture.repository.stageImageUploadCommand.bind(fixture.repository),
    finalizeImageUploadCommand: fixture.repository.finalizeImageUploadCommand.bind(fixture.repository),
    abandonImageUploadCommand: fixture.repository.abandonImageUploadCommand.bind(fixture.repository),
    deleteClaimedImageAsset: fixture.repository.deleteClaimedImageAsset.bind(fixture.repository),
    executeSetDisplayImageCommand: fixture.repository.executeSetDisplayImageCommand.bind(fixture.repository), ...overrides,
  });
  let generated = 100;
  const makeService = (overrides: Partial<ImageCommandRepository> = {}, fileStore: ImageCommandStorage = storage, options: CustomGptImageCommandServiceOptions = {}) => new CustomGptImageCommandService(port(overrides), commands, application, fileStore, { clock, idGenerator: () => uuid(generated++), ...options });
  const service = makeService();
  return { ...fixture, directory, storage, application, commands, reads, service, makeService, port, generated: () => generated - 100 };
}
export async function runUpload(service: CustomGptImageCommandService, input: ReturnType<typeof uploadBody>, onLoad?: () => void) {
  const claimed = await service.claimPreparedUpload(service.prepareUpload(input));
  if (claimed.outcome === "replayed") return claimed.output;
  const prepared = await service.prepareOwnedUpload(claimed.ownership, async (refs) => {
    onLoad?.(); return refs.map((ref, index) => ({ source_ref: ref.id, bytes: Uint8Array.from([1, index, 3]) }));
  });
  try { return await service.executePreparedUpload(prepared); } finally { service.discardPreparedUpload(prepared); }
}
export function imageState(database: DatabaseSync) {
  return { ...metadata(database), products: database.prepare("SELECT * FROM products ORDER BY id").all(), items: database.prepare("SELECT * FROM inventory_items ORDER BY id").all(), images: database.prepare("SELECT * FROM image_assets ORDER BY id").all() };
}

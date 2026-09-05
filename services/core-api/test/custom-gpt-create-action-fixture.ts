import {
  CommandExecutionService,
  CustomGptCreateCommandService,
  CustomGptReadService,
  InventoryApplicationService,
  type CustomGptCreateCommandServiceOptions,
} from "@beautio/application";
import { SqliteInventoryRepository } from "@beautio/database";
import {
  FileImageAssetStorage,
  sharpImageInspector,
} from "@beautio/image-storage";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import sharp from "sharp";
import type { CustomGptCreateActionApplication } from "../src/custom-gpt-create-action-route.ts";
import {
  createCoreApiHandler,
  type CoreApiHandlerOptions,
} from "../src/index.ts";

export const createCustomGptToken = "test-custom-gpt-create-token";
export const createCodexToken = "test-codex-create-token";
export const createAdminToken = "test-admin-create-token";

export function createCommandId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

export interface CreateActionFixtureOptions {
  readonly coreOptions?: Partial<CoreApiHandlerOptions>;
  readonly enableCustomGptCreates?: boolean;
  readonly createServiceOptions?: CustomGptCreateCommandServiceOptions;
  readonly createCustomGptCreates?: (dependencies: {
    readonly commands: CommandExecutionService;
    readonly repository: SqliteInventoryRepository;
    readonly service: CustomGptCreateCommandService;
    readonly serviceOptions: CustomGptCreateCommandServiceOptions;
  }) => CustomGptCreateActionApplication;
}

/**
 * Starts a synthetic create-Action server backed by one temporary SQLite file.
 *
 * @param context - Node test lifecycle used to close every local resource.
 * @param options - Optional adapter, service, clock, and UUID fault injection.
 * @returns Local-only HTTP helpers plus direct read-only inspection handles.
 */
export async function createActionFixture(
  context: TestContext,
  options: CreateActionFixtureOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "beautio-create-actions-"));
  const databasePath = join(directory, "test.sqlite");
  const repository = new SqliteInventoryRepository(databasePath);
  const database = new DatabaseSync(databasePath);
  const imageBytes = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: "#d7a9b9",
    },
  })
    .png()
    .toBuffer();
  const application = new InventoryApplicationService(repository, {
    clock: () => new Date("2026-09-05T00:00:00.000Z"),
    imageStorage: new FileImageAssetStorage(join(directory, "images")),
    imageInspector: sharpImageInspector,
  });
  const commands = new CommandExecutionService(
    repository,
    () => new Date("2026-09-05T00:00:00.000Z"),
  );
  const reads = new CustomGptReadService(application, repository, commands);
  let nextGeneratedId = 0;
  const serviceOptions: CustomGptCreateCommandServiceOptions = {
    clock: () => new Date("2026-09-05T00:00:01.000Z"),
    idGenerator: () =>
      `10000000-0000-4000-8000-${(++nextGeneratedId)
        .toString()
        .padStart(12, "0")}`,
    ...options.createServiceOptions,
  };
  const createService = new CustomGptCreateCommandService(
    repository,
    commands,
    serviceOptions,
  );
  const exposedCreates =
    options.createCustomGptCreates?.({
      commands,
      repository,
      service: createService,
      serviceOptions,
    }) ?? createService;
  const server = createServer(
    createCoreApiHandler(application, {
      customGptBearerToken: createCustomGptToken,
      actionBearerToken: createCodexToken,
      adminBearerToken: createAdminToken,
      actionFileHosts: new Set(["files.example.test"]),
      customGptReads: reads,
      ...(options.enableCustomGptCreates === false
        ? {}
        : { customGptCreates: exposedCreates }),
      ...options.coreOptions,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    database.close();
    repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    application,
    commands,
    createService,
    database,
    imageBytes,
    origin,
    reads,
    repository,
    server,
    request: (
      method: string,
      path: string,
      body: unknown,
      token: string | null = createCustomGptToken,
      contentType = "application/json",
    ) =>
      fetch(origin + path, {
        method,
        headers: {
          "content-type": contentType,
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    snapshot: () =>
      [
        "products",
        "inventory_items",
        "image_assets",
        "revision_clock",
        "entity_revisions",
        "command_executions",
      ].map((table) =>
        database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
  };
}

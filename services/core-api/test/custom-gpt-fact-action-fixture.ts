import {
  CommandExecutionService,
  CustomGptFactWriteService,
  CustomGptReadService,
  InventoryApplicationService,
} from "@beautio/application";
import { SqliteInventoryRepository } from "@beautio/database";
import { createInventoryItem, createProduct } from "@beautio/domain";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import {
  createCoreApiHandler,
  type CoreApiHandlerOptions,
} from "../src/index.ts";
import type { CustomGptFactActionApplication } from "../src/custom-gpt-fact-action-route.ts";

export const factCustomGptToken = "test-custom-gpt-fact-token";
export const factCodexToken = "test-codex-fact-token";
export const factAdminToken = "test-admin-fact-token";

export function factCommandId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

export interface FactActionFixtureOptions {
  readonly coreOptions?: Partial<CoreApiHandlerOptions>;
  readonly enableFactWrites?: boolean;
  readonly createFactWrites?: (dependencies: {
    readonly commands: CommandExecutionService;
    readonly repository: SqliteInventoryRepository;
    readonly service: CustomGptFactWriteService;
  }) => CustomGptFactActionApplication;
}

/**
 * Starts a synthetic fact-Action server backed by a temporary SQLite database.
 * @param context - Node test lifecycle used to close every local resource.
 * @param options - Optional adapter overrides and service fault injection.
 * @returns Local-only HTTP helpers plus direct read-only inspection handles.
 */
export async function factActionFixture(
  context: TestContext,
  options: FactActionFixtureOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "beautio-fact-actions-"));
  const databasePath = join(directory, "test.sqlite");
  const repository = new SqliteInventoryRepository(databasePath);
  const database = new DatabaseSync(databasePath);
  const product = createProduct({
    id: "product",
    name: "Sample serum",
    alias: "Serum",
    brand: "Sample brand",
    paoDurationMonths: 6,
    sharedNotes: "Synthetic shared notes",
  });
  const item = createInventoryItem({
    id: "bottle",
    productId: product.id,
    lifecycleStatus: "unopened",
    paoDurationMonths: 6,
    expiresOn: "2028-01-01",
    customNotes: "Synthetic bottle notes",
  });
  await repository.importInventoryData({
    products: [product],
    inventoryItems: [item],
  });
  const application = new InventoryApplicationService(repository);
  const commands = new CommandExecutionService(
    repository,
    () => new Date("2026-09-05T00:00:00.000Z"),
  );
  const reads = new CustomGptReadService(application, repository, commands);
  const factWrites = new CustomGptFactWriteService(repository, commands);
  const exposedFactWrites =
    options.createFactWrites?.({ commands, repository, service: factWrites }) ??
    factWrites;
  const server = createServer(
    createCoreApiHandler(application, {
      customGptBearerToken: factCustomGptToken,
      actionBearerToken: factCodexToken,
      adminBearerToken: factAdminToken,
      actionFileHosts: new Set(["files.example.test"]),
      customGptReads: reads,
      ...(options.enableFactWrites === false
        ? {}
        : { customGptFactWrites: exposedFactWrites }),
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
    database,
    factWrites,
    origin,
    reads,
    repository,
    server,
    request: (
      method: string,
      path: string,
      body: unknown,
      token: string | null = factCustomGptToken,
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
        "revision_clock",
        "entity_revisions",
        "command_executions",
      ].map((table) =>
        database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
  };
}

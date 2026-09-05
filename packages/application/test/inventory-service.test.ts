import assert from "node:assert/strict";
import test from "node:test";
import {
  BeautioError,
  createInventoryItem,
  createProduct,
  openInventoryItem,
  updateInventoryItemPao,
  type ImageAsset,
  type InventoryItem,
  type Product,
} from "@beautio/domain";
import {
  InventoryApplicationService,
  type ImageInspection,
  type ImageAssetStorage,
  type ImageRendition,
  type ImageRenditionProvider,
  type InventoryCollectionReadOptions,
  type InventoryRepository,
  type InventoryItemCustomNotesPersistenceInput,
  type ProductFactsPersistenceInput,
  type ProductImagePersistenceInput,
  type PreparedProductImageUpload,
  type RecordProductOpenedPersistenceInput,
  type RecordProductOpenedPersistenceResult,
} from "../src/index.ts";

class RecordingInventoryRepository implements InventoryRepository {
  item: InventoryItem | null;
  readonly products: Map<string, Product>;
  saveCalls = 0;
  recordProductOpenedCalls = 0;
  recordProductOpenedUpdateCalls = 0;
  createBatchCalls = 0;
  readonly updateProductFactsCalls: ProductFactsPersistenceInput[] = [];
  readonly updateInventoryItemCustomNotesCalls:
    InventoryItemCustomNotesPersistenceInput[] = [];
  readonly setProductDisplayImageCalls: ProductImagePersistenceInput[] = [];
  readonly findAllMaximumItems: Array<number | null> = [];
  findProductByIdCalls = 0;
  updateInventoryItemFactsCalls = 0;
  endInventoryItemCalls = 0;
  endInventoryItemFailure: Error | null = null;

  constructor(item: InventoryItem | null, products: readonly Product[] = []) {
    this.item = item;
    this.products = new Map(products.map((product) => [product.id, product]));
  }

  async findById(_inventoryItemId: string): Promise<InventoryItem | null> {
    return this.item;
  }

  async findAll(
    options?: InventoryCollectionReadOptions,
  ): Promise<readonly InventoryItem[]> {
    this.findAllMaximumItems.push(options?.maximumItems ?? null);
    const items = this.item === null ? [] : [this.item];
    return options === undefined
      ? items
      : items.slice(0, options.maximumItems);
  }

  async findProductById(productId: string): Promise<Product | null> {
    this.findProductByIdCalls += 1;
    return this.products.get(productId) ?? null;
  }

  async save(item: InventoryItem): Promise<void> {
    this.saveCalls += 1;
    this.item = item;
  }

  async recordProductOpened(
    input: RecordProductOpenedPersistenceInput,
  ): Promise<RecordProductOpenedPersistenceResult> {
    this.recordProductOpenedCalls += 1;
    if (this.item === null || this.item.id !== input.inventoryItemId) {
      throw new BeautioError(
        "INVENTORY_ITEM_NOT_FOUND",
        `inventory item ${input.inventoryItemId} does not exist`,
      );
    }
    let current = this.item;
    if (
      current.lifecycleStatus === "unopened" &&
      current.paoDurationMonths === null &&
      current.productId !== null
    ) {
      current = updateInventoryItemPao(
        current,
        this.products.get(current.productId)?.paoDurationMonths ?? null,
      );
    }
    const transition = openInventoryItem(
      current,
      input.openedOn,
      input.openedOnAccuracy,
    );
    if (transition.outcome === "opened") {
      this.recordProductOpenedUpdateCalls += 1;
      this.item = transition.item;
    }
    return { outcome: transition.outcome, item: this.item };
  }

  async createBatch(): Promise<void> {
    this.createBatchCalls += 1;
  }

  async updateProductFacts(
    input: ProductFactsPersistenceInput,
  ): Promise<Product> {
    this.updateProductFactsCalls.push(input);
    const existing = this.products.get(input.productId);
    if (existing === undefined) {
      throw new BeautioError(
        "PRODUCT_NOT_FOUND",
        `Product ${input.productId} does not exist`,
      );
    }
    const updated = createProduct({
      id: existing.id,
      name: input.name,
      alias: input.alias === undefined ? existing.alias : input.alias,
      brand: input.brand === undefined ? existing.brand : input.brand,
      category: input.category,
      sizeLabel: input.sizeLabel,
      paoDurationMonths: input.paoDurationMonths === undefined ? existing.paoDurationMonths : input.paoDurationMonths,
      imageAssetId: input.imageAssetId,
      imageRef: existing.imageRef,
      ingredientListText: input.ingredientListText,
      sharedNotes: input.sharedNotes,
    });
    this.products.set(updated.id, updated);
    return updated;
  }

  async setProductDisplayImage(
    input: ProductImagePersistenceInput,
  ): Promise<Product> {
    this.setProductDisplayImageCalls.push(input);
    const existing = this.products.get(input.productId);
    if (existing === undefined) {
      throw new BeautioError(
        "PRODUCT_NOT_FOUND",
        `Product ${input.productId} does not exist`,
      );
    }
    return { ...existing, imageAssetId: input.imageAssetId };
  }

  async updateInventoryItemFacts(item: InventoryItem): Promise<InventoryItem> {
    this.updateInventoryItemFactsCalls += 1;
    this.item = item;
    return item;
  }

  async endInventoryItem(item: InventoryItem): Promise<InventoryItem> {
    this.endInventoryItemCalls += 1;
    if (this.endInventoryItemFailure !== null) {
      throw this.endInventoryItemFailure;
    }
    this.item = item;
    return item;
  }

  async updateInventoryItemCustomNotes(
    input: InventoryItemCustomNotesPersistenceInput,
  ): Promise<InventoryItem> {
    this.updateInventoryItemCustomNotesCalls.push(input);
    if (this.item === null || this.item.id !== input.inventoryItemId) {
      throw new BeautioError(
        "INVENTORY_ITEM_NOT_FOUND",
        `inventory item ${input.inventoryItemId} does not exist`,
      );
    }
    this.item = { ...this.item, customNotes: input.customNotes };
    return this.item;
  }

  async stageImageAssets(_assets: readonly ImageAsset[]): Promise<void> {
    throw new Error("not used by this test repository");
  }

  async activateStagedImageAssets(
    _imageAssetIds: readonly string[],
  ): Promise<void> {
    throw new Error("not used by this test repository");
  }

  async markImageAssetsForCleanup(
    _imageAssetIds: readonly string[],
  ): Promise<void> {
    throw new Error("not used by this test repository");
  }

  async findImageAssetById(_imageAssetId: string): Promise<ImageAsset | null> {
    return null;
  }

  async claimExpiredImageAssets(): Promise<readonly ImageAsset[]> {
    return [];
  }

  async deleteClaimedImageAsset(_imageAssetId: string): Promise<void> {
    throw new Error("not used by this test repository");
  }
}

class ReadOnlyInventoryRepository extends RecordingInventoryRepository {
  readonly items: readonly InventoryItem[];

  constructor(
    items: readonly InventoryItem[],
    products: readonly Product[] = [],
  ) {
    super(items[0] ?? null, products);
    this.items = items;
  }

  override async findById(
    inventoryItemId: string,
  ): Promise<InventoryItem | null> {
    return this.items.find((item) => item.id === inventoryItemId) ?? null;
  }

  override async findAll(
    options?: InventoryCollectionReadOptions,
  ): Promise<readonly InventoryItem[]> {
    this.findAllMaximumItems.push(options?.maximumItems ?? null);
    return options === undefined
      ? this.items
      : this.items.slice(0, options.maximumItems);
  }
}

class ImageInventoryRepository extends RecordingInventoryRepository {
  imageAsset: ImageAsset | null;
  readonly events: string[];

  constructor(imageAsset: ImageAsset, events: string[] = []) {
    super(null);
    this.imageAsset = imageAsset;
    this.events = events;
  }

  override async findImageAssetById(
    imageAssetId: string,
  ): Promise<ImageAsset | null> {
    return this.imageAsset?.id === imageAssetId ? this.imageAsset : null;
  }

  override async claimExpiredImageAssets(): Promise<readonly ImageAsset[]> {
    return this.imageAsset?.status === "pending_cleanup" ? [this.imageAsset] : [];
  }

  override async deleteClaimedImageAsset(imageAssetId: string): Promise<void> {
    this.events.push(`metadata:${imageAssetId}`);
    this.imageAsset = null;
  }
}

class ReadableImageStorage implements ImageAssetStorage {
  readonly #bytes: Uint8Array;
  readonly #events: string[];

  constructor(bytes: Uint8Array, events: string[] = []) {
    this.#bytes = bytes;
    this.#events = events;
  }

  async put(): Promise<void> {
    throw new Error("not used by image read tests");
  }

  async get(): Promise<Uint8Array> {
    return Uint8Array.from(this.#bytes);
  }

  async delete(storageKey: string): Promise<void> {
    this.#events.push(`original:${storageKey}`);
  }
}

class RecordingImageRenditions implements ImageRenditionProvider {
  readonly readCalls: string[] = [];
  readonly deleteCalls: string[] = [];
  result: ImageRendition | null;
  throwOnRead = false;
  throwOnDelete = false;
  readonly #events: string[];

  constructor(result: ImageRendition | null, events: string[] = []) {
    this.result = result;
    this.#events = events;
  }

  async readOrCreateCard(
    storageKey: string,
    _loadOriginal: () => Promise<Uint8Array>,
  ): Promise<ImageRendition | null> {
    this.readCalls.push(storageKey);
    if (this.throwOnRead) {
      throw new Error("test rendition failure");
    }
    return this.result;
  }

  async deleteForAsset(storageKey: string): Promise<void> {
    this.deleteCalls.push(storageKey);
    if (this.throwOnDelete) {
      throw new Error("test rendition deletion failure");
    }
    this.#events.push(`rendition:${storageKey}`);
  }
}

class UploadInventoryRepository extends RecordingInventoryRepository {
  readonly staged: ImageAsset[][] = [];
  readonly activated: string[][] = [];
  readonly markedForCleanup: string[][] = [];
  stageFailure: Error | null = null;
  activationFailure: Error | null = null;

  constructor() {
    super(null);
  }

  override async stageImageAssets(assets: readonly ImageAsset[]): Promise<void> {
    this.staged.push([...assets]);
    if (this.stageFailure !== null) {
      throw this.stageFailure;
    }
  }

  override async activateStagedImageAssets(
    imageAssetIds: readonly string[],
  ): Promise<void> {
    this.activated.push([...imageAssetIds]);
    if (this.activationFailure !== null) {
      throw this.activationFailure;
    }
  }

  override async markImageAssetsForCleanup(
    imageAssetIds: readonly string[],
  ): Promise<void> {
    this.markedForCleanup.push([...imageAssetIds]);
  }
}

class UploadImageStorage implements ImageAssetStorage {
  readonly puts: Array<{ readonly storageKey: string; readonly bytes: Uint8Array }> = [];
  readonly deletes: string[] = [];

  async put(storageKey: string, bytes: Uint8Array): Promise<void> {
    this.puts.push({ storageKey, bytes: Uint8Array.from(bytes) });
  }

  async get(): Promise<Uint8Array> {
    throw new Error("not used by image upload tests");
  }

  async delete(storageKey: string): Promise<void> {
    this.deletes.push(storageKey);
  }
}

test("successful write persists once and same-date retry does not save twice", async () => {
  const repository = new RecordingInventoryRepository(
    createInventoryItem({
      id: "inventory-1",
      lifecycleStatus: "unopened",
      expiresOn: "2028-01-01",
      paoDurationMonths: 12,
    }),
  );
  const service = new InventoryApplicationService(repository);
  const input = {
    inventory_item_id: "inventory-1",
    opened_on: "2026-08-18",
    opened_on_accuracy: "exact",
  } as const;

  const first = await service.recordProductOpened(input);
  const retry = await service.recordProductOpened(input);

  assert.equal(first.outcome, "opened");
  assert.equal(first.opened_on_accuracy, "exact");
  assert.equal(retry.outcome, "already_opened");
  assert.equal(retry.opened_on_accuracy, "exact");
  assert.equal(repository.recordProductOpenedCalls, 2);
  assert.equal(repository.recordProductOpenedUpdateCalls, 1);
  assert.equal(repository.saveCalls, 0);
});

test("BD-DATA-001 negative 1: missing, malformed, and impossible dates do not write", async () => {
  const repository = new RecordingInventoryRepository(
    createInventoryItem({
      id: "inventory-invalid",
      lifecycleStatus: "unopened",
    }),
  );
  const service = new InventoryApplicationService(repository);
  const invalidInputs: readonly unknown[] = [
    { inventory_item_id: "inventory-invalid" },
    {
      inventory_item_id: "inventory-invalid",
      opened_on: "2026-08-18",
    },
    {
      inventory_item_id: "inventory-invalid",
      opened_on: "18-08-2026",
      opened_on_accuracy: "exact",
    },
    {
      inventory_item_id: "inventory-invalid",
      opened_on: "2026-02-30",
      opened_on_accuracy: "estimated",
    },
  ];

  for (const invalidInput of invalidInputs) {
    await assert.rejects(
      service.recordProductOpened(invalidInput),
      hasBeautioCode("INVALID_INPUT"),
    );
  }
  assert.equal(repository.recordProductOpenedCalls, 0);
  assert.equal(repository.saveCalls, 0);
  assert.equal(repository.item?.lifecycleStatus, "unopened");
});

test("BD-DATA-001 negative 2: conflicting date has no write side effect", async () => {
  const repository = new RecordingInventoryRepository(
    createInventoryItem({
      id: "inventory-conflict",
      lifecycleStatus: "opened",
      openedOn: "2026-08-18",
      expiresOn: "2028-01-01",
      paoDurationMonths: 12,
      paoDeadline: "2027-08-18",
      usableUntil: "2027-08-18",
    }),
  );
  const service = new InventoryApplicationService(repository);

  await assert.rejects(
    service.recordProductOpened({
      inventory_item_id: "inventory-conflict",
      opened_on: "2026-08-19",
      opened_on_accuracy: "exact",
    }),
    hasBeautioCode("OPENED_ON_CONFLICT"),
  );
  assert.equal(repository.recordProductOpenedUpdateCalls, 0);
  assert.equal(repository.saveCalls, 0);
  assert.equal(repository.item?.openedOn, "2026-08-18");
});

test("BD-DATA-001 negative 3: terminal state has no write side effect", async () => {
  for (const lifecycleStatus of ["finished", "discarded"] as const) {
    const repository = new RecordingInventoryRepository(
      createInventoryItem({
        id: `inventory-${lifecycleStatus}`,
        lifecycleStatus,
      }),
    );
    const service = new InventoryApplicationService(repository);

    await assert.rejects(
      service.recordProductOpened({
        inventory_item_id: `inventory-${lifecycleStatus}`,
        opened_on: "2026-08-18",
        opened_on_accuracy: "exact",
      }),
      hasBeautioCode("INVENTORY_ITEM_TERMINAL"),
    );
    assert.equal(repository.recordProductOpenedUpdateCalls, 0);
    assert.equal(repository.saveCalls, 0);
    assert.equal(repository.item?.lifecycleStatus, lifecycleStatus);
  }
});

test("BD-DATA-001 negative 4: missing item is not implicitly created", async () => {
  const repository = new RecordingInventoryRepository(null);
  const service = new InventoryApplicationService(repository);

  await assert.rejects(
    service.recordProductOpened({
      inventory_item_id: "missing-inventory",
      opened_on: "2026-08-18",
      opened_on_accuracy: "exact",
    }),
    hasBeautioCode("INVENTORY_ITEM_NOT_FOUND"),
  );
  assert.equal(repository.recordProductOpenedUpdateCalls, 0);
  assert.equal(repository.saveCalls, 0);
  assert.equal(repository.item, null);
});

test("end use persists finished, discarded, and unknown remaining snapshots once", async () => {
  const scenarios = [
    {
      id: "finish-bottle",
      input: { as_of: "2026-09-01", lifecycle_status: "finished" } as const,
      lifecycleStatus: "finished" as const,
      remainingPercentEstimate: 0,
    },
    {
      id: "discard-bottle",
      input: {
        as_of: "2026-09-01",
        lifecycle_status: "discarded",
        remaining_percent_estimate: 35,
      } as const,
      lifecycleStatus: "discarded" as const,
      remainingPercentEstimate: 35,
    },
    {
      id: "discard-unknown-bottle",
      input: {
        as_of: "2026-09-01",
        lifecycle_status: "discarded",
        remaining_percent_estimate: null,
      } as const,
      lifecycleStatus: "discarded" as const,
      remainingPercentEstimate: null,
    },
  ];

  for (const scenario of scenarios) {
    const repository = new RecordingInventoryRepository(
      createInventoryItem({
        id: scenario.id,
        productId: "product-end-use",
        lifecycleStatus: "opened",
        openedOn: "2026-08-01",
        customNotes: "Preserve this note",
      }),
    );
    const service = new InventoryApplicationService(repository);

    const result = await service.endInventoryItem(scenario.id, scenario.input);

    assert.equal(result.lifecycle_status, scenario.lifecycleStatus);
    assert.equal(
      result.remaining_percent_estimate,
      scenario.remainingPercentEstimate,
    );
    assert.equal(result.opened_on, "2026-08-01");
    assert.equal(result.custom_notes, "Preserve this note");
    assert.equal(repository.endInventoryItemCalls, 1);
    assert.equal(repository.saveCalls, 0);
    assert.equal(repository.updateInventoryItemFactsCalls, 0);
    assert.equal(repository.item?.lifecycleStatus, scenario.lifecycleStatus);
    assert.equal(
      repository.item?.remainingPercentEstimate,
      scenario.remainingPercentEstimate,
    );
  }
});

test("end use supports an unlinked legacy bottle without inventing a Product", async () => {
  const repository = new RecordingInventoryRepository(
    createInventoryItem({
      id: "unlinked-end-use",
      lifecycleStatus: "opened",
      openedOn: "2026-08-01",
    }),
  );

  const result = await new InventoryApplicationService(
    repository,
  ).endInventoryItem("unlinked-end-use", {
    as_of: "2026-09-01",
    lifecycle_status: "finished",
  });

  assert.equal(result.product_id, null);
  assert.equal(result.lifecycle_status, "finished");
  assert.equal(result.remaining_percent_estimate, 0);
  assert.equal(repository.endInventoryItemCalls, 1);
});

test("invalid end-use commands never reach persistence", async () => {
  const invalidInputs: readonly unknown[] = [
    {
      as_of: "2026-09-01",
      lifecycle_status: "discarded",
      remaining_percent_estimate: -1,
    },
    {
      as_of: "2026-09-01",
      lifecycle_status: "discarded",
      remaining_percent_estimate: 101,
    },
    {
      as_of: "2026-09-01",
      lifecycle_status: "discarded",
      remaining_percent_estimate: 12.5,
    },
    { as_of: "2026-09-01", lifecycle_status: "discarded" },
    {
      as_of: "2026-09-01",
      lifecycle_status: "finished",
      remaining_percent_estimate: 0,
    },
  ];
  const original = createInventoryItem({
    id: "invalid-end-use",
    productId: "product-end-use",
    lifecycleStatus: "opened",
    openedOn: "2026-08-01",
  });
  const repository = new RecordingInventoryRepository(original);
  const service = new InventoryApplicationService(repository);

  for (const invalidInput of invalidInputs) {
    await assert.rejects(
      service.endInventoryItem(original.id, invalidInput),
      hasBeautioCode("INVALID_INPUT"),
    );
  }

  assert.equal(repository.endInventoryItemCalls, 0);
  assert.equal(repository.item, original);
});

test("unopened, repeated terminal, and missing end-use targets have no write side effect", async () => {
  const scenarios = [
    {
      item: createInventoryItem({
        id: "unopened-end-use",
        productId: "product-end-use",
        lifecycleStatus: "unopened",
      }),
      code: "INVALID_INPUT" as const,
    },
    {
      item: createInventoryItem({
        id: "finished-end-use",
        productId: "product-end-use",
        lifecycleStatus: "finished",
        remainingPercentEstimate: 0,
      }),
      code: "INVENTORY_ITEM_TERMINAL" as const,
    },
    {
      item: createInventoryItem({
        id: "discarded-end-use",
        productId: "product-end-use",
        lifecycleStatus: "discarded",
        remainingPercentEstimate: 40,
      }),
      code: "INVENTORY_ITEM_TERMINAL" as const,
    },
  ];

  for (const scenario of scenarios) {
    const repository = new RecordingInventoryRepository(scenario.item);
    const service = new InventoryApplicationService(repository);

    await assert.rejects(
      service.endInventoryItem(scenario.item.id, {
        as_of: "2026-09-01",
        lifecycle_status: "finished",
      }),
      hasBeautioCode(scenario.code),
    );
    assert.equal(repository.endInventoryItemCalls, 0);
    assert.equal(repository.item, scenario.item);
  }

  const missingRepository = new RecordingInventoryRepository(null);
  await assert.rejects(
    new InventoryApplicationService(missingRepository).endInventoryItem(
      "missing-end-use",
      { as_of: "2026-09-01", lifecycle_status: "finished" },
    ),
    hasBeautioCode("INVENTORY_ITEM_NOT_FOUND"),
  );
  assert.equal(missingRepository.endInventoryItemCalls, 0);
  assert.equal(missingRepository.item, null);
});

test("end-use persistence failure leaves the previously read item unchanged", async () => {
  const original = createInventoryItem({
    id: "failed-end-use",
    productId: "product-end-use",
    lifecycleStatus: "opened",
    openedOn: "2026-08-01",
  });
  const repository = new RecordingInventoryRepository(original);
  repository.endInventoryItemFailure = new Error("test end-use write failure");
  const service = new InventoryApplicationService(repository);

  await assert.rejects(
    service.endInventoryItem(original.id, {
      as_of: "2026-09-01",
      lifecycle_status: "discarded",
      remaining_percent_estimate: 25,
    }),
    /test end-use write failure/,
  );

  assert.equal(repository.endInventoryItemCalls, 1);
  assert.equal(repository.saveCalls, 0);
  assert.equal(repository.updateInventoryItemFactsCalls, 0);
  assert.equal(repository.item, original);
});

test("inventory list is read-only and derives status for the explicit date", async () => {
  const repository = new RecordingInventoryRepository(
    createInventoryItem({
      id: "inventory-visible",
      lifecycleStatus: "opened",
      openedOn: "2026-08-18",
      expiresOn: "2027-01-31",
      paoDurationMonths: 6,
      paoDeadline: "2027-02-18",
    }),
  );
  const service = new InventoryApplicationService(repository);

  const result = await service.listInventory({ as_of: "2027-02-01" });

  assert.equal(repository.saveCalls, 0);
  assert.deepEqual(result, {
    as_of: "2027-02-01",
    items: [
      {
        inventory_item_id: "inventory-visible",
        created_at: null,
        lifecycle_status: "opened",
        opened_on: "2026-08-18",
        opened_on_accuracy: "legacy_unknown",
        expires_on: "2027-01-31",
        pao_duration_months: 6,
        pao_deadline: "2027-02-18",
        pao_deadline_accuracy: "legacy_unknown",
        usable_until: "2027-01-31",
        remaining_percent_estimate: null,
        usability_status: "expired",
        warnings: ["already_expired"],
        custom_notes: null,
        product_id: null,
        product: null,
        product_inventory_position: null,
        product_inventory_count: null,
      },
    ],
  });
});

test("inventory list keeps bottles separate while sharing product facts", async () => {
  const product = createProduct({
    id: "product-shared",
    name: "Shared serum",
    brand: "Beautio Lab",
    category: "serum",
    sizeLabel: "30 ml",
    imageRef: "/fixtures/shared-serum.webp",
    ingredientListText: "Water, Glycerin",
    sharedNotes: "Use the confirmed package copy",
  });
  const items = [
    createInventoryItem({
      id: "bottle-1",
      productId: product.id,
      lifecycleStatus: "unopened",
      customNotes: "First bottle",
    }),
    createInventoryItem({
      id: "bottle-2",
      productId: product.id,
      lifecycleStatus: "unopened",
      customNotes: "Second bottle",
    }),
  ];
  const repository: InventoryRepository = {
    async findById(id) {
      return items.find((item) => item.id === id) ?? null;
    },
    async findAll() {
      return items;
    },
    async findProductById(id) {
      return id === product.id ? product : null;
    },
    async save() {},
    async recordProductOpened() {
      throw new Error("not used by this test repository");
    },
    async createBatch() {
      throw new Error("not used by this test repository");
    },
    async updateProductFacts() {
      throw new Error("not used by this test repository");
    },
    async setProductDisplayImage() {
      throw new Error("not used by this test repository");
    },
    async updateInventoryItemFacts() {
      throw new Error("not used by this test repository");
    },
    async endInventoryItem() {
      throw new Error("not used by this test repository");
    },
    async updateInventoryItemCustomNotes() {
      throw new Error("not used by this test repository");
    },
    async stageImageAssets() {
      throw new Error("not used by this test repository");
    },
    async activateStagedImageAssets() {
      throw new Error("not used by this test repository");
    },
    async markImageAssetsForCleanup() {
      throw new Error("not used by this test repository");
    },
    async findImageAssetById() {
      return null;
    },
    async claimExpiredImageAssets() {
      return [];
    },
    async deleteClaimedImageAsset() {
      throw new Error("not used by this test repository");
    },
  };
  const service = new InventoryApplicationService(repository);

  const result = await service.listInventory({ as_of: "2026-08-18" });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]?.custom_notes, "First bottle");
  assert.equal(result.items[1]?.custom_notes, "Second bottle");
  assert.deepEqual(
    result.items.map((item) => ({
      id: item.inventory_item_id,
      product: item.product,
      position: item.product_inventory_position,
      count: item.product_inventory_count,
    })),
    [
      { id: "bottle-1", product: productOutput(product), position: 1, count: 2 },
      { id: "bottle-2", product: productOutput(product), position: 2, count: 2 },
    ],
  );
});

test("BD-DATA-004 single-item read returns bottle notes and shared Product text", async () => {
  const product = createProduct({
    id: "product-readable-notes",
    name: "Readable serum",
    ingredientListText: "Water,\nGlycerin",
    sharedNotes: "Shared by every bottle",
  });
  const repository = new RecordingInventoryRepository(
    createInventoryItem({
      id: "bottle-readable-notes",
      productId: product.id,
      lifecycleStatus: "opened",
      openedOn: "2026-08-20",
      customNotes: "Only this bottle",
    }),
    [product],
  );

  const result = await new InventoryApplicationService(
    repository,
  ).getInventoryItem({
    inventory_item_id: "bottle-readable-notes",
    as_of: "2026-08-20",
  });

  assert.equal(result.custom_notes, "Only this bottle");
  assert.equal(result.product?.ingredient_list_text, "Water,\nGlycerin");
  assert.equal(result.product?.shared_notes, "Shared by every bottle");
});

test("BD-DATA-005 search matches every frozen literal field without returning long text", async () => {
  const product = createProduct({
    id: "product-id-key",
    name: "ProductNameKey",
    alias: "AliasKey",
    brand: "BrandKey",
    category: "CategoryKey",
    sizeLabel: "SizeKey",
    imageAssetId: "managed-image",
    imageRef: "/legacy/must-not-leak.jpg",
    ingredientListText: "IngredientKey",
    sharedNotes: "SharedKey",
  });
  const item = createInventoryItem({
    id: "inventory-id-key",
    productId: product.id,
    lifecycleStatus: "opened",
    openedOn: "2026-08-20",
    openedOnAccuracy: "estimated",
    paoDurationMonths: 12,
    paoDeadline: "2027-08-20",
    usableUntil: "2027-08-20",
    customNotes: "CustomKey",
  });
  const repository = new ReadOnlyInventoryRepository([item], [product]);
  const service = new InventoryApplicationService(repository, {
    clock: () => {
      throw new Error("undated reads must not use the clock");
    },
  });

  for (const query of [
    "INVENTORY-ID-KEY",
    "PRODUCT-ID-KEY",
    "PRODUCTNAMEKEY",
    "ALIASKEY",
    "BRANDKEY",
    "CATEGORYKEY",
    "SIZEKEY",
    "INGREDIENTKEY",
    "SHAREDKEY",
    "CUSTOMKEY",
  ]) {
    const match = await service.searchInventory({ query: `  ${query}  ` });
    assert.equal(match.total, 1);
    assert.equal(match.query, query);
    assert.equal(match.items[0]?.inventory_item_id, item.id);
  }

  const result = await service.searchInventory({ query: "productnamekey" });
  assert.deepEqual(result, {
    query: "productnamekey",
    offset: 0,
    limit: 20,
    total: 1,
    next_offset: null,
    items: [
      {
        inventory_item_id: "inventory-id-key",
        product_id: "product-id-key",
        product_name: "ProductNameKey",
        alias: "AliasKey",
        brand: "BrandKey",
        category: "CategoryKey",
        size_label: "SizeKey",
        lifecycle_status: "opened",
        opened_on: "2026-08-20",
        expires_on: null,
        usable_until: "2027-08-20",
        remaining_percent_estimate: null,
        has_image: true,
        derived_status: null,
      },
    ],
  });
  assert.equal(repository.saveCalls, 0);
  assert.equal(repository.createBatchCalls, 0);
  assert.equal(repository.updateProductFactsCalls.length, 0);
  assert.equal(repository.setProductDisplayImageCalls.length, 0);
  assert.equal(repository.updateInventoryItemFactsCalls, 0);
  assert.equal(repository.endInventoryItemCalls, 0);
  assert.equal(repository.updateInventoryItemCustomNotesCalls.length, 0);
  assert.equal(repository.item, item);
  assert.equal("ingredient_list_text" in result.items[0]!, false);
  assert.equal("shared_notes" in result.items[0]!, false);
  assert.equal("custom_notes" in result.items[0]!, false);
  assert.equal("image_asset_id" in result.items[0]!, false);
  assert.equal("image_ref" in result.items[0]!, false);
});

test("BD-DATA-005 search sorts complete IDs after filtering and reports pagination totals", async () => {
  const items = ["c", "a", "b"].map((suffix) =>
    createInventoryItem({
      id: `bottle-${suffix}`,
      lifecycleStatus: "unopened",
      customNotes: suffix === "a" ? "drop" : "keep",
    }),
  );
  const service = new InventoryApplicationService(
    new ReadOnlyInventoryRepository(items),
  );

  const all = await service.searchInventory({ limit: 2 });
  const first = await service.searchInventory({ query: "keep", limit: 1 });
  const second = await service.searchInventory({
    query: "keep",
    offset: 1,
    limit: 1,
  });

  assert.deepEqual(
    all.items.map((item) => item.inventory_item_id),
    ["bottle-a", "bottle-b"],
  );
  assert.equal(all.query, null);
  assert.equal(all.total, 3);
  assert.equal(all.next_offset, 2);
  assert.deepEqual(
    first.items.map((item) => item.inventory_item_id),
    ["bottle-b"],
  );
  assert.equal(first.query, "keep");
  assert.equal(first.total, 2);
  assert.equal(first.next_offset, 1);
  assert.deepEqual(
    second.items.map((item) => item.inventory_item_id),
    ["bottle-c"],
  );
  assert.equal(second.total, 2);
  assert.equal(second.next_offset, null);
  assert.equal(all.items[0]?.product_id, null);
  assert.equal(all.items[0]?.product_name, null);
  assert.equal(all.items[0]?.has_image, false);
});

test("search retains all-inventory legacy defaults and accepts strictly scoped options before pagination", async () => {
  const items = [
    createInventoryItem({ id: "a-archived", lifecycleStatus: "finished" }),
    createInventoryItem({ id: "b-active", lifecycleStatus: "unopened" }),
    createInventoryItem({ id: "c-archived", lifecycleStatus: "discarded" }),
    createInventoryItem({ id: "d-active", lifecycleStatus: "unopened" }),
  ];
  const repository = new ReadOnlyInventoryRepository(items);
  const service = new InventoryApplicationService(repository);
  const all = await service.searchInventory({ limit: 1 });
  assert.equal(all.total, 4);
  assert.equal(all.items[0]?.inventory_item_id, "a-archived");
  const active = await service.searchInventory({ limit: 1 }, { scope: "active" });
  assert.equal(active.total, 2);
  assert.equal(active.next_offset, 1);
  assert.equal(active.items[0]?.inventory_item_id, "b-active");
  const archived = await service.searchInventory({ limit: 1, offset: 1 }, { scope: "archived" });
  assert.equal(archived.total, 2);
  assert.equal(archived.next_offset, null);
  assert.equal(archived.items[0]?.inventory_item_id, "c-archived");
  const reads = repository.findAllMaximumItems.length;
  for (const options of [{ scope: "opened" }, { scope: "all", limit: 1 }, null]) {
    await assert.rejects(service.searchInventory({}, options), { code: "INVALID_INPUT" });
  }
  await assert.rejects(service.searchInventory({ scope: "active" }), { code: "INVALID_INPUT" });
  assert.equal(repository.findAllMaximumItems.length, reads);
  assert.equal(repository.saveCalls, 0);
});

test("BD-DATA-005 search reads cap plus one and rejects an oversized candidate set", async () => {
  const product = createProduct({
    id: "oversized-product",
    name: "Must not be loaded",
  });
  const items = Array.from({ length: 1_001 }, (_, index) =>
    createInventoryItem({
      id: `candidate-${index.toString().padStart(4, "0")}`,
      productId: product.id,
      lifecycleStatus: "unopened",
    }),
  );
  const repository = new ReadOnlyInventoryRepository(items, [product]);
  const service = new InventoryApplicationService(repository);

  await assert.rejects(service.searchInventory({ limit: 1 }), (error: unknown) => {
    assert.ok(error instanceof BeautioError);
    assert.equal(error.code, "INTERNAL_ERROR");
    assert.equal(
      error.message,
      "inventory search exceeds the 1000-item safety limit",
    );
    return true;
  });
  assert.deepEqual(repository.findAllMaximumItems, [1_001]);
  assert.equal(repository.findProductByIdCalls, 0);
});

test("BD-DATA-005 search preserves exact totals at the candidate safety limit", async () => {
  const items = Array.from({ length: 1_000 }, (_, index) =>
    createInventoryItem({
      id: `bounded-${index.toString().padStart(4, "0")}`,
      lifecycleStatus: "unopened",
    }),
  );
  const repository = new ReadOnlyInventoryRepository(items);
  const service = new InventoryApplicationService(repository);

  const result = await service.searchInventory({ offset: 998, limit: 1 });

  assert.deepEqual(repository.findAllMaximumItems, [1_001]);
  assert.equal(result.total, 1_000);
  assert.equal(result.next_offset, 999);
  assert.equal(result.items[0]?.inventory_item_id, "bounded-0998");
});

test("BD-DATA-005 search only derives status for an explicit as_of date", async () => {
  const item = createInventoryItem({
    id: "bottle-status",
    lifecycleStatus: "unopened",
    expiresOn: "2026-08-20",
    usableUntil: "2026-08-20",
  });
  const service = new InventoryApplicationService(
    new ReadOnlyInventoryRepository([item]),
  );

  const undated = await service.searchInventory({});
  const dated = await service.searchInventory({ as_of: "2026-08-21" });

  assert.equal(undated.items[0]?.derived_status, null);
  assert.deepEqual(dated.items[0]?.derived_status, {
    as_of: "2026-08-21",
    usability_status: "expired",
    warnings: ["already_expired", "pao_unknown"],
  });
});

test("BD-DATA-005 fetch returns complete private facts without implicit status or image references", async () => {
  const product = createProduct({
    id: "product-fetchable",
    name: "Fetchable serum",
    alias: "Purple Jar",
    brand: "Beautio Lab",
    category: "serum",
    sizeLabel: "15 ml",
    imageAssetId: "managed-image",
    imageRef: "/legacy/must-not-leak.jpg",
    ingredientListText: "Water, Glycerin",
    sharedNotes: "Shared note",
  });
  const item = createInventoryItem({
    id: "bottle-fetchable",
    productId: product.id,
    lifecycleStatus: "unopened",
    expiresOn: "2027-01-01",
    usableUntil: "2027-01-01",
    customNotes: "Bottle note",
  });
  const repository = new ReadOnlyInventoryRepository([item], [product]);
  const service = new InventoryApplicationService(repository, {
    clock: () => {
      throw new Error("undated reads must not use the clock");
    },
  });

  const result = await service.fetchInventory({
    inventory_item_id: "bottle-fetchable",
  });

  assert.deepEqual(result, {
    inventory_item: {
      inventory_item_id: "bottle-fetchable",
      product_id: "product-fetchable",
      product: {
        product_id: "product-fetchable",
        name: "Fetchable serum",
        alias: "Purple Jar",
        brand: "Beautio Lab",
        category: "serum",
        size_label: "15 ml",
        pao_duration_months: null,
        ingredient_list_text: "Water, Glycerin",
        shared_notes: "Shared note",
        has_image: true,
      },
      lifecycle_status: "unopened",
      opened_on: null,
      opened_on_accuracy: null,
      expires_on: "2027-01-01",
      pao_duration_months: null,
      pao_deadline: null,
      pao_deadline_accuracy: null,
      usable_until: "2027-01-01",
      remaining_percent_estimate: null,
      custom_notes: "Bottle note",
      derived_status: null,
    },
  });
  assert.equal("image_asset_id" in result.inventory_item.product!, false);
  assert.equal("image_ref" in result.inventory_item.product!, false);
  assert.equal(repository.saveCalls, 0);
  assert.equal(repository.createBatchCalls, 0);
  assert.equal(repository.updateProductFactsCalls.length, 0);
  assert.equal(repository.setProductDisplayImageCalls.length, 0);
  assert.equal(repository.updateInventoryItemFactsCalls, 0);
  assert.equal(repository.endInventoryItemCalls, 0);
  assert.equal(repository.updateInventoryItemCustomNotesCalls.length, 0);
  assert.equal(repository.item, item);
});

test("BD-DATA-005 fetch supports null Product and explicit derived status", async () => {
  const item = createInventoryItem({
    id: "legacy-orphan",
    lifecycleStatus: "unopened",
  });
  const result = await new InventoryApplicationService(
    new ReadOnlyInventoryRepository([item]),
  ).fetchInventory({
    inventory_item_id: "legacy-orphan",
    as_of: "2026-08-21",
  });

  assert.equal(result.inventory_item.product_id, null);
  assert.equal(result.inventory_item.product, null);
  assert.deepEqual(result.inventory_item.derived_status, {
    as_of: "2026-08-21",
    usability_status: "unknown",
    warnings: ["pao_unknown"],
  });
});

test("BD-DATA-005 dangling Product references stay hidden from fetch and search", async () => {
  const item = createInventoryItem({
    id: "legacy-dangling-product",
    productId: "missing-product",
    lifecycleStatus: "unopened",
  });
  const repository = new ReadOnlyInventoryRepository([item]);
  const service = new InventoryApplicationService(repository);

  const fetched = await service.fetchInventory({
    inventory_item_id: item.id,
  });
  const searchedByHiddenId = await service.searchInventory({
    query: "missing-product",
  });

  assert.equal(fetched.inventory_item.product_id, null);
  assert.equal(fetched.inventory_item.product, null);
  assert.equal(searchedByHiddenId.total, 0);
  assert.equal(repository.saveCalls, 0);
  assert.equal(repository.createBatchCalls, 0);
});

test("BD-DATA-005 legacy image_ref alone is not reported as a managed image", async () => {
  const product = createProduct({
    id: "product-legacy-image",
    name: "Legacy image Product",
    imageRef: "/legacy/audit-only.jpg",
  });
  const item = createInventoryItem({
    id: "bottle-legacy-image",
    productId: product.id,
    lifecycleStatus: "unopened",
  });
  const result = await new InventoryApplicationService(
    new ReadOnlyInventoryRepository([item], [product]),
  ).fetchInventory({ inventory_item_id: item.id });

  assert.equal(result.inventory_item.product?.has_image, false);
});

test("BD-DATA-002 duplicate batch refs are rejected before persistence", async () => {
  const repository = new RecordingInventoryRepository(null);
  const service = new InventoryApplicationService(repository);

  await assert.rejects(
    service.createInventoryBatch({
      as_of: "2026-08-19",
      products: [
        { batch_ref: "product_1", name: "Serum" },
        { batch_ref: "product_1", name: "Cream" },
      ],
      inventory_items: [
        {
          batch_ref: "bottle_1",
          product_ref: { kind: "new", batch_ref: "product_1" },
          lifecycle_status: "unopened",
        },
      ],
    }),
    hasBeautioCode("INVALID_INPUT"),
  );
  assert.equal(repository.createBatchCalls, 0);
});

test("BD-DATA-002 legacy_unknown can only preserve an unchanged legacy date", async () => {
  const repository = new RecordingInventoryRepository(
    createInventoryItem({
      id: "legacy-bottle",
      productId: "product-legacy",
      lifecycleStatus: "opened",
      openedOn: "2026-08-01",
      openedOnAccuracy: "legacy_unknown",
      paoDurationMonths: 12,
      paoDeadline: "2027-08-01",
      usableUntil: "2027-08-01",
    }),
  );
  const service = new InventoryApplicationService(repository);

  await assert.rejects(
    service.updateInventoryItemFacts("legacy-bottle", {
      as_of: "2026-08-19",
      lifecycle_status: "opened",
      opened_on: "2026-08-02",
      opened_on_accuracy: "legacy_unknown",
      expires_on: null,
      pao_duration_months: 12,
    }),
    hasBeautioCode("INVALID_INPUT"),
  );

  const result = await service.updateInventoryItemFacts("legacy-bottle", {
    as_of: "2026-08-19",
    lifecycle_status: "opened",
    opened_on: "2026-08-01",
    opened_on_accuracy: "legacy_unknown",
    expires_on: "2027-01-01",
    pao_duration_months: 12,
  });
  assert.equal(result.opened_on_accuracy, "legacy_unknown");
  assert.equal(result.pao_deadline_accuracy, "legacy_unknown");
  assert.equal(result.usable_until, "2027-01-01");
});

test("BD-DATA-002 terminal inventory cannot be corrected through active facts", async () => {
  const repository = new RecordingInventoryRepository(
    createInventoryItem({
      id: "finished-bottle",
      productId: "product-finished",
      lifecycleStatus: "finished",
    }),
  );
  const service = new InventoryApplicationService(repository);

  await assert.rejects(
    service.updateInventoryItemFacts("finished-bottle", {
      as_of: "2026-08-19",
      lifecycle_status: "unopened",
      opened_on: null,
      opened_on_accuracy: null,
      expires_on: null,
      pao_duration_months: null,
    }),
    hasBeautioCode("INVENTORY_ITEM_TERMINAL"),
  );
});

test("BD-DATA-004 custom notes update is narrow and works for every lifecycle", async () => {
  for (const lifecycleStatus of [
    "unopened",
    "opened",
    "finished",
    "discarded",
  ] as const) {
    const item = createInventoryItem({
      id: `noted-${lifecycleStatus}`,
      productId: "product-noted",
      lifecycleStatus,
      openedOn: lifecycleStatus === "opened" ? "2026-08-01" : null,
      expiresOn: "2027-01-01",
      paoDurationMonths: 6,
      paoDeadline: lifecycleStatus === "opened" ? "2027-02-01" : null,
      usableUntil: "2027-01-01",
      customNotes: "Before",
    });
    const repository = new RecordingInventoryRepository(item);
    const service = new InventoryApplicationService(repository);

    const result = await service.updateInventoryItemCustomNotes(item.id, {
      custom_notes: "  After  ",
    });

    assert.deepEqual(result, {
      inventory_item: {
        inventory_item_id: item.id,
        custom_notes: "After",
      },
    });
    assert.deepEqual(
      { ...repository.item, customNotes: item.customNotes },
      item,
    );
  }
});

test("BD-DATA-004 invalid custom notes bodies have zero persistence side effects", async () => {
  const repository = new RecordingInventoryRepository(
    createInventoryItem({
      id: "strict-notes",
      lifecycleStatus: "finished",
      customNotes: "Before",
    }),
  );
  const service = new InventoryApplicationService(repository);

  await assert.rejects(
    service.updateInventoryItemCustomNotes("strict-notes", {
      custom_notes: "After",
      lifecycle_status: "opened",
    }),
    hasBeautioCode("INVALID_INPUT"),
  );
  await assert.rejects(
    service.updateInventoryItemCustomNotes("strict-notes", {
      custom_notes: "x".repeat(1001),
    }),
    hasBeautioCode("INVALID_INPUT"),
  );
  assert.equal(repository.updateInventoryItemCustomNotesCalls.length, 0);
  assert.equal(repository.item?.customNotes, "Before");
});

test("BD-DATA-004 Product update replaces normalized shared text", async () => {
  const product = createProduct({
    id: "product-edit-text",
    name: "Serum",
    imageRef: "legacy-audit",
    ingredientListText: "Old ingredients",
    sharedNotes: "Old shared notes",
  });
  const repository = new RecordingInventoryRepository(null, [product]);
  const service = new InventoryApplicationService(repository, {
    clock: () => new Date("2026-08-20T00:00:00.000Z"),
  });

  const result = await service.updateProduct(product.id, {
    name: "Serum",
    alias: "  Purple Jar  ",
    brand: "  Beautio Lab  ",
    category: null,
    size_label: null,
    image_asset_id: null,
    ingredient_list_text: "  Water,\nGlycerin  ",
    shared_notes: "   ",
  });

  assert.equal(result.product.ingredient_list_text, "Water,\nGlycerin");
  assert.equal(result.product.alias, "Purple Jar");
  assert.equal(result.product.brand, "Beautio Lab");
  assert.equal(result.product.shared_notes, null);
  assert.equal(result.product.image_ref, "legacy-audit");
  assert.deepEqual(repository.updateProductFactsCalls[0], {
    productId: product.id,
    name: "Serum",
    alias: "Purple Jar",
    brand: "Beautio Lab",
    category: null,
    sizeLabel: null,
    imageAssetId: null,
    ingredientListText: "Water,\nGlycerin",
    sharedNotes: null,
    now: "2026-08-20T00:00:00.000Z",
    unlinkedExpiresAt: "2026-08-21T00:00:00.000Z",
  });
});

test("Product update preserves an existing brand when a legacy client omits it", async () => {
  const product = createProduct({
    id: "product-preserve-brand",
    name: "Serum",
    brand: "Existing Brand",
  });
  const repository = new RecordingInventoryRepository(null, [product]);
  const service = new InventoryApplicationService(repository, {
    clock: () => new Date("2026-08-20T00:00:00.000Z"),
  });

  const result = await service.updateProduct(product.id, {
    name: "Renamed Serum",
    category: null,
    size_label: null,
    image_asset_id: null,
    ingredient_list_text: null,
    shared_notes: null,
  });

  assert.equal(result.product.brand, "Existing Brand");
  assert.equal(repository.updateProductFactsCalls[0]?.brand, undefined);
});

test("Product update reports the ten-character alias limit before persistence", async () => {
  const product = createProduct({ id: "product-alias-limit", name: "Serum" });
  const repository = new RecordingInventoryRepository(null, [product]);
  const service = new InventoryApplicationService(repository);

  await assert.rejects(
    service.updateProduct(product.id, {
      name: "Serum",
      alias: "紫".repeat(11),
      category: null,
      size_label: null,
      image_asset_id: null,
      ingredient_list_text: null,
      shared_notes: null,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BeautioError);
      assert.equal(error.code, "INVALID_INPUT");
      assert.equal(error.message, "alias must be at most 10 characters");
      return true;
    },
  );

  assert.equal(repository.updateProductFactsCalls.length, 0);
  assert.deepEqual(await repository.findProductById(product.id), product);
});

test("Product update preserves an existing alias when a legacy client omits it and clears only on null", async () => {
  const product = createProduct({
    id: "product-preserve-alias",
    name: "Serum",
    alias: "Purple Jar",
  });
  const repository = new RecordingInventoryRepository(null, [product]);
  const service = new InventoryApplicationService(repository, {
    clock: () => new Date("2026-08-20T00:00:00.000Z"),
  });

  const preserved = await service.updateProduct(product.id, {
    name: "Renamed Serum",
    category: null,
    size_label: null,
    image_asset_id: null,
    ingredient_list_text: null,
    shared_notes: null,
  });
  assert.equal(preserved.product.alias, "Purple Jar");
  assert.equal(repository.updateProductFactsCalls[0]?.alias, undefined);

  const cleared = await service.updateProduct(product.id, {
    name: "Renamed Serum",
    alias: null,
    category: null,
    size_label: null,
    image_asset_id: null,
    ingredient_list_text: null,
    shared_notes: null,
  });
  assert.equal(cleared.product.alias, null);
  assert.equal(repository.updateProductFactsCalls[1]?.alias, null);
});

test("BD-DATA-004 oversized Product text leaves existing shared facts unchanged", async () => {
  const product = createProduct({
    id: "product-reject-text",
    name: "Serum",
    ingredientListText: "Old ingredients",
    sharedNotes: "Old shared notes",
  });
  const repository = new RecordingInventoryRepository(null, [product]);
  const service = new InventoryApplicationService(repository);

  await assert.rejects(
    service.updateProduct(product.id, {
      name: "Changed name must not persist",
      brand: null,
      category: null,
      size_label: null,
      image_asset_id: null,
      ingredient_list_text: "i".repeat(5001),
      shared_notes: "Changed shared notes",
    }),
    hasBeautioCode("INVALID_INPUT"),
  );

  assert.equal(repository.updateProductFactsCalls.length, 0);
  assert.deepEqual(await repository.findProductById(product.id), product);
});

test("image preparation performs no write-side work before semantic validation completes", async () => {
  const repository = new UploadInventoryRepository();
  const storage = new UploadImageStorage();
  const inspectionStarted = deferred<void>();
  const inspectionRelease = deferred<void>();
  let inspectionCalls = 0;
  let clockCalls = 0;
  let idCalls = 0;
  const service = new InventoryApplicationService(repository, {
    imageStorage: storage,
    imageInspector: {
      inspect: async (): Promise<ImageInspection> => {
        inspectionCalls += 1;
        if (inspectionCalls === 1) {
          inspectionStarted.resolve();
          await inspectionRelease.promise;
        }
        return inspectionCalls === 3
          ? validInspection({ animated: true })
          : validInspection();
      },
    },
    clock: () => {
      clockCalls += 1;
      return new Date("2026-09-04T02:00:00.000Z");
    },
    idGenerator: () => {
      idCalls += 1;
      return `generated-${idCalls}`;
    },
  });

  const preparing = service.prepareProductImages([
    { source_ref: "first", bytes: new Uint8Array([1]) },
  ]);
  await inspectionStarted.promise;

  assert.equal(clockCalls, 0);
  assert.equal(idCalls, 0);
  assert.equal(repository.staged.length, 0);
  assert.equal(repository.activated.length, 0);
  assert.equal(repository.markedForCleanup.length, 0);
  assert.equal(storage.puts.length, 0);
  assert.equal(storage.deletes.length, 0);

  inspectionRelease.resolve();
  service.discardPreparedProductImages(await preparing);

  await assert.rejects(
    service.prepareProductImages([
      { source_ref: "valid-first", bytes: new Uint8Array([2]) },
      { source_ref: "invalid-second", bytes: new Uint8Array([3]) },
    ]),
    hasBeautioCode("UNSUPPORTED_MEDIA_TYPE"),
  );
  assert.equal(clockCalls, 0);
  assert.equal(idCalls, 0);
  assert.equal(repository.staged.length, 0);
  assert.equal(repository.activated.length, 0);
  assert.equal(repository.markedForCleanup.length, 0);
  assert.equal(storage.puts.length, 0);
  assert.equal(storage.deletes.length, 0);
});

test("prepared uploads isolate caller bytes, inspector bytes, and inspection metadata", async () => {
  const repository = new UploadInventoryRepository();
  const storage = new UploadImageStorage();
  const firstInspectionStarted = deferred<void>();
  const firstInspectionRelease = deferred<void>();
  const reportedInspection: {
    mediaType: ImageInspection["mediaType"];
    width: number;
    height: number;
    animated: boolean;
  } = {
    mediaType: "image/png",
    width: 2,
    height: 2,
    animated: false,
  };
  let inspectionCalls = 0;
  let nextId = 0;
  const service = new InventoryApplicationService(repository, {
    imageStorage: storage,
    imageInspector: {
      inspect: async (bytes): Promise<ImageInspection> => {
        inspectionCalls += 1;
        bytes.fill(99);
        if (inspectionCalls === 1) {
          firstInspectionStarted.resolve();
          await firstInspectionRelease.promise;
        }
        return reportedInspection;
      },
    },
    clock: () => new Date("2026-09-04T03:00:00.000Z"),
    idGenerator: (kind) => `${kind}-${++nextId}`,
  });
  const first = new Uint8Array([1, 2, 3]);
  const second = new Uint8Array([4, 5, 6]);
  const expectedFirst = Uint8Array.from(first);
  const expectedSecond = Uint8Array.from(second);

  const preparing = service.prepareProductImages([
    { source_ref: "first", bytes: first },
    { source_ref: "second", bytes: second },
  ]);
  await firstInspectionStarted.promise;
  first.fill(7);
  second.fill(8);
  firstInspectionRelease.resolve();
  const prepared = await preparing;

  reportedInspection.mediaType = "image/jpeg";
  reportedInspection.width = 50_000;
  reportedInspection.height = 50_000;
  reportedInspection.animated = true;
  const result = await service.commitPreparedProductImages(prepared);

  assert.deepEqual(
    storage.puts.map((put) => put.bytes),
    [expectedFirst, expectedSecond],
  );
  assert.deepEqual(
    repository.staged[0]?.map((asset) => asset.mediaType),
    ["image/png", "image/png"],
  );
  assert.deepEqual(
    result.assets.map((asset) => asset.media_type),
    ["image/png", "image/png"],
  );
});

test("prepared upload handles are opaque, same-service, and atomically single-use", async () => {
  const repository = new UploadInventoryRepository();
  const storage = new UploadImageStorage();
  let nextId = 0;
  const service = new InventoryApplicationService(repository, {
    imageStorage: storage,
    imageInspector: unusedImageInspector,
    clock: () => new Date("2026-09-04T04:00:00.000Z"),
    idGenerator: (kind) => `${kind}-${++nextId}`,
  });
  const prepared = await service.prepareProductImages([
    { source_ref: "single", bytes: new Uint8Array([1, 2, 3]) },
  ]);

  const concurrent = await Promise.allSettled([
    service.commitPreparedProductImages(prepared),
    service.commitPreparedProductImages(prepared),
  ]);
  assert.equal(
    concurrent.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = concurrent.find((result) => result.status === "rejected");
  assert.equal(rejected?.status, "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(rejected.reason instanceof BeautioError);
  assert.equal(rejected.reason.code, "INTERNAL_ERROR");
  assert.equal(repository.staged.length, 1);
  assert.equal(repository.activated.length, 1);
  assert.equal(storage.puts.length, 1);
  await assert.rejects(
    service.commitPreparedProductImages(prepared),
    hasBeautioCode("INTERNAL_ERROR"),
  );

  const ownerRepository = new UploadInventoryRepository();
  const ownerStorage = new UploadImageStorage();
  let ownerId = 0;
  const owner = new InventoryApplicationService(ownerRepository, {
    imageStorage: ownerStorage,
    imageInspector: unusedImageInspector,
    clock: () => new Date("2026-09-04T05:00:00.000Z"),
    idGenerator: (kind) => `owner-${kind}-${++ownerId}`,
  });
  const foreign = new InventoryApplicationService(
    new UploadInventoryRepository(),
    {
      imageStorage: new UploadImageStorage(),
      imageInspector: unusedImageInspector,
    },
  );
  const ownerHandle = await owner.prepareProductImages([
    { source_ref: "owned", bytes: new Uint8Array([4]) },
  ]);

  await assert.rejects(
    foreign.commitPreparedProductImages(ownerHandle),
    hasBeautioCode("INTERNAL_ERROR"),
  );
  await assert.rejects(
    owner.commitPreparedProductImages({} as PreparedProductImageUpload),
    hasBeautioCode("INTERNAL_ERROR"),
  );
  await owner.commitPreparedProductImages(ownerHandle);
  assert.equal(ownerRepository.staged.length, 1);
  assert.equal(ownerStorage.puts.length, 1);
});

test("an abort before commit burns the handle without starting write-side work", async () => {
  const repository = new UploadInventoryRepository();
  const storage = new UploadImageStorage();
  let clockCalls = 0;
  let idCalls = 0;
  const service = new InventoryApplicationService(repository, {
    imageStorage: storage,
    imageInspector: unusedImageInspector,
    clock: () => {
      clockCalls += 1;
      return new Date("2026-09-04T06:00:00.000Z");
    },
    idGenerator: () => {
      idCalls += 1;
      return `id-${idCalls}`;
    },
  });
  const prepared = await service.prepareProductImages([
    { source_ref: "aborted", bytes: new Uint8Array([1]) },
  ]);
  const abort = new AbortController();
  abort.abort();

  await assert.rejects(
    service.commitPreparedProductImages(prepared, { signal: abort.signal }),
    hasBeautioCode("UPLOAD_FAILED"),
  );
  assert.equal(clockCalls, 0);
  assert.equal(idCalls, 0);
  assert.equal(repository.staged.length, 0);
  assert.equal(repository.activated.length, 0);
  assert.equal(repository.markedForCleanup.length, 0);
  assert.equal(storage.puts.length, 0);
  await assert.rejects(
    service.commitPreparedProductImages(prepared),
    hasBeautioCode("INTERNAL_ERROR"),
  );
});

test("clock and ID failures each burn a prepared upload handle", async () => {
  const clockRepository = new UploadInventoryRepository();
  const clockService = new InventoryApplicationService(clockRepository, {
    imageStorage: new UploadImageStorage(),
    imageInspector: unusedImageInspector,
    clock: () => new Date(Number.NaN),
  });
  const clockHandle = await clockService.prepareProductImages([
    { source_ref: "clock", bytes: new Uint8Array([1]) },
  ]);
  await assert.rejects(
    clockService.commitPreparedProductImages(clockHandle),
    hasBeautioCode("INTERNAL_ERROR"),
  );
  await assert.rejects(
    clockService.commitPreparedProductImages(clockHandle),
    hasBeautioCode("INTERNAL_ERROR"),
  );
  assert.equal(clockRepository.staged.length, 0);

  const idRepository = new UploadInventoryRepository();
  const idService = new InventoryApplicationService(idRepository, {
    imageStorage: new UploadImageStorage(),
    imageInspector: unusedImageInspector,
    clock: () => new Date("2026-09-04T07:00:00.000Z"),
    idGenerator: () => "   ",
  });
  const idHandle = await idService.prepareProductImages([
    { source_ref: "id", bytes: new Uint8Array([2]) },
  ]);
  await assert.rejects(
    idService.commitPreparedProductImages(idHandle),
    hasBeautioCode("INTERNAL_ERROR"),
  );
  await assert.rejects(
    idService.commitPreparedProductImages(idHandle),
    hasBeautioCode("INTERNAL_ERROR"),
  );
  assert.equal(idRepository.staged.length, 0);
});

test("upload timestamps and expiry are derived at commit time", async () => {
  const repository = new UploadInventoryRepository();
  let clockCalls = 0;
  let now = new Date("2026-09-04T08:00:00.000Z");
  let nextId = 0;
  const service = new InventoryApplicationService(repository, {
    imageStorage: new UploadImageStorage(),
    imageInspector: unusedImageInspector,
    clock: () => {
      clockCalls += 1;
      return new Date(now);
    },
    idGenerator: (kind) => `${kind}-${++nextId}`,
  });

  const prepared = await service.prepareProductImages([
    { source_ref: "commit-time", bytes: new Uint8Array([1]) },
  ]);
  assert.equal(clockCalls, 0);
  now = new Date("2026-09-05T09:10:11.000Z");

  const result = await service.commitPreparedProductImages(prepared);

  assert.equal(clockCalls, 1);
  assert.equal(repository.staged[0]?.[0]?.createdAt, now.toISOString());
  assert.equal(
    repository.staged[0]?.[0]?.expiresAt,
    "2026-09-06T09:10:11.000Z",
  );
  assert.equal(result.assets[0]?.expires_at, "2026-09-06T09:10:11.000Z");
});

test("live prepared bytes are capped at 100 MiB and released by discard and commit", async () => {
  const repository = new UploadInventoryRepository();
  const storage = discardingImageStorage();
  let inspectionCalls = 0;
  let nextId = 0;
  const service = new InventoryApplicationService(repository, {
    imageStorage: storage,
    imageInspector: {
      inspect: async () => {
        inspectionCalls += 1;
        return validInspection();
      },
    },
    clock: () => new Date("2026-09-04T10:00:00.000Z"),
    idGenerator: (kind) => `${kind}-${++nextId}`,
  });
  const twentyMiB = new Uint8Array(20 * 1024 * 1024);
  const tenMiB = new Uint8Array(10 * 1024 * 1024);
  const first = await service.prepareProductImages(
    fiftyMiBUpload("first", twentyMiB, tenMiB),
  );
  const second = await service.prepareProductImages(
    fiftyMiBUpload("second", twentyMiB, tenMiB),
  );
  assert.equal(inspectionCalls, 6);

  await assert.rejects(
    service.prepareProductImages([
      { source_ref: "over-budget", bytes: new Uint8Array([1]) },
    ]),
    hasBeautioCode("BATCH_CONFLICT"),
  );
  assert.equal(inspectionCalls, 6);

  service.discardPreparedProductImages(first);
  const afterDiscard = await service.prepareProductImages([
    { source_ref: "after-discard", bytes: new Uint8Array([1]) },
  ]);

  await assert.rejects(
    service.prepareProductImages(
      fiftyMiBUpload("before-commit", twentyMiB, tenMiB),
    ),
    hasBeautioCode("BATCH_CONFLICT"),
  );

  await service.commitPreparedProductImages(second);
  const afterCommit = await service.prepareProductImages(
    fiftyMiBUpload("after-commit", twentyMiB, tenMiB),
  );
  service.discardPreparedProductImages(afterDiscard);
  service.discardPreparedProductImages(afterCommit);
});

test("queued abort and semantic failure restore reserved preparation bytes", async () => {
  const twentyMiB = new Uint8Array(20 * 1024 * 1024);
  const tenMiB = new Uint8Array(10 * 1024 * 1024);
  const activeInspectionStarted = deferred<void>();
  const activeInspectionRelease = deferred<void>();
  let inspectionCalls = 0;
  const service = new InventoryApplicationService(
    new UploadInventoryRepository(),
    {
      imageStorage: discardingImageStorage(),
      imageInspector: {
        inspect: async () => {
          inspectionCalls += 1;
          if (inspectionCalls === 1) {
            activeInspectionStarted.resolve();
            await activeInspectionRelease.promise;
          }
          return validInspection();
        },
      },
    },
  );
  const active = service.prepareProductImages(
    fiftyMiBUpload("active", twentyMiB, tenMiB),
  );
  await activeInspectionStarted.promise;
  const queuedAbort = new AbortController();
  const queued = service.prepareProductImages(
    fiftyMiBUpload("queued", twentyMiB, tenMiB),
    { signal: queuedAbort.signal },
  );
  queuedAbort.abort();
  await assert.rejects(queued, hasBeautioCode("UPLOAD_FAILED"));

  const replacement = service.prepareProductImages([
    { source_ref: "replacement", bytes: new Uint8Array([1]) },
  ]);
  assert.equal(inspectionCalls, 1);
  activeInspectionRelease.resolve();
  const activeHandle = await active;
  const replacementHandle = await replacement;
  service.discardPreparedProductImages(activeHandle);
  service.discardPreparedProductImages(replacementHandle);

  let failureInspectionCalls = 0;
  const failureService = new InventoryApplicationService(
    new UploadInventoryRepository(),
    {
      imageStorage: discardingImageStorage(),
      imageInspector: {
        inspect: async () => {
          failureInspectionCalls += 1;
          if (failureInspectionCalls === 4) {
            return validInspection({ animated: true });
          }
          return validInspection();
        },
      },
    },
  );
  const baseline = await failureService.prepareProductImages(
    fiftyMiBUpload("baseline", twentyMiB, tenMiB),
  );
  await assert.rejects(
    failureService.prepareProductImages(
      fiftyMiBUpload("failed", twentyMiB, tenMiB),
    ),
    hasBeautioCode("UNSUPPORTED_MEDIA_TYPE"),
  );
  const afterFailure = await failureService.prepareProductImages([
    { source_ref: "after-failure", bytes: new Uint8Array([1]) },
  ]);
  failureService.discardPreparedProductImages(baseline);
  failureService.discardPreparedProductImages(afterFailure);
});

test("at most 17 prepared handles can remain live", async () => {
  let inspectionCalls = 0;
  const service = new InventoryApplicationService(
    new UploadInventoryRepository(),
    {
      imageStorage: discardingImageStorage(),
      imageInspector: {
        inspect: async () => {
          inspectionCalls += 1;
          return validInspection();
        },
      },
    },
  );
  const handles: PreparedProductImageUpload[] = [];
  for (let index = 0; index < 17; index += 1) {
    handles.push(
      await service.prepareProductImages([
        { source_ref: `live-${index}`, bytes: new Uint8Array([index]) },
      ]),
    );
  }
  await assert.rejects(
    service.prepareProductImages([
      { source_ref: "eighteenth", bytes: new Uint8Array([18]) },
    ]),
    hasBeautioCode("BATCH_CONFLICT"),
  );
  assert.equal(inspectionCalls, 17);

  service.discardPreparedProductImages(handles.shift()!);
  const replacement = await service.prepareProductImages([
    { source_ref: "replacement", bytes: new Uint8Array([19]) },
  ]);
  assert.equal(inspectionCalls, 18);
  for (const handle of handles) {
    service.discardPreparedProductImages(handle);
  }
  service.discardPreparedProductImages(replacement);
});

test("stage, storage, and activation failures restore the weighted preparation budget", async () => {
  const twentyMiB = new Uint8Array(20 * 1024 * 1024);
  const tenMiB = new Uint8Array(10 * 1024 * 1024);
  const failureKinds = ["stage", "storage", "activation"] as const;

  for (const failureKind of failureKinds) {
    const repository = new UploadInventoryRepository();
    if (failureKind === "stage") {
      repository.stageFailure = new Error("forced stage failure");
    }
    if (failureKind === "activation") {
      repository.activationFailure = new Error("forced activation failure");
    }
    const storage: ImageAssetStorage = {
      async put(): Promise<void> {
        if (failureKind === "storage") {
          throw new Error("forced storage failure");
        }
      },
      async get(): Promise<Uint8Array> {
        throw new Error("not used by failure capacity tests");
      },
      async delete(): Promise<void> {},
    };
    let nextId = 0;
    const service = new InventoryApplicationService(repository, {
      imageStorage: storage,
      imageInspector: unusedImageInspector,
      clock: () => new Date("2026-09-04T11:00:00.000Z"),
      idGenerator: (kind) => `${failureKind}-${kind}-${++nextId}`,
    });
    const baseline = await service.prepareProductImages(
      fiftyMiBUpload(`${failureKind}-baseline`, twentyMiB, tenMiB),
    );
    const failing = await service.prepareProductImages(
      fiftyMiBUpload(`${failureKind}-failing`, twentyMiB, tenMiB),
    );

    await assert.rejects(
      service.commitPreparedProductImages(failing),
      hasBeautioCode("UPLOAD_FAILED"),
    );
    const replacement = await service.prepareProductImages(
      fiftyMiBUpload(`${failureKind}-replacement`, twentyMiB, tenMiB),
    );
    service.discardPreparedProductImages(baseline);
    service.discardPreparedProductImages(replacement);
  }
});

test("weighted bytes remain reserved until failed-upload compensation really settles", async () => {
  const twentyMiB = new Uint8Array(20 * 1024 * 1024);
  const tenMiB = new Uint8Array(10 * 1024 * 1024);
  const repository = new UploadInventoryRepository();
  const compensationStarted = deferred<void>();
  const compensationRelease = deferred<void>();
  const originalMarkForCleanup = repository.markImageAssetsForCleanup;
  repository.markImageAssetsForCleanup = async (...args): Promise<void> => {
    compensationStarted.resolve();
    await compensationRelease.promise;
    return originalMarkForCleanup.apply(repository, args);
  };
  const service = new InventoryApplicationService(repository, {
    imageStorage: {
      async put(): Promise<void> {
        throw new Error("forced storage failure");
      },
      async get(): Promise<Uint8Array> {
        throw new Error("not used by compensation capacity test");
      },
      async delete(): Promise<void> {},
    },
    imageInspector: unusedImageInspector,
    clock: () => new Date("2026-09-04T12:00:00.000Z"),
  });
  const baseline = await service.prepareProductImages(
    fiftyMiBUpload("compensation-baseline", twentyMiB, tenMiB),
  );
  const failing = await service.prepareProductImages(
    fiftyMiBUpload("compensation-failing", twentyMiB, tenMiB),
  );
  let commitSettled = false;
  const commit = service.commitPreparedProductImages(failing).finally(() => {
    commitSettled = true;
  });
  await compensationStarted.promise;

  assert.equal(commitSettled, false);
  await assert.rejects(
    service.prepareProductImages([
      { source_ref: "before-compensation-settles", bytes: new Uint8Array([1]) },
    ]),
    hasBeautioCode("BATCH_CONFLICT"),
  );

  compensationRelease.resolve();
  await assert.rejects(commit, hasBeautioCode("UPLOAD_FAILED"));
  const replacement = await service.prepareProductImages(
    fiftyMiBUpload("after-compensation", twentyMiB, tenMiB),
  );
  service.discardPreparedProductImages(baseline);
  service.discardPreparedProductImages(replacement);
});

test("setting a Product display image validates, timestamps, delegates, and returns shared facts", async () => {
  const product = createProduct({
    id: "product-shared",
    name: "Shared serum",
    category: "serum",
    sizeLabel: "30 ml",
    imageRef: "legacy-audit-value",
  });
  const repository = new RecordingInventoryRepository(null, [product]);
  let clockCalls = 0;
  const service = new InventoryApplicationService(repository, {
    clock: () => {
      clockCalls += 1;
      return new Date("2026-08-20T02:03:04.000Z");
    },
  });

  const result = await service.setProductDisplayImage({
    product_id: "  product-shared  ",
    image_asset_id: "  image-asset-new  ",
  });

  assert.equal(clockCalls, 1);
  assert.deepEqual(repository.setProductDisplayImageCalls, [
    {
      productId: "product-shared",
      imageAssetId: "image-asset-new",
      now: "2026-08-20T02:03:04.000Z",
      unlinkedExpiresAt: "2026-08-21T02:03:04.000Z",
    },
  ]);
  assert.deepEqual(result, {
    product: {
      product_id: "product-shared",
      name: "Shared serum",
      alias: null,
      brand: null,
      category: "serum",
      size_label: "30 ml",
      image_asset_id: "image-asset-new",
      image_ref: "legacy-audit-value",
      pao_duration_months: null,
      ingredient_list_text: null,
      shared_notes: null,
    },
  });
});

test("card image reads use a linked rendition while original reads remain byte-exact", async () => {
  const asset = imageAsset({ status: "linked", productId: "product-one" });
  const repository = new ImageInventoryRepository(asset);
  const original = new Uint8Array([1, 2, 3]);
  const renditions = new RecordingImageRenditions({
    mediaType: "image/webp",
    bytes: new Uint8Array([9, 8]),
  });
  const service = new InventoryApplicationService(repository, {
    imageStorage: new ReadableImageStorage(original),
    imageInspector: unusedImageInspector,
    imageRenditions: renditions,
  });

  const originalRead = await service.readImageAsset(asset.id);
  const cardRead = await service.readImageAsset(asset.id, "card");

  assert.deepEqual(originalRead, {
    image_asset_id: asset.id,
    media_type: "image/png",
    byte_size: 3,
    bytes: original,
  });
  assert.deepEqual(cardRead, {
    image_asset_id: asset.id,
    media_type: "image/webp",
    byte_size: 2,
    bytes: new Uint8Array([9, 8]),
  });
  assert.deepEqual(renditions.readCalls, [asset.storageKey]);
});

test("card image rendering is optional and safely falls back to the verified original", async () => {
  for (const status of ["linked", "temporary"] as const) {
    const asset = imageAsset({
      status,
      productId: status === "linked" ? "product-one" : null,
    });
    const renditions = new RecordingImageRenditions(null);
    renditions.throwOnRead = true;
    const service = new InventoryApplicationService(
      new ImageInventoryRepository(asset),
      {
        imageStorage: new ReadableImageStorage(new Uint8Array([1, 2, 3])),
        imageInspector: unusedImageInspector,
        imageRenditions: renditions,
      },
    );

    const result = await service.readImageAsset(asset.id, "card");

    assert.equal(result.media_type, "image/png");
    assert.deepEqual(result.bytes, new Uint8Array([1, 2, 3]));
    assert.equal(renditions.readCalls.length, status === "linked" ? 1 : 0);
  }
});

test("expired image cleanup removes renditions and original before metadata", async () => {
  const events: string[] = [];
  const asset = imageAsset({ status: "pending_cleanup", productId: null });
  const repository = new ImageInventoryRepository(asset, events);
  const renditions = new RecordingImageRenditions(null, events);
  const service = new InventoryApplicationService(repository, {
    imageStorage: new ReadableImageStorage(new Uint8Array([1, 2, 3]), events),
    imageInspector: unusedImageInspector,
    imageRenditions: renditions,
  });

  assert.deepEqual(await service.cleanupExpiredImageAssets(), {
    claimed: 1,
    deleted: 1,
    failed: 0,
  });
  assert.deepEqual(events, [
    `rendition:${asset.storageKey}`,
    `original:${asset.storageKey}`,
    `metadata:${asset.id}`,
  ]);
});

test("rendition deletion failure keeps cleanup metadata for a later retry", async () => {
  const events: string[] = [];
  const asset = imageAsset({ status: "pending_cleanup", productId: null });
  const repository = new ImageInventoryRepository(asset, events);
  const renditions = new RecordingImageRenditions(null, events);
  renditions.throwOnDelete = true;
  const service = new InventoryApplicationService(repository, {
    imageStorage: new ReadableImageStorage(new Uint8Array([1, 2, 3]), events),
    imageInspector: unusedImageInspector,
    imageRenditions: renditions,
  });

  assert.deepEqual(await service.cleanupExpiredImageAssets(), {
    claimed: 1,
    deleted: 0,
    failed: 1,
  });
  assert.equal(repository.imageAsset?.id, asset.id);
  assert.deepEqual(events, []);
  assert.deepEqual(renditions.deleteCalls, [asset.storageKey]);
});

function productOutput(product: Product): {
  readonly product_id: string;
  readonly name: string;
  readonly alias: string | null;
  readonly brand: string | null;
  readonly category: string | null;
  readonly size_label: string | null;
  readonly pao_duration_months: number | null;
  readonly image_asset_id: string | null;
  readonly image_ref: string | null;
  readonly ingredient_list_text: string | null;
  readonly shared_notes: string | null;
} {
  return {
    product_id: product.id,
    name: product.name,
    alias: product.alias,
    brand: product.brand,
    category: product.category,
    size_label: product.sizeLabel,
    pao_duration_months: product.paoDurationMonths,
    image_asset_id: product.imageAssetId,
    image_ref: product.imageRef,
    ingredient_list_text: product.ingredientListText,
    shared_notes: product.sharedNotes,
  };
}

const unusedImageInspector = {
  inspect: async () => ({
    mediaType: "image/png" as const,
    width: 1,
    height: 1,
    animated: false,
  }),
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function validInspection(
  overrides: Partial<ImageInspection> = {},
): ImageInspection {
  return {
    mediaType: "image/png",
    width: 1,
    height: 1,
    animated: false,
    ...overrides,
  };
}

function fiftyMiBUpload(
  prefix: string,
  twentyMiB: Uint8Array,
  tenMiB: Uint8Array,
): readonly { readonly source_ref: string; readonly bytes: Uint8Array }[] {
  return [
    { source_ref: `${prefix}-first`, bytes: twentyMiB },
    { source_ref: `${prefix}-second`, bytes: twentyMiB },
    { source_ref: `${prefix}-third`, bytes: tenMiB },
  ];
}

function discardingImageStorage(): ImageAssetStorage {
  return {
    async put(): Promise<void> {},
    async get(): Promise<Uint8Array> {
      throw new Error("not used by image upload capacity tests");
    },
    async delete(): Promise<void> {},
  };
}

function imageAsset(input: {
  readonly status: ImageAsset["status"];
  readonly productId: string | null;
}): ImageAsset {
  return {
    id: "asset-one",
    storageKey: "storage-one",
    mediaType: "image/png",
    byteSize: 3,
    status: input.status,
    productId: input.productId,
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-08-20T00:00:00.000Z",
  };
}

function hasBeautioCode(
  code: BeautioError["code"],
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof BeautioError);
    assert.equal(error.code, code);
    return true;
  };
}

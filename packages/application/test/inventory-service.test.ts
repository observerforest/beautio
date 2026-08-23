import assert from "node:assert/strict";
import test from "node:test";
import {
  BeautioError,
  createInventoryItem,
  createProduct,
  type ImageAsset,
  type InventoryItem,
  type Product,
} from "@beautio/domain";
import {
  InventoryApplicationService,
  type ImageAssetStorage,
  type ImageRendition,
  type ImageRenditionProvider,
  type InventoryRepository,
  type InventoryItemCustomNotesPersistenceInput,
  type ProductFactsPersistenceInput,
  type ProductImagePersistenceInput,
} from "../src/index.ts";

class RecordingInventoryRepository implements InventoryRepository {
  item: InventoryItem | null;
  readonly products: Map<string, Product>;
  saveCalls = 0;
  createBatchCalls = 0;
  readonly updateProductFactsCalls: ProductFactsPersistenceInput[] = [];
  readonly updateInventoryItemCustomNotesCalls:
    InventoryItemCustomNotesPersistenceInput[] = [];
  readonly setProductDisplayImageCalls: ProductImagePersistenceInput[] = [];
  updateInventoryItemFactsCalls = 0;

  constructor(item: InventoryItem | null, products: readonly Product[] = []) {
    this.item = item;
    this.products = new Map(products.map((product) => [product.id, product]));
  }

  async findById(_inventoryItemId: string): Promise<InventoryItem | null> {
    return this.item;
  }

  async findAll(): Promise<readonly InventoryItem[]> {
    return this.item === null ? [] : [this.item];
  }

  async findProductById(productId: string): Promise<Product | null> {
    return this.products.get(productId) ?? null;
  }

  async save(item: InventoryItem): Promise<void> {
    this.saveCalls += 1;
    this.item = item;
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
      category: input.category,
      sizeLabel: input.sizeLabel,
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

  async stageImageAssets(): Promise<void> {
    throw new Error("not used by this test repository");
  }

  async activateStagedImageAssets(): Promise<void> {
    throw new Error("not used by this test repository");
  }

  async markImageAssetsForCleanup(): Promise<void> {
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

  override async findAll(): Promise<readonly InventoryItem[]> {
    return this.items;
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
  } as const;

  const first = await service.recordProductOpened(input);
  const retry = await service.recordProductOpened(input);

  assert.equal(first.outcome, "opened");
  assert.equal(retry.outcome, "already_opened");
  assert.equal(repository.saveCalls, 1);
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
      opened_on: "18-08-2026",
    },
    {
      inventory_item_id: "inventory-invalid",
      opened_on: "2026-02-30",
    },
  ];

  for (const invalidInput of invalidInputs) {
    await assert.rejects(
      service.recordProductOpened(invalidInput),
      hasBeautioCode("INVALID_INPUT"),
    );
  }
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
    }),
    hasBeautioCode("OPENED_ON_CONFLICT"),
  );
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
      }),
      hasBeautioCode("INVENTORY_ITEM_TERMINAL"),
    );
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
    }),
    hasBeautioCode("INVENTORY_ITEM_NOT_FOUND"),
  );
  assert.equal(repository.saveCalls, 0);
  assert.equal(repository.item, null);
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
        lifecycle_status: "opened",
        opened_on: "2026-08-18",
        opened_on_accuracy: "legacy_unknown",
        expires_on: "2027-01-31",
        pao_duration_months: 6,
        pao_deadline: "2027-02-18",
        pao_deadline_accuracy: "legacy_unknown",
        usable_until: "2027-01-31",
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
        category: "CategoryKey",
        size_label: "SizeKey",
        lifecycle_status: "opened",
        opened_on: "2026-08-20",
        expires_on: null,
        usable_until: "2027-08-20",
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
        category: "serum",
        size_label: "15 ml",
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
    category: null,
    size_label: null,
    image_asset_id: null,
    ingredient_list_text: "  Water,\nGlycerin  ",
    shared_notes: "   ",
  });

  assert.equal(result.product.ingredient_list_text, "Water,\nGlycerin");
  assert.equal(result.product.shared_notes, null);
  assert.equal(result.product.image_ref, "legacy-audit");
  assert.deepEqual(repository.updateProductFactsCalls[0], {
    productId: product.id,
    name: "Serum",
    category: null,
    sizeLabel: null,
    imageAssetId: null,
    ingredientListText: "Water,\nGlycerin",
    sharedNotes: null,
    now: "2026-08-20T00:00:00.000Z",
    unlinkedExpiresAt: "2026-08-21T00:00:00.000Z",
  });
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
      category: "serum",
      size_label: "30 ml",
      image_asset_id: "image-asset-new",
      image_ref: "legacy-audit-value",
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
  readonly category: string | null;
  readonly size_label: string | null;
  readonly image_asset_id: string | null;
  readonly image_ref: string | null;
  readonly ingredient_list_text: string | null;
  readonly shared_notes: string | null;
} {
  return {
    product_id: product.id,
    name: product.name,
    category: product.category,
    size_label: product.sizeLabel,
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

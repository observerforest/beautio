import {
  beautioBackupImageSchema,
  beautioBackupInventoryItemSchema,
  beautioBackupProductSchema,
  createInventoryBatchInputSchema,
  fetchInventoryInputSchema,
  getInventoryItemInputSchema,
  listInventoryInputSchema,
  productIdSchema,
  recordProductOpenedInputSchema,
  searchInventoryInputSchema,
  setProductDisplayImageInputSchema,
  updateInventoryItemFactsInputSchema,
  updateInventoryItemCustomNotesInputSchema,
  updateProductInputSchema,
  type CreateInventoryBatchOutput,
  type BeautioBackup,
  type FetchInventoryOutput,
  type InventoryListOutput,
  type GetInventoryItemOutput,
  type RecordProductOpenedOutput,
  type RestoreBeautioBackupOutput,
  type SearchInventoryOutput,
  type SetProductDisplayImageOutput,
  type UpdateInventoryItemFactsOutput,
  type UpdateInventoryItemCustomNotesOutput,
  type UpdateProductOutput,
  type UploadProductImagesOutput,
} from "@beautio/contracts";
import {
  BeautioError,
  createInventoryItem,
  createInventoryItemFromFacts,
  createProduct,
  deriveInventorySnapshot,
  imageMediaTypes,
  openInventoryItem,
  parseIsoDate,
  type ImageAsset,
  type InventoryItem,
  type Product,
} from "@beautio/domain";
import { createHash, randomUUID } from "node:crypto";
import type {
  BackupInventoryRepository,
  GeneratedIdKind,
  ImageInspection,
  ImageAssetStorage,
  ImageInspector,
  ImageRenditionProvider,
  InventoryRepository,
} from "./ports.ts";
import {
  abortableInspection,
  assertUploadNotAborted,
  ensureUniqueRefs,
  parseImageUploads,
  parseInput,
  parseRequiredId,
  validateEditedOpeningAccuracy,
} from "./input-parsing.ts";
import type {
  BackupExportPlan,
  BackupOperationOptions,
  CleanupImageAssetsOutput,
  ImageAssetReadVariant,
  ImageUploadInput,
  ImageUploadOperationOptions,
  InventoryApplicationServiceOptions,
  ReadImageAssetOutput,
} from "./inventory-service-types.ts";
import {
  asActiveLifecycle,
  assertValidClock,
  countInventoryByProduct,
  inventoryMatchesQuery,
  requireArrayItem,
  requireProductId,
  toInventoryListItemOutput,
  toInventoryReadModelOutput,
  toInventorySearchItemOutput,
  toInventoryStateOutput,
  toProductOutput,
} from "./output-mappers.ts";
import {
  loadProducts,
  requireInventoryItem,
  requireProduct,
} from "./repository-queries.ts";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const TEMPORARY_ASSET_MILLISECONDS = 24 * 60 * 60 * 1000;
const MAX_BACKUP_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;
const MAX_BACKUP_SERIALIZED_BYTES = 280 * 1024 * 1024;

export class InventoryApplicationService {
  readonly #repository: InventoryRepository;
  readonly #idGenerator: (kind: GeneratedIdKind) => string;
  readonly #clock: () => Date;
  readonly #imageStorage: ImageAssetStorage | undefined;
  readonly #imageInspector: ImageInspector | undefined;
  readonly #imageRenditions: ImageRenditionProvider | undefined;

  /**
   * Creates the shared application boundary used by MCP and HTTP adapters.
   *
   * @param repository - Persistence port for inventory and image metadata.
   * @param options - Injectable IDs, clock, image byte storage, and decoder.
   */
  constructor(
    repository: InventoryRepository,
    options: InventoryApplicationServiceOptions = {},
  ) {
    this.#repository = repository;
    this.#idGenerator = options.idGenerator ?? (() => randomUUID());
    this.#clock = options.clock ?? (() => new Date());
    this.#imageStorage = options.imageStorage;
    this.#imageInspector = options.imageInspector;
    this.#imageRenditions = options.imageRenditions;
  }

  /**
   * Records an explicit product-opening fact and returns its derived state.
   *
   * @param untrustedInput - Input from an adapter; validated again at this boundary.
   * @returns The opened or idempotently already-opened contract result.
   */
  async recordProductOpened(
    untrustedInput: unknown,
  ): Promise<RecordProductOpenedOutput> {
    const input = parseInput(recordProductOpenedInputSchema, untrustedInput);
    const item = await requireInventoryItem(
      this.#repository,
      input.inventory_item_id,
    );
    const transition = openInventoryItem(
      item,
      parseIsoDate(input.opened_on, "opened_on"),
    );

    if (transition.outcome === "opened") {
      await this.#repository.save(transition.item);
    }

    return {
      outcome: transition.outcome,
      ...toInventoryStateOutput(transition.snapshot),
      lifecycle_status: "opened",
      opened_on: transition.snapshot.openedOn,
    };
  }

  /**
   * Reads one item and derives usability using an explicit comparison date.
   *
   * @param untrustedInput - Input from an adapter; validated again at this boundary.
   * @returns The current persisted lifecycle facts and reproducible usability state.
   */
  async getInventoryItem(
    untrustedInput: unknown,
  ): Promise<GetInventoryItemOutput> {
    const input = parseInput(getInventoryItemInputSchema, untrustedInput);
    const item = await requireInventoryItem(
      this.#repository,
      input.inventory_item_id,
    );
    const product =
      item.productId === null
        ? null
        : await this.#repository.findProductById(item.productId);
    return {
      ...toInventoryStateOutput(
        deriveInventorySnapshot(item, parseIsoDate(input.as_of, "as_of")),
      ),
      product_id: item.productId,
      product: product === null ? null : toProductOutput(product),
    };
  }

  /**
   * Lists inventory and derives each item's usability for one explicit date.
   *
   * @param untrustedInput - Input from an adapter; validated again at this boundary.
   * @returns A reproducible read model for every persisted inventory item.
   */
  async listInventory(untrustedInput: unknown): Promise<InventoryListOutput> {
    const input = parseInput(listInventoryInputSchema, untrustedInput);
    const asOf = parseIsoDate(input.as_of, "as_of");
    const items = await this.#repository.findAll();
    const productsById = await loadProducts(this.#repository, items);
    const countsByProductId = countInventoryByProduct(items);
    const positionsByProductId = new Map<string, number>();

    return {
      as_of: asOf,
      items: items.map((item) => {
        if (item.productId === null) {
          return toInventoryListItemOutput(item, asOf, null, null, null);
        }

        const position = (positionsByProductId.get(item.productId) ?? 0) + 1;
        positionsByProductId.set(item.productId, position);
        return toInventoryListItemOutput(
          item,
          asOf,
          productsById.get(item.productId) ?? null,
          position,
          countsByProductId.get(item.productId) ?? 1,
        );
      }),
    };
  }

  /**
   * Searches persisted inventory facts without deriving a date-relative status
   * unless the caller supplies an explicit comparison date.
   *
   * @param untrustedInput - Strict optional query, pagination, and as-of date.
   * @returns One stable inventory-ID-ordered page with compact matching summaries.
   */
  async searchInventory(
    untrustedInput: unknown,
  ): Promise<SearchInventoryOutput> {
    const input = parseInput(searchInventoryInputSchema, untrustedInput);
    const items = await this.#repository.findAll();
    const productsById = await loadProducts(this.#repository, items);
    const normalizedQuery = input.query?.toLowerCase() ?? null;
    const asOf =
      input.as_of === undefined ? null : parseIsoDate(input.as_of, "as_of");
    const matches = items.flatMap((item) => {
      const product =
        item.productId === null
          ? null
          : (productsById.get(item.productId) ?? null);
      if (!inventoryMatchesQuery(item, product, normalizedQuery)) {
        return [];
      }
      return [{ item, product }];
    });
    matches.sort((left, right) =>
      left.item.id < right.item.id
        ? -1
        : left.item.id > right.item.id
          ? 1
          : 0,
    );
    const page = matches.slice(input.offset, input.offset + input.limit);
    const consumedOffset = input.offset + page.length;

    return {
      query: input.query ?? null,
      offset: input.offset,
      limit: input.limit,
      total: matches.length,
      next_offset: consumedOffset < matches.length ? consumedOffset : null,
      items: page.map(({ item, product }) =>
        toInventorySearchItemOutput(item, product, asOf),
      ),
    };
  }

  /**
   * Fetches one complete private inventory read model without applying an
   * implicit current date.
   *
   * @param untrustedInput - Existing inventory identifier and optional as-of date.
   * @returns Complete Product and bottle facts plus optional derived status.
   */
  async fetchInventory(
    untrustedInput: unknown,
  ): Promise<FetchInventoryOutput> {
    const input = parseInput(fetchInventoryInputSchema, untrustedInput);
    const item = await requireInventoryItem(
      this.#repository,
      input.inventory_item_id,
    );
    const product =
      item.productId === null
        ? null
        : await this.#repository.findProductById(item.productId);
    const asOf =
      input.as_of === undefined ? null : parseIsoDate(input.as_of, "as_of");

    return {
      inventory_item: toInventoryReadModelOutput(item, product, asOf),
    };
  }

  /**
   * Creates Products and one InventoryItem per bottle in one repository transaction.
   *
   * @param untrustedInput - Strict batch contract input from any write adapter.
   * @returns Server-generated identifiers and committed facts in input order.
   */
  async createInventoryBatch(
    untrustedInput: unknown,
  ): Promise<CreateInventoryBatchOutput> {
    const input = parseInput(createInventoryBatchInputSchema, untrustedInput);
    ensureUniqueRefs(
      input.products.map((product) => product.batch_ref),
      "product",
    );
    ensureUniqueRefs(
      input.inventory_items.map((item) => item.batch_ref),
      "inventory item",
    );

    const referencedNewProducts = new Set(
      input.inventory_items.flatMap((item) =>
        item.product_ref.kind === "new" ? [item.product_ref.batch_ref] : [],
      ),
    );
    const productInputsByRef = new Map(
      input.products.map((product) => [product.batch_ref, product]),
    );
    for (const product of input.products) {
      if (!referencedNewProducts.has(product.batch_ref)) {
        throw new BeautioError(
          "INVALID_INPUT",
          `new Product ${product.batch_ref} is not referenced by inventory`,
        );
      }
    }
    for (const batchRef of referencedNewProducts) {
      if (!productInputsByRef.has(batchRef)) {
        throw new BeautioError(
          "INVALID_INPUT",
          `inventory references missing Product ${batchRef}`,
        );
      }
    }

    const productIdsByBatchRef = new Map<string, string>();
    const products = input.products.map((productInput) => {
      const productId = this.generateId("product");
      productIdsByBatchRef.set(productInput.batch_ref, productId);
      return createProduct({
        id: productId,
        name: productInput.name,
        alias: productInput.alias ?? null,
        brand: productInput.brand ?? null,
        category: productInput.category ?? null,
        sizeLabel: productInput.size_label ?? null,
        imageAssetId: productInput.image_asset_id ?? null,
        imageRef: null,
        ingredientListText: productInput.ingredient_list_text ?? null,
        sharedNotes: productInput.shared_notes ?? null,
      });
    });

    const existingProductIds = [
      ...new Set(
        input.inventory_items.flatMap((item) =>
          item.product_ref.kind === "existing"
            ? [item.product_ref.product_id]
            : [],
        ),
      ),
    ];
    for (const productId of existingProductIds) {
      if ((await this.#repository.findProductById(productId)) === null) {
        throw new BeautioError(
          "PRODUCT_NOT_FOUND",
          `Product ${productId} does not exist`,
        );
      }
    }

    const now = this.currentTimestamp();
    const inventoryItems = input.inventory_items.map((itemInput) => {
      const productId =
        itemInput.product_ref.kind === "existing"
          ? itemInput.product_ref.product_id
          : productIdsByBatchRef.get(itemInput.product_ref.batch_ref);
      if (productId === undefined) {
        throw new BeautioError(
          "INVALID_INPUT",
          "inventory references a missing batch Product",
        );
      }
      return createInventoryItemFromFacts(
        {
          id: this.generateId("inventory_item"),
          productId,
          createdAt: now,
        },
        {
          lifecycleStatus: itemInput.lifecycle_status,
          openedOn: itemInput.opened_on ?? null,
          openedOnAccuracy: itemInput.opened_on_accuracy ?? null,
          expiresOn: itemInput.expires_on ?? null,
          paoDurationMonths: itemInput.pao_duration_months ?? null,
          customNotes: itemInput.custom_notes ?? null,
        },
      );
    });

    await this.#repository.createBatch({ products, inventoryItems, now });

    const committedProducts = await Promise.all(
      products.map((product) => requireProduct(this.#repository, product.id)),
    );
    const committedItems = await Promise.all(
      inventoryItems.map((item) =>
        requireInventoryItem(this.#repository, item.id),
      ),
    );
    const asOf = parseIsoDate(input.as_of, "as_of");

    return {
      outcome: "created",
      as_of: asOf,
      products: committedProducts.map((product, index) => ({
        batch_ref: requireArrayItem(input.products, index).batch_ref,
        ...toProductOutput(product),
        image_ref: null,
      })),
      inventory_items: committedItems.map((item, index) => ({
        batch_ref: requireArrayItem(input.inventory_items, index).batch_ref,
        product_id: requireProductId(item),
        ...toInventoryStateOutput(deriveInventorySnapshot(item, asOf)),
        lifecycle_status: asActiveLifecycle(item),
      })),
    };
  }

  /**
   * Replaces all editable shared Product facts and transfers image ownership.
   *
   * @param productId - Existing opaque Product identifier.
   * @param untrustedInput - Complete strict Product edit body.
   * @returns Product facts re-read after the atomic update.
   */
  async updateProduct(
    productId: string,
    untrustedInput: unknown,
  ): Promise<UpdateProductOutput> {
    const normalizedProductId = parseInput(productIdSchema, productId);
    const input = parseInput(updateProductInputSchema, untrustedInput);
    const now = this.#clock();
    assertValidClock(now);
    const product = await this.#repository.updateProductFacts({
      productId: normalizedProductId,
      name: input.name,
      ...(input.alias === undefined ? {} : { alias: input.alias }),
      ...(input.brand === undefined ? {} : { brand: input.brand }),
      category: input.category,
      sizeLabel: input.size_label,
      imageAssetId: input.image_asset_id,
      ingredientListText: input.ingredient_list_text,
      sharedNotes: input.shared_notes,
      now: now.toISOString(),
      unlinkedExpiresAt: new Date(
        now.getTime() + TEMPORARY_ASSET_MILLISECONDS,
      ).toISOString(),
    });
    return { product: toProductOutput(product) };
  }

  /**
   * Replaces one Product's shared display image without rewriting its other facts.
   *
   * @param untrustedInput - Existing Product and temporary managed image identifiers.
   * @returns Product facts re-read after the atomic image association update.
   */
  async setProductDisplayImage(
    untrustedInput: unknown,
  ): Promise<SetProductDisplayImageOutput> {
    const input = parseInput(setProductDisplayImageInputSchema, untrustedInput);
    const now = this.#clock();
    assertValidClock(now);
    const product = await this.#repository.setProductDisplayImage({
      productId: input.product_id,
      imageAssetId: input.image_asset_id,
      now: now.toISOString(),
      unlinkedExpiresAt: new Date(
        now.getTime() + TEMPORARY_ASSET_MILLISECONDS,
      ).toISOString(),
    });
    return { product: toProductOutput(product) };
  }

  /**
   * Replaces editable bottle facts and recalculates every derived deadline.
   *
   * @param inventoryItemId - Existing opaque inventory identifier.
   * @param untrustedInput - Complete strict direct-facts edit body.
   * @returns Committed facts and derived state for the explicit as-of date.
   */
  async updateInventoryItemFacts(
    inventoryItemId: string,
    untrustedInput: unknown,
  ): Promise<UpdateInventoryItemFactsOutput> {
    const normalizedInventoryItemId = parseRequiredId(
      inventoryItemId,
      "inventory_item_id",
    );
    const input = parseInput(updateInventoryItemFactsInputSchema, untrustedInput);
    const existing = await requireInventoryItem(
      this.#repository,
      normalizedInventoryItemId,
    );
    if (
      existing.lifecycleStatus === "finished" ||
      existing.lifecycleStatus === "discarded"
    ) {
      throw new BeautioError(
        "INVENTORY_ITEM_TERMINAL",
        `inventory item is ${existing.lifecycleStatus} and cannot be corrected by this operation`,
      );
    }
    const productId = requireProductId(existing);
    validateEditedOpeningAccuracy(existing, input);

    const updated = createInventoryItemFromFacts(
      { id: existing.id, productId, createdAt: existing.createdAt },
      {
        lifecycleStatus: input.lifecycle_status,
        openedOn: input.opened_on,
        openedOnAccuracy: input.opened_on_accuracy,
        expiresOn: input.expires_on,
        paoDurationMonths: input.pao_duration_months,
        customNotes: existing.customNotes,
      },
    );
    const committed = await this.#repository.updateInventoryItemFacts(updated);
    const asOf = parseIsoDate(input.as_of, "as_of");

    return {
      as_of: asOf,
      product_id: productId,
      ...toInventoryStateOutput(deriveInventorySnapshot(committed, asOf)),
      lifecycle_status: asActiveLifecycle(committed),
    };
  }

  /**
   * Replaces only one bottle's custom notes, including for terminal inventory.
   *
   * @param inventoryItemId - Existing opaque inventory identifier.
   * @param untrustedInput - Strict body containing only the nullable notes value.
   * @returns The committed identifier and normalized custom notes.
   */
  async updateInventoryItemCustomNotes(
    inventoryItemId: string,
    untrustedInput: unknown,
  ): Promise<UpdateInventoryItemCustomNotesOutput> {
    const normalizedInventoryItemId = parseRequiredId(
      inventoryItemId,
      "inventory_item_id",
    );
    const input = parseInput(
      updateInventoryItemCustomNotesInputSchema,
      untrustedInput,
    );
    const committed = await this.#repository.updateInventoryItemCustomNotes({
      inventoryItemId: normalizedInventoryItemId,
      customNotes: input.custom_notes,
    });
    return {
      inventory_item: {
        inventory_item_id: committed.id,
        custom_notes: committed.customNotes,
      },
    };
  }

  /**
   * Validates and stores one confirmed group of Product display images.
   *
   * Metadata is staged before byte writes, so a failed compensation remains
   * discoverable by the normal pending-cleanup scanner.
   *
   * @param untrustedImages - Adapter-neutral source references and complete bytes.
   * @param options - Optional adapter deadline signal for bounded HTTP uploads.
   * @returns Stable asset identifiers in input order after all files are active.
   */
  async uploadProductImages(
    untrustedImages: readonly ImageUploadInput[] | unknown,
    options: ImageUploadOperationOptions = {},
  ): Promise<UploadProductImagesOutput> {
    assertUploadNotAborted(options.signal);
    const images = parseImageUploads(untrustedImages);
    const { storage, inspector } = this.requireImageCapabilities();
    const inspections: ImageInspection[] = [];
    let totalBytes = 0;

    for (const image of images) {
      totalBytes += image.bytes.byteLength;
      if (image.bytes.byteLength === 0) {
        throw new BeautioError(
          "UNSUPPORTED_MEDIA_TYPE",
          "image content cannot be empty",
        );
      }
      if (image.bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new BeautioError(
          "UPLOAD_TOO_LARGE",
          "an image exceeds the 20 MiB limit",
        );
      }
      if (totalBytes > MAX_UPLOAD_BYTES) {
        throw new BeautioError(
          "UPLOAD_TOO_LARGE",
          "the upload exceeds the 50 MiB total limit",
        );
      }

      let inspection;
      try {
        inspection = await abortableInspection(
          inspector.inspect(image.bytes),
          options.signal,
        );
      } catch (error) {
        if (error instanceof BeautioError) {
          throw error;
        }
        throw new BeautioError(
          "UNSUPPORTED_MEDIA_TYPE",
          "image content could not be decoded",
        );
      }
      if (
        !imageMediaTypes.includes(inspection.mediaType) ||
        inspection.animated
      ) {
        throw new BeautioError(
          "UNSUPPORTED_MEDIA_TYPE",
          "only JPEG, PNG, and static WebP images are supported",
        );
      }
      if (
        !Number.isInteger(inspection.width) ||
        !Number.isInteger(inspection.height) ||
        inspection.width < 1 ||
        inspection.height < 1
      ) {
        throw new BeautioError(
          "UNSUPPORTED_MEDIA_TYPE",
          "image dimensions could not be decoded",
        );
      }
      if (inspection.width * inspection.height > MAX_IMAGE_PIXELS) {
        throw new BeautioError(
          "UPLOAD_TOO_LARGE",
          "an image exceeds the 40 megapixel limit",
        );
      }
      inspections.push(inspection);
      assertUploadNotAborted(options.signal);
    }

    const now = this.#clock();
    assertValidClock(now);
    const createdAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + TEMPORARY_ASSET_MILLISECONDS,
    ).toISOString();
    const assets = images.map((image, index): ImageAsset => ({
      id: this.generateId("image_asset"),
      storageKey: this.generateId("storage_key"),
      mediaType: requireArrayItem(inspections, index).mediaType,
      byteSize: image.bytes.byteLength,
      status: "staging",
      productId: null,
      expiresAt,
      createdAt,
    }));

    try {
      await this.#repository.stageImageAssets(assets);
    } catch (error) {
      if (error instanceof BeautioError) {
        throw error;
      }
      throw new BeautioError("UPLOAD_FAILED", "image upload could not be staged");
    }
    try {
      assertUploadNotAborted(options.signal);
      for (const [index, asset] of assets.entries()) {
        await storage.put(
          asset.storageKey,
          requireArrayItem(images, index).bytes,
          options.signal,
        );
        assertUploadNotAborted(options.signal);
      }
      assertUploadNotAborted(options.signal);
      await this.#repository.activateStagedImageAssets(
        assets.map((asset) => asset.id),
      );
      assertUploadNotAborted(options.signal);
    } catch (error) {
      await this.compensateFailedUpload(assets, storage);
      if (error instanceof BeautioError) {
        throw error;
      }
      throw new BeautioError("UPLOAD_FAILED", "image upload failed");
    }

    return {
      assets: assets.map((asset, index) => ({
        source_ref: requireArrayItem(images, index).source_ref,
        image_asset_id: asset.id,
        media_type: asset.mediaType,
        byte_size: asset.byteSize,
        expires_at: asset.expiresAt,
      })),
    };
  }

  /**
   * Reads bytes only for a visible, non-expired managed image asset.
   *
   * @param imageAssetId - Opaque identifier supplied by an authenticated adapter.
   * @param variant - Original evidence bytes or the optional card rendition.
   * @returns Media metadata and bytes without exposing the storage key.
   */
  async readImageAsset(
    imageAssetId: string,
    variant: ImageAssetReadVariant = "original",
  ): Promise<ReadImageAssetOutput> {
    const normalizedId = parseRequiredId(imageAssetId, "image_asset_id");
    const asset = await this.#repository.findImageAssetById(normalizedId);
    if (asset === null || asset.status === "staging") {
      throw new BeautioError(
        "IMAGE_ASSET_NOT_FOUND",
        `image asset ${normalizedId} does not exist`,
      );
    }
    if (
      asset.status === "pending_cleanup" ||
      (asset.status === "temporary" && asset.expiresAt <= this.currentTimestamp())
    ) {
      throw new BeautioError(
        "IMAGE_ASSET_EXPIRED",
        `image asset ${normalizedId} is expired`,
      );
    }
    const storage = this.requireImageCapabilities().storage;
    let originalRead: Promise<Uint8Array> | null = null;
    const loadOriginal = (): Promise<Uint8Array> => {
      if (originalRead === null) {
        originalRead = storage.get(asset.storageKey).catch(() => {
          throw new BeautioError(
            "INTERNAL_ERROR",
            "image content is unavailable",
          );
        });
      }
      return originalRead;
    };

    if (
      variant === "card" &&
      asset.status === "linked" &&
      this.#imageRenditions !== undefined
    ) {
      try {
        const rendition = await this.#imageRenditions.readOrCreateCard(
          asset.storageKey,
          loadOriginal,
        );
        if (rendition !== null) {
          return {
            image_asset_id: asset.id,
            media_type: rendition.mediaType,
            byte_size: rendition.bytes.byteLength,
            bytes: rendition.bytes,
          };
        }
      } catch {
        // A derivative is optional presentation data. The verified original is
        // authoritative and remains available when generation or caching fails.
      }
    }

    const originalBytes = await loadOriginal();

    return {
      image_asset_id: asset.id,
      media_type: asset.mediaType,
      byte_size: asset.byteSize,
      bytes: originalBytes,
    };
  }

  /**
   * Prepares a bounded-memory export of the complete single-user inventory.
   *
   * The returned writer serializes one original image at a time and respects
   * destination backpressure. The public JSON backup contract remains version 1.
   *
   * @param options - Optional cancellation covering snapshot validation and writing.
   * @returns Metadata and a one-shot-compatible streaming writer for the backup.
   */
  async prepareBackupExport(
    options: BackupOperationOptions = {},
  ): Promise<BackupExportPlan> {
    assertBackupNotAborted(options.signal);
    const { storage } = this.requireImageCapabilities();
    const repository = this.requireBackupRepository();
    const snapshot = await repository.readBackupSnapshot();
    assertBackupNotAborted(options.signal);
    const createdAt = this.currentTimestamp();

    if (
      snapshot.products.length > 10_000 ||
      snapshot.inventoryItems.length > 50_000 ||
      snapshot.imageAssets.length > 1_000
    ) {
      throw backupSnapshotOutsideContract();
    }

    let declaredImageBytes = 0;
    for (const asset of snapshot.imageAssets) {
      assertBackupNotAborted(options.signal);
      if (asset.status !== "linked" || asset.productId === null) {
        throw new BeautioError(
          "INTERNAL_ERROR",
          "backup snapshot contains a non-linked image",
        );
      }
      declaredImageBytes += asset.byteSize;
      if (
        asset.byteSize > MAX_IMAGE_BYTES ||
        declaredImageBytes > MAX_BACKUP_TOTAL_IMAGE_BYTES
      ) {
        throw new BeautioError(
          "UPLOAD_TOO_LARGE",
          "backup images exceed the 200 MiB total limit",
        );
      }
    }

    const prefix = `{"format":"beautio-backup","version":1,"created_at":${JSON.stringify(createdAt)},"products":[`;
    const inventoryPrefix = `],"inventory_items":[`;
    const imagesPrefix = `],"images":[`;
    const suffix = "]}";
    let declaredSerializedBytes =
      Buffer.byteLength(prefix) +
      Buffer.byteLength(inventoryPrefix) +
      Buffer.byteLength(imagesPrefix) +
      Buffer.byteLength(suffix);

    for (const [index, product] of snapshot.products.entries()) {
      assertBackupNotAborted(options.signal);
      const backupProduct = toBackupProduct(product);
      if (!beautioBackupProductSchema.safeParse(backupProduct).success) {
        throw backupSnapshotOutsideContract();
      }
      declaredSerializedBytes +=
        Buffer.byteLength(JSON.stringify(backupProduct)) +
        (index === 0 ? 0 : 1);
    }
    for (const [index, item] of snapshot.inventoryItems.entries()) {
      assertBackupNotAborted(options.signal);
      const backupItem = toBackupInventoryItem(item);
      if (!beautioBackupInventoryItemSchema.safeParse(backupItem).success) {
        throw backupSnapshotOutsideContract();
      }
      declaredSerializedBytes +=
        Buffer.byteLength(JSON.stringify(backupItem)) +
        (index === 0 ? 0 : 1);
    }
    for (const [index, asset] of snapshot.imageAssets.entries()) {
      assertBackupNotAborted(options.signal);
      if (
        !beautioBackupImageSchema.safeParse({
          image_asset_id: asset.id,
          product_id: asset.productId,
          media_type: asset.mediaType,
          byte_size: asset.byteSize,
          sha256: "0".repeat(64),
          bytes_base64: "AAAA",
          created_at: asset.createdAt,
        }).success
      ) {
        throw backupSnapshotOutsideContract();
      }
      const imageWithoutBytes = JSON.stringify({
        image_asset_id: asset.id,
        product_id: asset.productId,
        media_type: asset.mediaType,
        byte_size: asset.byteSize,
        sha256: "0".repeat(64),
        bytes_base64: "",
        created_at: asset.createdAt,
      });
      declaredSerializedBytes +=
        Buffer.byteLength(imageWithoutBytes) +
        4 * Math.ceil(asset.byteSize / 3) +
        (index === 0 ? 0 : 1);
    }
    if (declaredSerializedBytes > MAX_BACKUP_SERIALIZED_BYTES) {
      throw new BeautioError(
        "UPLOAD_TOO_LARGE",
        "serialized backup exceeds the 280 MiB response limit",
      );
    }

    return {
      createdAt,
      products: snapshot.products.length,
      inventoryItems: snapshot.inventoryItems.length,
      images: snapshot.imageAssets.length,
      writeTo: async (write, writeOptions = {}) => {
        const signal = writeOptions.signal ?? options.signal;
        assertBackupNotAborted(signal);
        await write(prefix);
        for (const [index, product] of snapshot.products.entries()) {
          assertBackupNotAborted(signal);
          await write(
            `${index === 0 ? "" : ","}${JSON.stringify(toBackupProduct(product))}`,
          );
        }
        assertBackupNotAborted(signal);
        await write(inventoryPrefix);
        for (const [index, item] of snapshot.inventoryItems.entries()) {
          assertBackupNotAborted(signal);
          await write(
            `${index === 0 ? "" : ","}${JSON.stringify(toBackupInventoryItem(item))}`,
          );
        }
        assertBackupNotAborted(signal);
        await write(imagesPrefix);

        let totalImageBytes = 0;
        for (const [index, asset] of snapshot.imageAssets.entries()) {
          assertBackupNotAborted(signal);
          let bytes: Uint8Array;
          try {
            bytes = await storage.get(asset.storageKey, signal);
          } catch {
            assertBackupNotAborted(signal);
            throw new BeautioError(
              "INTERNAL_ERROR",
              "an original product image is unavailable",
            );
          }
          if (bytes.byteLength !== asset.byteSize) {
            throw new BeautioError(
              "INTERNAL_ERROR",
              "an original product image size does not match its metadata",
            );
          }
          totalImageBytes += bytes.byteLength;
          if (totalImageBytes > MAX_BACKUP_TOTAL_IMAGE_BYTES) {
            throw new BeautioError(
              "UPLOAD_TOO_LARGE",
              "backup images exceed the 200 MiB total limit",
            );
          }
          const image = {
            image_asset_id: asset.id,
            product_id: asset.productId,
            media_type: asset.mediaType,
            byte_size: bytes.byteLength,
            sha256: sha256(bytes),
            bytes_base64: Buffer.from(
              bytes.buffer,
              bytes.byteOffset,
              bytes.byteLength,
            ).toString("base64"),
            created_at: asset.createdAt,
          };
          assertBackupNotAborted(signal);
          await write(`${index === 0 ? "" : ","}${JSON.stringify(image)}`);
        }
        assertBackupNotAborted(signal);
        await write(suffix);
      },
    };
  }

  /**
   * Validates and atomically restores one complete single-user backup.
   *
   * Image files are written under fresh internal keys before the database swap.
   * Failed validation or persistence leaves the existing logical dataset unchanged.
   *
   * @param untrustedInput - Parsed JSON supplied through the authenticated Admin route.
   * @param options - Optional cancellation for the bounded backup operation.
   * @returns Counts from the committed replacement.
   */
  async restoreBackup(
    untrustedInput: unknown,
    options: BackupOperationOptions = {},
  ): Promise<RestoreBeautioBackupOutput> {
    assertBackupNotAborted(options.signal);
    const backup = parseBackupWithoutCloningPayload(untrustedInput);
    const { storage, inspector } = this.requireImageCapabilities();
    const productIds = uniqueIds(
      backup.products.map((product) => product.product_id),
      "product",
    );
    uniqueIds(
      backup.inventory_items.map((item) => item.inventory_item_id),
      "inventory item",
    );
    const imageIds = uniqueIds(
      backup.images.map((image) => image.image_asset_id),
      "image asset",
    );
    const imagesById = new Map(
      backup.images.map((image) => [image.image_asset_id, image]),
    );
    const products = backup.products.map((product) => {
      if (
        product.image_asset_id !== null &&
        !imageIds.has(product.image_asset_id)
      ) {
        throw new BeautioError(
          "INVALID_INPUT",
          `Product ${product.product_id} references a missing backup image`,
        );
      }
      const image =
        product.image_asset_id === null
          ? null
          : (imagesById.get(product.image_asset_id) ?? null);
      if (image !== null && image.product_id !== product.product_id) {
        throw new BeautioError(
          "INVALID_INPUT",
          `Product ${product.product_id} has an inconsistent backup image`,
        );
      }
      return createProduct({
        id: product.product_id,
        name: product.name,
        alias: product.alias,
        brand: product.brand,
        category: product.category,
        sizeLabel: product.size_label,
        imageAssetId: product.image_asset_id,
        imageRef: product.image_ref,
        ingredientListText: product.ingredient_list_text,
        sharedNotes: product.shared_notes,
      });
    });
    const productImageIds = new Set(
      products.flatMap((product) =>
        product.imageAssetId === null ? [] : [product.imageAssetId],
      ),
    );
    if (productImageIds.size !== imageIds.size) {
      throw new BeautioError(
        "INVALID_INPUT",
        "backup contains an image that is not owned by exactly one Product",
      );
    }
    const inventoryItems = backup.inventory_items.map((item) => {
      if (item.product_id !== null && !productIds.has(item.product_id)) {
        throw new BeautioError(
          "INVALID_INPUT",
          `inventory item ${item.inventory_item_id} references a missing Product`,
        );
      }
      return createInventoryItem({
        id: item.inventory_item_id,
        productId: item.product_id,
        createdAt: item.created_at,
        lifecycleStatus: item.lifecycle_status,
        openedOn: item.opened_on,
        openedOnAccuracy: item.opened_on_accuracy,
        expiresOn: item.expires_on,
        paoDurationMonths: item.pao_duration_months,
        paoDeadline: item.pao_deadline,
        usableUntil: item.usable_until,
        customNotes: item.custom_notes,
      });
    });

    let declaredImageBytes = 0;
    for (const image of backup.images) {
      declaredImageBytes += image.byte_size;
      if (declaredImageBytes > MAX_BACKUP_TOTAL_IMAGE_BYTES) {
        throw new BeautioError(
          "UPLOAD_TOO_LARGE",
          "backup images exceed the 200 MiB total limit",
        );
      }
    }

    const reservedIds = new Set(imageIds);
    const restoreStartedAt = this.#clock();
    assertValidClock(restoreStartedAt);
    const restoreStagingExpiresAt = new Date(
      restoreStartedAt.getTime() + TEMPORARY_ASSET_MILLISECONDS,
    ).toISOString();
    const stagedImages = backup.images.map((image) => {
      const stagingImageAssetId = this.generateUnusedId(
        "image_asset",
        reservedIds,
      );
      const imageAsset: ImageAsset = {
        id: stagingImageAssetId,
        storageKey: this.generateId("storage_key"),
        mediaType: image.media_type,
        byteSize: image.byte_size,
        status: "staging",
        productId: null,
        expiresAt: restoreStagingExpiresAt,
        createdAt: image.created_at,
      };
      return {
        image,
        stagingImageAssetId,
        imageAsset,
      };
    });

    const repository = this.requireBackupRepository();
    await repository.stageImageAssets(
      stagedImages.map((entry) => entry.imageAsset),
    );
    let replacementCommitted = false;
    try {
      for (const entry of stagedImages) {
        assertBackupNotAborted(options.signal);
        const bytes = Buffer.from(entry.image.bytes_base64, "base64");
        if (
          bytes.byteLength !== entry.image.byte_size ||
          sha256(bytes) !== entry.image.sha256
        ) {
          throw new BeautioError(
            "INVALID_INPUT",
            `backup image ${entry.image.image_asset_id} failed integrity validation`,
          );
        }
        let inspection: ImageInspection;
        try {
          inspection = await abortableInspection(
            inspector.inspect(bytes),
            options.signal,
          );
        } catch (error) {
          if (options.signal?.aborted === true) {
            assertBackupNotAborted(options.signal);
          }
          if (error instanceof BeautioError) {
            throw error;
          }
          throw new BeautioError(
            "UNSUPPORTED_MEDIA_TYPE",
            `backup image ${entry.image.image_asset_id} could not be decoded`,
          );
        }
        assertBackupNotAborted(options.signal);
        if (
          inspection.mediaType !== entry.image.media_type ||
          inspection.animated ||
          inspection.width * inspection.height > MAX_IMAGE_PIXELS
        ) {
          throw new BeautioError(
            "UNSUPPORTED_MEDIA_TYPE",
            `backup image ${entry.image.image_asset_id} is not a supported original`,
          );
        }
        await storage.put(entry.imageAsset.storageKey, bytes, options.signal);
      }
      assertBackupNotAborted(options.signal);
      const displacedAssets = await repository.replaceFromBackup({
        products,
        inventoryItems,
        imageAssets: stagedImages.map((entry) => ({
          stagingImageAssetId: entry.stagingImageAssetId,
          imageAsset: {
            ...entry.imageAsset,
            id: entry.image.image_asset_id,
            status: "linked",
            productId: entry.image.product_id,
          },
        })),
      });
      replacementCommitted = true;
      await this.cleanupClaimedAssets(displacedAssets, storage);
    } catch (error) {
      if (!replacementCommitted) {
        await this.compensateFailedUpload(
          stagedImages.map((entry) => entry.imageAsset),
          storage,
        );
      }
      throw error;
    }

    return {
      restored: true,
      products: products.length,
      inventory_items: inventoryItems.length,
      images: stagedImages.length,
    };
  }

  /**
   * Claims expired temporary assets and retries all pending file deletions.
   *
   * @returns Counts for claimed work, successful deletions, and retained retries.
   */
  async cleanupExpiredImageAssets(): Promise<CleanupImageAssetsOutput> {
    const storage = this.requireImageCapabilities().storage;
    const assets = await this.#repository.claimExpiredImageAssets(
      this.currentTimestamp(),
    );
    let deleted = 0;
    let failed = 0;
    for (const asset of assets) {
      try {
        await this.#imageRenditions?.deleteForAsset(asset.storageKey);
        await storage.delete(asset.storageKey);
        await this.#repository.deleteClaimedImageAsset(asset.id);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
    return { claimed: assets.length, deleted, failed };
  }

  private async compensateFailedUpload(
    assets: readonly ImageAsset[],
    storage: ImageAssetStorage,
  ): Promise<void> {
    try {
      await this.#repository.markImageAssetsForCleanup(
        assets.map((asset) => asset.id),
      );
    } catch {
      return;
    }
    for (const asset of assets) {
      try {
        await this.#imageRenditions?.deleteForAsset(asset.storageKey);
        await storage.delete(asset.storageKey);
        await this.#repository.deleteClaimedImageAsset(asset.id);
      } catch {
        // Pending metadata deliberately remains for the automatic retry scanner.
      }
    }
  }

  private async cleanupClaimedAssets(
    assets: readonly ImageAsset[],
    storage: ImageAssetStorage,
  ): Promise<void> {
    for (const asset of assets) {
      try {
        await this.#imageRenditions?.deleteForAsset(asset.storageKey);
        await storage.delete(asset.storageKey);
        await this.#repository.deleteClaimedImageAsset(asset.id);
      } catch {
        // Pending metadata remains visible to the ordinary cleanup retry scan.
      }
    }
  }

  private generateId(kind: GeneratedIdKind): string {
    const id = this.#idGenerator(kind).trim();
    if (id.length === 0) {
      throw new BeautioError("INTERNAL_ERROR", "ID generation failed");
    }
    return id;
  }

  private generateUnusedId(
    kind: GeneratedIdKind,
    reservedIds: Set<string>,
  ): string {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const id = this.generateId(kind);
      if (!reservedIds.has(id)) {
        reservedIds.add(id);
        return id;
      }
    }
    throw new BeautioError(
      "INTERNAL_ERROR",
      "ID generation repeatedly returned reserved backup identifiers",
    );
  }

  private currentTimestamp(): string {
    const now = this.#clock();
    assertValidClock(now);
    return now.toISOString();
  }

  private requireImageCapabilities(): {
    readonly storage: ImageAssetStorage;
    readonly inspector: ImageInspector;
  } {
    if (this.#imageStorage === undefined || this.#imageInspector === undefined) {
      throw new BeautioError(
        "INTERNAL_ERROR",
        "image capabilities are not configured",
      );
    }
    return { storage: this.#imageStorage, inspector: this.#imageInspector };
  }

  private requireBackupRepository(): BackupInventoryRepository {
    if (!isBackupRepository(this.#repository)) {
      throw new BeautioError(
        "INTERNAL_ERROR",
        "backup persistence is not configured",
      );
    }
    return this.#repository;
  }
}

function toBackupProduct(product: Product) {
  return {
    product_id: product.id,
    name: product.name,
    alias: product.alias,
    brand: product.brand,
    category: product.category,
    size_label: product.sizeLabel,
    image_asset_id: product.imageAssetId,
    image_ref: product.imageRef,
    ingredient_list_text: product.ingredientListText,
    shared_notes: product.sharedNotes,
  };
}

function toBackupInventoryItem(item: InventoryItem) {
  return {
    inventory_item_id: item.id,
    product_id: item.productId,
    created_at: item.createdAt,
    lifecycle_status: item.lifecycleStatus,
    opened_on: item.openedOn,
    opened_on_accuracy: item.openedOnAccuracy,
    expires_on: item.expiresOn,
    pao_duration_months: item.paoDurationMonths,
    pao_deadline: item.paoDeadline,
    usable_until: item.usableUntil,
    custom_notes: item.customNotes,
  };
}

function backupSnapshotOutsideContract(): BeautioError {
  return new BeautioError(
    "INTERNAL_ERROR",
    "backup snapshot exceeds the version 1 contract",
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function uniqueIds(values: readonly string[], kind: string): ReadonlySet<string> {
  const ids = new Set(values);
  if (ids.size !== values.length) {
    throw new BeautioError("INVALID_INPUT", `backup contains duplicate ${kind} IDs`);
  }
  return ids;
}

function isBackupRepository(
  repository: InventoryRepository,
): repository is BackupInventoryRepository {
  const candidate = repository as Partial<BackupInventoryRepository>;
  return (
    typeof candidate.readBackupSnapshot === "function" &&
    typeof candidate.replaceFromBackup === "function"
  );
}

function parseBackupWithoutCloningPayload(value: unknown): BeautioBackup {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "format",
      "version",
      "created_at",
      "products",
      "inventory_items",
      "images",
    ]) ||
    value.format !== "beautio-backup" ||
    value.version !== 1 ||
    !isBackupInstant(value.created_at) ||
    !Array.isArray(value.products) ||
    value.products.length > 10_000 ||
    !Array.isArray(value.inventory_items) ||
    value.inventory_items.length > 50_000 ||
    !Array.isArray(value.images) ||
    value.images.length > 1_000
  ) {
    throw invalidBackup();
  }

  const products = value.products.map((product) => {
    const parsed = beautioBackupProductSchema.safeParse(product);
    if (!parsed.success) throw invalidBackup();
    return parsed.data;
  });
  const inventoryItems = value.inventory_items.map((item) => {
    const parsed = beautioBackupInventoryItemSchema.safeParse(item);
    if (!parsed.success) throw invalidBackup();
    return parsed.data;
  });
  const images = value.images.map((image) => {
    const parsed = beautioBackupImageSchema.safeParse(image);
    if (!parsed.success) throw invalidBackup();
    return parsed.data;
  });
  return {
    format: "beautio-backup",
    version: 1,
    created_at: value.created_at,
    products,
    inventory_items: inventoryItems,
    images,
  };
}

function isBackupInstant(value: unknown): value is string {
  return beautioBackupImageSchema.safeParse({
    image_asset_id: "validation-image",
    product_id: "validation-product",
    media_type: "image/png",
    byte_size: 1,
    sha256: "0".repeat(64),
    bytes_base64: "AA==",
    created_at: value,
  }).success;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function invalidBackup(): BeautioError {
  return new BeautioError(
    "INVALID_INPUT",
    "backup file is invalid or unsupported",
  );
}

function assertBackupNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new BeautioError("UPLOAD_FAILED", "backup operation was aborted");
  }
}

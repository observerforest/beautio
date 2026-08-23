import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BeautioError } from "@beautio/domain";
import sharp from "sharp";
import {
  type CardImageRendition,
  createCardImageRendition,
  FileImageAssetStorage,
  FileImageRenditionProvider,
  inspectManagedImage,
} from "../src/index.ts";

const TEST_STORAGE_KEY = "asset-key_1";
const TEST_CARD_FILENAME =
  "bcd1b3fa4f6c1caf3cd4d61dd909df379f22f2970cd8bc3753a55bad9e77d0b1.webp";

test("inspector fully decodes JPEG, PNG, and static WebP", async () => {
  for (const format of ["jpeg", "png", "webp"] as const) {
    const bytes = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: "#d7a9b9",
      },
    })
      [format]()
      .toBuffer();

    assert.deepEqual(await inspectManagedImage(bytes), {
      mediaType: `image/${format}`,
      width: 8,
      height: 6,
      animated: false,
    });
  }
});

test("inspector rejects unsupported and malformed content", async () => {
  const gif = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: "#d7a9b9",
    },
  })
    .gif()
    .toBuffer();
  for (const bytes of [
    new TextEncoder().encode("<svg></svg>"),
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    gif,
  ]) {
    await assert.rejects(
      inspectManagedImage(bytes),
      hasCode("UNSUPPORTED_MEDIA_TYPE"),
    );
  }
});

test("inspector rejects animated WebP", async () => {
  const first = await solidPng("#d7a9b9");
  const second = await solidPng("#3a8f7b");
  const animated = await sharp([first, second], {
    join: { animated: true },
  })
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();

  await assert.rejects(
    inspectManagedImage(animated),
    hasCode("UNSUPPORTED_MEDIA_TYPE"),
  );
});

test("inspector rejects decoded dimensions above 40 megapixels", async () => {
  const tooManyPixels = await sharp({
    create: {
      width: 10_000,
      height: 4_001,
      channels: 3,
      background: "#ffffff",
    },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

  await assert.rejects(
    inspectManagedImage(tooManyPixels),
    hasCode("UPLOAD_TOO_LARGE"),
  );
});

test("card rendition safely crops near-white side margins without cutting a bottom-aligned subject", async () => {
  const source = await productImage({
    background: "#f8f8f8",
    subject: { left: 140, top: 30, width: 120, height: 270 },
  });
  const originalSnapshot = Buffer.from(source);

  const result = await createCardImageRendition(source);
  const repeated = await createCardImageRendition(source);

  assert.equal(result.outcome, "rendered");
  assert.equal(result.mediaType, "image/webp");
  assert.equal(result.fallbackReason, null);
  assert.ok(result.crop.left < 140);
  assert.ok(result.crop.top < 30);
  assert.ok(result.crop.left + result.crop.width > 260);
  assert.equal(result.crop.top + result.crop.height, 300);
  assert.ok(result.width < result.height);
  assert.ok(result.width <= 960);
  assert.ok(result.height <= 960);
  assert.deepEqual(source, originalSnapshot);

  const metadata = await sharp(result.bytes).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, result.width);
  assert.equal(metadata.height, result.height);
  assert.equal(repeated.outcome, "rendered");
  assert.deepEqual(repeated.bytes, result.bytes);
});

test("card rendition recognises transparent outer background", async () => {
  const source = await productImage({
    background: { r: 0, g: 0, b: 0, alpha: 0 },
    subject: { left: 125, top: 40, width: 150, height: 220 },
  });

  const result = await createCardImageRendition(source);

  assert.equal(result.outcome, "rendered");
  assert.equal(result.mediaType, "image/webp");
  assert.ok(result.crop.left < 125);
  assert.ok(result.crop.top < 40);
  assert.ok(result.crop.left + result.crop.width > 275);
  assert.ok(result.crop.top + result.crop.height > 260);
});

test("card rendition bounds large outputs while preserving the cropped aspect ratio", async () => {
  const source = await productImage({
    canvas: { width: 1_600, height: 1_200 },
    background: "#ffffff",
    subject: { left: 560, top: 120, width: 480, height: 1_080 },
  });

  const result = await createCardImageRendition(source);

  assert.equal(result.outcome, "rendered");
  assert.equal(Math.max(result.width, result.height), 960);
  assert.ok(
    Math.abs(
      result.width / result.height - result.crop.width / result.crop.height,
    ) < 0.01,
  );
});

test("card rendition maps crop coordinates in the EXIF-oriented coordinate space", async () => {
  const uprightPixels = await productImage({
    background: "#ffffff",
    subject: { left: 140, top: 30, width: 120, height: 270 },
  });
  const source = await sharp(uprightPixels)
    .jpeg({ quality: 100 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const sourceMetadata = await sharp(source).metadata();
  assert.equal(sourceMetadata.orientation, 6);
  assert.deepEqual(sourceMetadata.autoOrient, { width: 300, height: 400 });

  const result = await createCardImageRendition(source);

  assert.equal(result.outcome, "rendered");
  assert.equal(result.crop.left, 0);
  assert.ok(result.crop.top < 140);
  assert.ok(result.crop.left + result.crop.width > 270);
  assert.ok(result.crop.top + result.crop.height > 260);
  assert.ok(result.crop.left + result.crop.width <= 300);
  assert.ok(result.crop.top + result.crop.height <= 400);
  assert.equal(result.width, result.crop.width);
  assert.equal(result.height, result.crop.height);
});

test("card rendition returns unchanged source when a white product cannot be separated safely", async () => {
  const label = await solidImage(20, 10, "#553024");
  const source = await sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([{ input: label, left: 190, top: 145 }])
    .png()
    .toBuffer();

  const result = await createCardImageRendition(source);

  assert.equal(result.outcome, "unchanged");
  assert.equal(result.fallbackReason, "subject-too-small");
  assert.equal(result.mediaType, "image/png");
  assert.equal(result.width, 400);
  assert.equal(result.height, 300);
  assert.deepEqual(Buffer.from(result.bytes), source);
  assert.notEqual(result.bytes, source);
  const originalFirstByte = source[0];
  result.bytes[0] = (result.bytes[0] ?? 0) ^ 0xff;
  assert.equal(source[0], originalFirstByte);
});

test("card rendition rejects a crop that could isolate only a dark label on a white product", async () => {
  const label = await solidImage(140, 80, "#553024");
  const source = await sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([{ input: label, left: 130, top: 110 }])
    .png()
    .toBuffer();

  const result = await createCardImageRendition(source);

  assert.equal(result.outcome, "unchanged");
  assert.equal(result.fallbackReason, "crop-too-aggressive");
  assert.deepEqual(Buffer.from(result.bytes), source);
});

test("card rendition returns unchanged source when the image edges are not background", async () => {
  const source = await solidImage(400, 300, "#784432");

  const result = await createCardImageRendition(source);

  assert.equal(result.outcome, "unchanged");
  assert.equal(result.fallbackReason, "background-not-confident");
  assert.deepEqual(Buffer.from(result.bytes), source);
});

test("file rendition provider caches under the deterministic private card-v1 path", async (context) => {
  const directory = await temporaryDirectory(context);
  const cardBytes = await solidWebp("#5b2b1f");
  let renderCalls = 0;
  let loaderCalls = 0;
  const provider = new FileImageRenditionProvider(directory, async () => {
    renderCalls += 1;
    return renderedCard(cardBytes);
  });

  const created = await provider.readOrCreateCard(
    TEST_STORAGE_KEY,
    async () => {
      loaderCalls += 1;
      return Uint8Array.from([1]);
    },
  );
  const cached = await provider.readOrCreateCard(
    TEST_STORAGE_KEY,
    async () => {
      loaderCalls += 1;
      return Uint8Array.from([2]);
    },
  );

  assert.equal(renderCalls, 1);
  assert.equal(loaderCalls, 1);
  assert.deepEqual(created, cached);
  assert.deepEqual(
    await readdir(join(directory, ".renditions", "card-v1")),
    [TEST_CARD_FILENAME],
  );
  const file = await stat(cardSidecarPath(directory));
  assert.equal(file.mode & 0o777, 0o600);
});

test("file rendition provider merges concurrent generation for the same key", async (context) => {
  const directory = await temporaryDirectory(context);
  const cardBytes = await solidWebp("#3a8f7b");
  let renderCalls = 0;
  let announceStarted!: () => void;
  let releaseRender!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseRender = resolve;
  });
  const provider = new FileImageRenditionProvider(directory, async () => {
    renderCalls += 1;
    announceStarted();
    await release;
    return renderedCard(cardBytes);
  });

  const first = provider.readOrCreateCard(
    TEST_STORAGE_KEY,
    async () => Uint8Array.from([1]),
  );
  const second = provider.readOrCreateCard(
    TEST_STORAGE_KEY,
    async () => Uint8Array.from([1]),
  );
  await started;
  assert.equal(renderCalls, 1);
  releaseRender();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, secondResult);
  assert.notEqual(firstResult?.bytes, secondResult?.bytes);
});

test("file rendition provider negatively caches a conservative decline", async (context) => {
  const directory = await temporaryDirectory(context);
  let renderCalls = 0;
  let loaderCalls = 0;
  const source = await solidImage(400, 300, "#784432");
  const provider = new FileImageRenditionProvider(directory, async (bytes) => {
    renderCalls += 1;
    return createCardImageRendition(bytes);
  });

  assert.equal(
    await provider.readOrCreateCard(TEST_STORAGE_KEY, async () => {
      loaderCalls += 1;
      return source;
    }),
    null,
  );
  assert.equal(
    await provider.readOrCreateCard(TEST_STORAGE_KEY, async () => {
      loaderCalls += 1;
      return source;
    }),
    null,
  );
  assert.equal(renderCalls, 1);
  assert.equal(loaderCalls, 1);
  await assert.rejects(access(cardSidecarPath(directory)));
  const marker = await stat(cardNegativePath(directory));
  assert.equal(marker.size, 0);
  assert.equal(marker.mode & 0o777, 0o600);
  await provider.deleteForAsset(TEST_STORAGE_KEY);
  await assert.rejects(access(cardNegativePath(directory)));
});

test("file rendition provider serializes rendering across different keys", async (context) => {
  const directory = await temporaryDirectory(context);
  const cardBytes = await solidWebp("#5b2b1f");
  let activeRenders = 0;
  let maximumActiveRenders = 0;
  let secondLoaderCalls = 0;
  let announceFirstStarted!: () => void;
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    announceFirstStarted = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const provider = new FileImageRenditionProvider(directory, async (bytes) => {
    activeRenders += 1;
    maximumActiveRenders = Math.max(maximumActiveRenders, activeRenders);
    if (bytes[0] === 1) {
      announceFirstStarted();
      await firstRelease;
    }
    activeRenders -= 1;
    return renderedCard(cardBytes);
  });

  const first = provider.readOrCreateCard("asset-one", async () =>
    Uint8Array.from([1]),
  );
  await firstStarted;
  const second = provider.readOrCreateCard("asset-two", async () => {
    secondLoaderCalls += 1;
    return Uint8Array.from([2]);
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(activeRenders, 1);
  assert.equal(secondLoaderCalls, 0);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(maximumActiveRenders, 1);
  assert.equal(secondLoaderCalls, 1);
});

test("file rendition deletion tombstones stale reads before its first await", async (context) => {
  const directory = await temporaryDirectory(context);
  let loaderCalls = 0;
  let renderCalls = 0;
  const provider = new FileImageRenditionProvider(directory, async () => {
    renderCalls += 1;
    return renderedCard(await solidWebp("#5b2b1f"));
  });

  const deletion = provider.deleteForAsset(TEST_STORAGE_KEY);
  const staleRead = provider.readOrCreateCard(TEST_STORAGE_KEY, async () => {
    loaderCalls += 1;
    return Uint8Array.from([1]);
  });

  await deletion;
  assert.equal(await staleRead, null);
  assert.equal(loaderCalls, 0);
  assert.equal(renderCalls, 0);
  await assert.rejects(access(cardSidecarPath(directory)));
  await assert.rejects(access(cardNegativePath(directory)));
});

test("file rendition deletion waits for active rendering and removes its late sidecar", async (context) => {
  const directory = await temporaryDirectory(context);
  const cardBytes = await solidWebp("#5b2b1f");
  let announceRenderStarted!: () => void;
  let releaseRender!: () => void;
  const renderStarted = new Promise<void>((resolve) => {
    announceRenderStarted = resolve;
  });
  const renderRelease = new Promise<void>((resolve) => {
    releaseRender = resolve;
  });
  const provider = new FileImageRenditionProvider(directory, async () => {
    announceRenderStarted();
    await renderRelease;
    return renderedCard(cardBytes);
  });

  const read = provider.readOrCreateCard(TEST_STORAGE_KEY, async () =>
    Uint8Array.from([1]),
  );
  await renderStarted;
  const deletion = provider.deleteForAsset(TEST_STORAGE_KEY);
  releaseRender();

  assert.equal(await read, null);
  await deletion;
  await assert.rejects(access(cardSidecarPath(directory)));
  await assert.rejects(access(cardNegativePath(directory)));
});

test("file rendition provider clears failed in-flight work without leaving a cache file", async (context) => {
  const directory = await temporaryDirectory(context);
  let renderCalls = 0;
  const provider = new FileImageRenditionProvider(directory, async () => {
    renderCalls += 1;
    throw new Error("synthetic rendition failure");
  });

  await assert.rejects(
    Promise.all([
      provider.readOrCreateCard(
        TEST_STORAGE_KEY,
        async () => Uint8Array.from([1]),
      ),
      provider.readOrCreateCard(TEST_STORAGE_KEY, async () => Uint8Array.from([1])),
    ]),
    /synthetic rendition failure/,
  );
  assert.equal(renderCalls, 1);
  await assert.rejects(access(cardSidecarPath(directory)));

  await assert.rejects(
    provider.readOrCreateCard(TEST_STORAGE_KEY, async () => Uint8Array.from([1])),
    /synthetic rendition failure/,
  );
  assert.equal(renderCalls, 2);
});

test("file rendition provider deletion is idempotent and rejects invalid keys", async (context) => {
  const directory = await temporaryDirectory(context);
  const cardBytes = await solidWebp("#5b2b1f");
  const provider = new FileImageRenditionProvider(directory, async () =>
    renderedCard(cardBytes),
  );
  await provider.readOrCreateCard(
    TEST_STORAGE_KEY,
    async () => Uint8Array.from([1]),
  );

  await provider.deleteForAsset(TEST_STORAGE_KEY);
  await provider.deleteForAsset(TEST_STORAGE_KEY);
  await assert.rejects(access(cardSidecarPath(directory)));
  await assert.rejects(
    provider.readOrCreateCard("../escape", async () => Uint8Array.from([1])),
    hasCode("INVALID_INPUT"),
  );
  await assert.rejects(
    provider.deleteForAsset("../escape"),
    hasCode("INVALID_INPUT"),
  );
});

test("private file storage round-trips opaque keys and blocks path traversal", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-image-store-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const storage = new FileImageAssetStorage(directory);
  const bytes = Uint8Array.from([1, 2, 3]);

  await storage.put("storage-key_1", bytes);
  assert.deepEqual(
    Array.from(await storage.get("storage-key_1")),
    Array.from(bytes),
  );
  assert.deepEqual(await storage.listKeys(), ["storage-key_1"]);
  await assert.rejects(storage.put("../escape", bytes), hasCode("INVALID_INPUT"));
  await storage.delete("storage-key_1");
  await storage.delete("storage-key_1");
  assert.deepEqual(await storage.listKeys(), []);
});

function hasCode(code: BeautioError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof BeautioError);
    assert.equal(error.code, code);
    return true;
  };
}

function solidPng(background: string): Promise<Buffer> {
  return sharp({
    create: { width: 2, height: 2, channels: 3, background },
  })
    .png()
    .toBuffer();
}

interface ProductImageOptions {
  readonly canvas?: { readonly width: number; readonly height: number };
  readonly background:
    | string
    | { r: number; g: number; b: number; alpha: number };
  readonly subject: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

async function productImage(options: ProductImageOptions): Promise<Buffer> {
  const subject = await solidImage(
    options.subject.width,
    options.subject.height,
    "#5b2b1f",
  );
  const canvas = options.canvas ?? { width: 400, height: 300 };
  return sharp({
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 4,
      background: options.background,
    },
  })
    .composite([
      {
        input: subject,
        left: options.subject.left,
        top: options.subject.top,
      },
    ])
    .png()
    .toBuffer();
}

function solidImage(
  width: number,
  height: number,
  background: string,
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background },
  })
    .png()
    .toBuffer();
}

function solidWebp(background: string): Promise<Buffer> {
  return sharp({
    create: { width: 12, height: 8, channels: 3, background },
  })
    .webp()
    .toBuffer();
}

function renderedCard(bytes: Uint8Array): CardImageRendition {
  return {
    outcome: "rendered",
    bytes,
    mediaType: "image/webp",
    width: 12,
    height: 8,
    crop: { left: 1, top: 1, width: 12, height: 8 },
    fallbackReason: null,
  };
}

function cardSidecarPath(directory: string): string {
  return join(directory, ".renditions", "card-v1", TEST_CARD_FILENAME);
}

function cardNegativePath(directory: string): string {
  return join(
    directory,
    ".renditions",
    "card-v1",
    TEST_CARD_FILENAME.replace(/\.webp$/, ".unchanged"),
  );
}

async function temporaryDirectory(
  context: test.TestContext,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "beautio-renditions-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

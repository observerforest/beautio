import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readProductionObserveCredentials } from "../src/production-observe-credentials.ts";
import {
  createProductionObserveHandler,
  type ProductionObserveFetch,
} from "../src/production-observe.ts";

const LOCAL_TOKEN = "local-observe-token";
const PRODUCTION_TOKEN = "production-admin-token";
const PRODUCTION_ORIGIN = "https://beautio.example.test";
const AS_OF = "2026-08-28";
const EMPTY_INVENTORY = { as_of: AS_OF, items: [] };

test("production observer validates isolated tokens and a bare HTTPS origin", async (context) => {
  const webRoot = await webFixture(context);
  const baseOptions = {
    localBearerToken: LOCAL_TOKEN,
    productionAdminBearerToken: PRODUCTION_TOKEN,
    productionOrigin: PRODUCTION_ORIGIN,
    expectedProductionOrigin: PRODUCTION_ORIGIN,
    webRoot,
  };

  assert.throws(
    () => createProductionObserveHandler({ ...baseOptions, localBearerToken: "" }),
    /local observe token is required/,
  );
  assert.throws(
    () =>
      createProductionObserveHandler({
        ...baseOptions,
        productionAdminBearerToken: LOCAL_TOKEN,
      }),
    /must differ/,
  );
  for (const productionOrigin of [
    "http://beautio.example.test",
    "https://user:password@beautio.example.test",
    "https://beautio.example.test:8443",
    "https://beautio.example.test/path",
    "https://beautio.example.test/?query=yes",
    "https://beautio.example.test/#fragment",
  ]) {
    assert.throws(
      () => createProductionObserveHandler({ ...baseOptions, productionOrigin }),
      /HTTPS origin/,
    );
  }
  assert.throws(
    () =>
      createProductionObserveHandler({
        ...baseOptions,
        expectedProductionOrigin: "https://other.example.test",
      }),
    /does not match the independently configured expected origin/,
  );
});

test("production observer only forwards exact authenticated read routes", async (context) => {
  const upstreamRequests: Array<{
    readonly url: URL;
    readonly init: RequestInit;
  }> = [];
  const fixture = await startFixture(context, async (input, init = {}) => {
    upstreamRequests.push({ url: requestUrl(input), init });
    return jsonResponse(EMPTY_INVENTORY, {
      "access-control-allow-origin": "*",
      "set-cookie": "production-cookie=must-not-leak",
    });
  });

  const health = await fetch(`${fixture.origin}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok",
    mode: "production-observe",
    access: "read-only",
  });
  assert.equal(upstreamRequests.length, 0);

  const port = new URL(fixture.origin).port;
  for (const rawRequest of [
    [
      `GET /api/inventory?as_of=${AS_OF} HTTP/1.1`,
      `Host: attacker.example:${port}`,
      `Authorization: Bearer ${LOCAL_TOKEN}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n"),
    [
      `GET /api/health HTTP/1.0`,
      "Connection: close",
      "",
      "",
    ].join("\r\n"),
    [
      `GET / HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Host: attacker.example:${port}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n"),
  ]) {
    assert.equal(await rawHttpStatus(fixture.origin, rawRequest), 421);
  }
  assert.equal(upstreamRequests.length, 0);

  assert.equal(
    (await fetch(`${fixture.origin}/api/inventory?as_of=${AS_OF}`)).status,
    401,
  );
  assert.equal(upstreamRequests.length, 0);

  for (const request of [
    () => observeFetch(fixture.origin, "/api/inventory?as_of=2026-02-30"),
    () => observeFetch(fixture.origin, `/api/inventory?as_of=${AS_OF}&extra=1`),
    () => observeFetch(fixture.origin, `/api/inventory?as_of=${AS_OF}&as_of=${AS_OF}`),
    () => observeFetch(fixture.origin, "/api/inventory/"),
    () => observeFetch(fixture.origin, "/api/admin/products/product-1"),
    () => observeFetch(fixture.origin, "/api/actions/create-inventory-batch"),
    () => observeFetch(fixture.origin, "/api/unknown"),
    () => observeFetch(fixture.origin, `/%61pi/inventory?as_of=${AS_OF}`),
    () => observeFetch(fixture.origin, "/openapi/beautio-actions-v1.json"),
    () => observeFetch(fixture.origin, "/mcp"),
    ...(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const).map(
      (method) => () =>
        observeFetch(fixture.origin, `/api/inventory?as_of=${AS_OF}`, {
          method,
          ...(method === "HEAD" ? {} : { body: "do-not-forward" }),
        }),
    ),
  ]) {
    const response = await request();
    assert.ok(response.status === 404 || response.status === 405);
  }
  assert.equal(upstreamRequests.length, 0);

  const inventory = await observeFetch(
    fixture.origin,
    `/api/inventory?as_of=${AS_OF}`,
    {
      headers: {
        cookie: "browser-cookie=must-not-forward",
        "x-browser-only": "must-not-forward",
      },
    },
  );
  assert.equal(inventory.status, 200);
  assert.deepEqual(await inventory.json(), EMPTY_INVENTORY);
  assert.equal(inventory.headers.get("x-beautio-mode"), "production-observe");
  assert.equal(inventory.headers.get("cache-control"), "no-store");
  assert.equal(inventory.headers.get("set-cookie"), null);
  assert.equal(inventory.headers.get("access-control-allow-origin"), null);
  assert.equal(upstreamRequests.length, 1);

  const forwarded = upstreamRequests[0];
  assert.ok(forwarded !== undefined);
  assert.equal(forwarded.url.origin, PRODUCTION_ORIGIN);
  assert.equal(forwarded.url.pathname, "/api/inventory");
  assert.equal(forwarded.url.search, `?as_of=${AS_OF}`);
  assert.equal(forwarded.init.method, "GET");
  assert.equal(forwarded.init.redirect, "manual");
  const headers = new Headers(forwarded.init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${PRODUCTION_TOKEN}`);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("cookie"), null);
  assert.equal(headers.get("x-browser-only"), null);
});

test("production observer validates inventory identity without retrying", async (context) => {
  const responses = [
    jsonResponse({ as_of: "2026-08-27", items: [] }),
    jsonResponse({ as_of: AS_OF, items: "not-an-array" }),
    new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify(EMPTY_INVENTORY), {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
    new Response(null, {
      status: 302,
      headers: { location: "https://another.example.test" },
    }),
  ];
  let requestCount = 0;
  const fixture = await startFixture(context, async () => {
    const response = responses[requestCount];
    requestCount += 1;
    assert.ok(response !== undefined);
    return response;
  });

  for (let index = 0; index < responses.length; index += 1) {
    const response = await observeFetch(
      fixture.origin,
      `/api/inventory?as_of=${AS_OF}`,
    );
    assert.equal(response.status, 502);
    const body = (await response.json()) as { readonly error: { readonly message: string } };
    assert.doesNotMatch(body.error.message, /production-admin-token|beautio\.example/u);
    assert.equal(requestCount, index + 1);
  }
});

test("production observer bounds upstream bodies and times out once", async (context) => {
  let requestCount = 0;
  const oversizedFixture = await startFixture(
    context,
    async () => {
      requestCount += 1;
      return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        status: 200,
        headers: {
          "content-length": "5",
          "content-type": "application/json",
        },
      });
    },
    { maximumInventoryBytes: 4 },
  );
  assert.equal(
    (
      await observeFetch(
        oversizedFixture.origin,
        `/api/inventory?as_of=${AS_OF}`,
      )
    ).status,
    502,
  );
  assert.equal(requestCount, 1);

  let timeoutRequests = 0;
  const timeoutFixture = await startFixture(
    context,
    async (_input, init = {}) => {
      timeoutRequests += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    },
    { upstreamTimeoutMs: 20 },
  );
  assert.equal(
    (
      await observeFetch(
        timeoutFixture.origin,
        `/api/inventory?as_of=${AS_OF}`,
      )
    ).status,
    502,
  );
  assert.equal(timeoutRequests, 1);
});

test("production observer canonicalizes and bounds protected image reads", async (context) => {
  const upstreamRequests: URL[] = [];
  const fixture = await startFixture(context, async (input) => {
    const url = requestUrl(input);
    upstreamRequests.push(url);
    if (url.pathname.endsWith("missing/content")) {
      return jsonResponse({ error: { code: "not-found" } }, {}, 404);
    }
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: {
        "content-type": "image/png",
        "set-cookie": "production-cookie=must-not-leak",
        location: "https://must-not-leak.example",
      },
    });
  });

  for (const path of [
    "/api/image-assets/asset%2Fescape/content",
    "/api/image-assets/asset%5Cescape/content",
    "/api/image-assets/../content",
    "/api/image-assets/asset-1/content?variant=original",
    "/api/image-assets/asset-1/content?variant=card&extra=1",
  ]) {
    assert.equal((await observeFetch(fixture.origin, path)).status, 404);
  }
  assert.equal(upstreamRequests.length, 0);

  const image = await observeFetch(
    fixture.origin,
    "/api/image-assets/asset%20one/content?variant=card",
  );
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("set-cookie"), null);
  assert.equal(image.headers.get("location"), null);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), new Uint8Array([137, 80, 78, 71]));
  assert.equal(upstreamRequests[0]?.pathname, "/api/image-assets/asset%20one/content");
  assert.equal(upstreamRequests[0]?.search, "?variant=card");

  const missing = await observeFetch(
    fixture.origin,
    "/api/image-assets/missing/content",
  );
  assert.equal(missing.status, 404);
  assert.equal(upstreamRequests.length, 2);
});

test("production observe credentials require one stable current-user 0600 file", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "beautio-prod-observe-creds-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const credentialPath = join(directory, "credentials.txt");
  const validText = [
    "Beautio production credentials",
    `URL: ${PRODUCTION_ORIGIN}`,
    "Action Key: ignored-action-key",
    `Admin Key: ${PRODUCTION_TOKEN}`,
    "",
  ].join("\n");
  await writeFile(credentialPath, validText, { mode: 0o600 });

  assert.deepEqual(await readProductionObserveCredentials(credentialPath), {
    productionOrigin: PRODUCTION_ORIGIN,
    productionAdminBearerToken: PRODUCTION_TOKEN,
  });

  await chmod(credentialPath, 0o644);
  await assert.rejects(
    readProductionObserveCredentials(credentialPath),
    /valid current-user 0600 regular file/,
  );
  await chmod(credentialPath, 0o600);

  const symlinkPath = join(directory, "credentials-link.txt");
  await symlink(credentialPath, symlinkPath);
  await assert.rejects(
    readProductionObserveCredentials(symlinkPath),
    /valid current-user 0600 regular file/,
  );
  await assert.rejects(
    readProductionObserveCredentials("relative-credentials.txt"),
    /valid current-user 0600 regular file/,
  );

  for (const invalidText of [
    `URL: ${PRODUCTION_ORIGIN}\n`,
    `Admin Key: ${PRODUCTION_TOKEN}\n`,
    `URL: ${PRODUCTION_ORIGIN}\nURL: ${PRODUCTION_ORIGIN}\nAdmin Key: ${PRODUCTION_TOKEN}\n`,
    `URL: http://beautio.example.test\nAdmin Key: ${PRODUCTION_TOKEN}\n`,
    `URL: ${PRODUCTION_ORIGIN}/path\nAdmin Key: ${PRODUCTION_TOKEN}\n`,
    `URL: ${PRODUCTION_ORIGIN}\nAdmin Key: token with spaces\n`,
  ]) {
    await writeFile(credentialPath, invalidText, { mode: 0o600 });
    await assert.rejects(
      readProductionObserveCredentials(credentialPath),
      /valid current-user 0600 regular file/,
    );
  }

  await writeFile(credentialPath, new Uint8Array([0xff]), { mode: 0o600 });
  await assert.rejects(
    readProductionObserveCredentials(credentialPath),
    /valid current-user 0600 regular file/,
  );
  await writeFile(credentialPath, Buffer.alloc(8 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(
    readProductionObserveCredentials(credentialPath),
    /valid current-user 0600 regular file/,
  );
});

interface Fixture {
  readonly origin: string;
}

interface FixtureOptions {
  readonly upstreamTimeoutMs?: number;
  readonly maximumInventoryBytes?: number;
  readonly maximumImageBytes?: number;
}

async function startFixture(
  context: TestContext,
  upstreamFetch: ProductionObserveFetch,
  options: FixtureOptions = {},
): Promise<Fixture> {
  const webRoot = await webFixture(context);
  const server = createServer(
    createProductionObserveHandler({
      localBearerToken: LOCAL_TOKEN,
      productionAdminBearerToken: PRODUCTION_TOKEN,
      productionOrigin: PRODUCTION_ORIGIN,
      expectedProductionOrigin: PRODUCTION_ORIGIN,
      webRoot,
      upstreamFetch,
      ...(options.upstreamTimeoutMs === undefined
        ? {}
        : { upstreamTimeoutMs: options.upstreamTimeoutMs }),
      ...(options.maximumInventoryBytes === undefined
        ? {}
        : { maximumInventoryBytes: options.maximumInventoryBytes }),
      ...(options.maximumImageBytes === undefined
        ? {}
        : { maximumImageBytes: options.maximumImageBytes }),
    }),
  );
  await new Promise<void>((resolvePromise) =>
    server.listen(0, "127.0.0.1", resolvePromise),
  );
  context.after(() => closeServer(server));
  const address = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}` };
}

async function webFixture(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "beautio-prod-observe-web-"));
  const webRoot = join(directory, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Beautio</title>");
  context.after(() => rm(directory, { recursive: true, force: true }));
  return webRoot;
}

function observeFetch(
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${LOCAL_TOKEN}`);
  return fetch(`${origin}${path}`, { ...init, headers });
}

function jsonResponse(
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function requestUrl(input: string | URL | Request): URL {
  return input instanceof Request ? new URL(input.url) : new URL(input);
}

function rawHttpStatus(origin: string, requestText: string): Promise<number> {
  const url = new URL(origin);
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection({
      host: url.hostname,
      port: Number(url.port),
    });
    let responseText = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(requestText));
    socket.on("data", (chunk: string) => {
      responseText += chunk;
    });
    socket.once("error", rejectPromise);
    socket.once("end", () => {
      const status = /^HTTP\/1\.[01] (\d{3})/u.exec(responseText)?.[1];
      if (status === undefined) {
        rejectPromise(new Error("raw HTTP response did not contain a status"));
        return;
      }
      resolvePromise(Number(status));
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) =>
      error === undefined ? resolvePromise() : rejectPromise(error),
    );
  });
}

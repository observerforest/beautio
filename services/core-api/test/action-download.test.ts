import assert from "node:assert/strict";
import test from "node:test";
import { BeautioError } from "@beautio/domain";
import { createServer } from "node:net";
import {
  downloadActionImages,
  isPublicActionAddress,
  parseActionFileHostAllowlist,
  requestPinned,
  type PinnedActionRequester,
} from "../src/action-download.ts";

test("Action allowlist preserves exact normalized configured hosts", () => {
  assert.deepEqual(
    [...parseActionFileHostAllowlist(" Files.Example.test,cdn.example.test ")],
    ["files.example.test", "cdn.example.test"],
  );
  assert.throws(() => parseActionFileHostAllowlist(""), /is required/);
  assert.throws(
    () => parseActionFileHostAllowlist("https://files.example.test"),
    /invalid host/,
  );
});

test("Action downloader accepts exact hosts and an explicitly enabled OpenAI file-host root", async () => {
  const resolver = async () => [{ address: "8.8.8.8", family: 4 as const }];
  const requestedHosts: string[] = [];
  const requester: PinnedActionRequester = async (url) => {
    requestedHosts.push(url.hostname);
    return { bytes: Uint8Array.from([1]), redirectLocation: null };
  };
  const references = [
    {
      name: "exact.png",
      id: "exact",
      mime_type: "image/png",
      download_link: "https://files.example.test/exact",
    },
    {
      name: "root.png",
      id: "root",
      mime_type: "image/png",
      download_link: "https://oaiusercontent.com/root",
    },
    {
      name: "regional.png",
      id: "regional",
      mime_type: "image/png",
      download_link: "https://SDMNTPRWESTUS3.OAIUSERCONTENT.COM/regional",
    },
    {
      name: "nested.png",
      id: "nested",
      mime_type: "image/png",
      download_link: "https://a.b.oaiusercontent.com/nested",
    },
  ];

  const downloaded = await downloadActionImages(
    references,
    parseActionFileHostAllowlist("files.example.test,oaiusercontent.com"),
    resolver,
    requester,
  );

  assert.deepEqual(
    downloaded.map((item) => item.source_ref),
    ["exact", "root", "regional", "nested"],
  );
  assert.deepEqual(requestedHosts, [
    "files.example.test",
    "oaiusercontent.com",
    "sdmntprwestus3.oaiusercontent.com",
    "a.b.oaiusercontent.com",
  ]);
});

test("OpenAI file-host subdomains require the explicit root and reject boundary bypasses", async () => {
  const resolver = async () => {
    throw new Error("resolver must not run");
  };
  const requester: PinnedActionRequester = async () => {
    throw new Error("requester must not run");
  };
  const reference = (download_link: string) => [
    {
      name: "confirmed.png",
      id: "file-1",
      mime_type: "image/png",
      download_link,
    },
  ];

  await assert.rejects(
    downloadActionImages(
      reference("https://sdmntprwestus3.oaiusercontent.com/file"),
      parseActionFileHostAllowlist("files.oaiusercontent.com"),
      resolver,
      requester,
    ),
    hasCode("FILE_SOURCE_REJECTED"),
  );

  const allowed = parseActionFileHostAllowlist("oaiusercontent.com");
  for (const downloadLink of [
    "https://eviloaiusercontent.com/file",
    "https://oaiusercontent.com.evil.example/file",
    "https://oaiusercontent.com./file",
    "https://a.oaiusercontent.com./file",
  ]) {
    await assert.rejects(
      downloadActionImages(reference(downloadLink), allowed, resolver, requester),
      hasCode("FILE_SOURCE_REJECTED"),
    );
  }
});

test("Action address filter rejects local, private, link-local, and reserved ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.0.1",
    "192.0.2.1",
    "192.88.99.2",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2001::1",
    "2001:10::1",
    "2001:20::1",
    "2002::1",
    "2100::1",
    "2d00::1",
    "3fff::1",
  ]) {
    assert.equal(isPublicActionAddress(address), false, address);
  }
  assert.equal(isPublicActionAddress("8.8.8.8"), true);
  assert.equal(isPublicActionAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicActionAddress("2001:4860:4860::8888"), true);
});

test("Action downloader rejects non-HTTPS, non-allowlisted, and mixed public/private DNS", async () => {
  const allowed = parseActionFileHostAllowlist("files.example.test");
  const reference = (download_link: string) => [
    {
      name: "confirmed.png",
      id: "file-1",
      mime_type: "image/png",
      download_link,
    },
  ];
  const resolver = async () => [
    { address: "8.8.8.8", family: 4 as const },
    { address: "127.0.0.1", family: 4 as const },
  ];
  const requester: PinnedActionRequester = async () => {
    throw new Error("requester must not run");
  };

  await assert.rejects(
    downloadActionImages(reference("http://files.example.test/a"), allowed, resolver, requester),
    hasCode("FILE_SOURCE_REJECTED"),
  );
  await assert.rejects(
    downloadActionImages(reference("https://other.example.test/a"), allowed, resolver, requester),
    hasCode("FILE_SOURCE_REJECTED"),
  );
  await assert.rejects(
    downloadActionImages(reference("https://files.example.test/a"), allowed, resolver, requester),
    hasCode("FILE_SOURCE_REJECTED"),
  );
});

test("Action downloader revalidates every redirect and caps the chain at three", async () => {
  const allowed = parseActionFileHostAllowlist("files.example.test");
  const reference = [
    {
      name: "confirmed.png",
      id: "file-redirected",
      mime_type: "image/png",
      download_link: "https://files.example.test/0",
    },
  ];
  let resolveCalls = 0;
  const resolver = async () => {
    resolveCalls += 1;
    return [{ address: "8.8.8.8", family: 4 as const }];
  };
  let requestCalls = 0;
  const threeRedirects: PinnedActionRequester = async () => {
    requestCalls += 1;
    return requestCalls <= 3
      ? { bytes: new Uint8Array(), redirectLocation: `/${requestCalls}` }
      : { bytes: Uint8Array.from([1, 2, 3]), redirectLocation: null };
  };

  const downloaded = await downloadActionImages(
    reference,
    allowed,
    resolver,
    threeRedirects,
  );
  assert.equal(resolveCalls, 4);
  assert.equal(requestCalls, 4);
  assert.deepEqual(downloaded, [
    { source_ref: "file-redirected", bytes: Uint8Array.from([1, 2, 3]) },
  ]);

  const alwaysRedirect: PinnedActionRequester = async () => ({
    bytes: new Uint8Array(),
    redirectLocation: "/again",
  });
  await assert.rejects(
    downloadActionImages(reference, allowed, resolver, alwaysRedirect),
    hasCode("FILE_SOURCE_REJECTED"),
  );
});

test("Action redirect cannot escape the allowlist", async () => {
  const allowed = parseActionFileHostAllowlist("files.example.test");
  let requests = 0;
  const requester: PinnedActionRequester = async () => {
    requests += 1;
    return {
      bytes: new Uint8Array(),
      redirectLocation: "https://evil.example.test/private",
    };
  };

  await assert.rejects(
    downloadActionImages(
      [
        {
          name: "confirmed.png",
          id: "file-1",
          mime_type: "image/png",
          download_link: "https://files.example.test/start",
        },
      ],
      allowed,
      async () => [{ address: "8.8.8.8", family: 4 }],
      requester,
    ),
    hasCode("FILE_SOURCE_REJECTED"),
  );
  assert.equal(requests, 1);
});

test("Action redirects reuse the explicitly enabled OpenAI file-host boundary", async () => {
  const allowed = parseActionFileHostAllowlist(
    "files.example.test,oaiusercontent.com",
  );
  const resolver = async () => [{ address: "8.8.8.8", family: 4 as const }];
  const reference = [
    {
      name: "confirmed.png",
      id: "file-redirected",
      mime_type: "image/png",
      download_link: "https://files.example.test/start",
    },
  ];
  const requestedHosts: string[] = [];
  const allowedRequester: PinnedActionRequester = async (url) => {
    requestedHosts.push(url.hostname);
    return url.hostname === "files.example.test"
      ? {
          bytes: new Uint8Array(),
          redirectLocation: "https://a.b.oaiusercontent.com/final",
        }
      : { bytes: Uint8Array.from([1]), redirectLocation: null };
  };

  await downloadActionImages(reference, allowed, resolver, allowedRequester);
  assert.deepEqual(requestedHosts, [
    "files.example.test",
    "a.b.oaiusercontent.com",
  ]);

  let rejectedRequests = 0;
  const rejectedRequester: PinnedActionRequester = async () => {
    rejectedRequests += 1;
    return {
      bytes: new Uint8Array(),
      redirectLocation: "https://eviloaiusercontent.com/private",
    };
  };
  await assert.rejects(
    downloadActionImages(reference, allowed, resolver, rejectedRequester),
    hasCode("FILE_SOURCE_REJECTED"),
  );
  assert.equal(rejectedRequests, 1);
});

test("Action downloader enforces file, total, and count limits independently", async () => {
  const allowed = parseActionFileHostAllowlist("files.example.test");
  const resolver = async () => [{ address: "8.8.8.8", family: 4 as const }];
  const reference = (id: string) => ({
    name: `${id}.png`,
    id,
    mime_type: "image/png",
    download_link: `https://files.example.test/${id}`,
  });
  const oversized: PinnedActionRequester = async (
    _url,
    _address,
    maximumBytes,
  ) => ({
    bytes: new Uint8Array(maximumBytes + 1),
    redirectLocation: null,
  });

  await assert.rejects(
    downloadActionImages([reference("one")], allowed, resolver, oversized),
    hasCode("UPLOAD_TOO_LARGE"),
  );
  await assert.rejects(
    downloadActionImages([], allowed, resolver, oversized),
    hasCode("INVALID_INPUT"),
  );
  await assert.rejects(
    downloadActionImages(
      Array.from({ length: 11 }, (_, index) => reference(`file_${index}`)),
      allowed,
      resolver,
      oversized,
    ),
    hasCode("INVALID_INPUT"),
  );

  const fillLimit: PinnedActionRequester = async (
    _url,
    _address,
    maximumBytes,
  ) => ({
    bytes: new Uint8Array(maximumBytes),
    redirectLocation: null,
  });
  await assert.rejects(
    downloadActionImages(
      [reference("a"), reference("b"), reference("c"), reference("d")],
      allowed,
      resolver,
      fillLimit,
    ),
    hasCode("UPLOAD_TOO_LARGE"),
  );
});

test("Action downloader applies per-file and overall timeouts across DNS and redirects", async () => {
  const allowed = parseActionFileHostAllowlist("files.example.test");
  const keepAlive = setTimeout(() => undefined, 100);
  try {
    await assert.rejects(
      downloadActionImages(
        [
          {
            name: "slow.png",
            id: "slow",
            mime_type: "image/png",
            download_link: "https://files.example.test/slow",
          },
        ],
        allowed,
        async () => new Promise(() => undefined),
        async () => new Promise(() => undefined),
        { fileTimeoutMs: 5, actionTimeoutMs: 50 },
      ),
      hasCode("UPLOAD_FAILED"),
    );
    await assert.rejects(
      downloadActionImages(
        [
          {
            name: "overall-slow.png",
            id: "overall_slow",
            mime_type: "image/png",
            download_link: "https://files.example.test/overall-slow",
          },
        ],
        allowed,
        async () => new Promise(() => undefined),
        async () => new Promise(() => undefined),
        { fileTimeoutMs: 50, actionTimeoutMs: 5 },
      ),
      hasCode("UPLOAD_FAILED"),
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test("pinned HTTPS transport supports Node autoSelectFamily lookup shape", async () => {
  let acceptedConnections = 0;
  const server = createServer((socket) => {
    acceptedConnections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP port");
    }

    await assert.rejects(
      requestPinned(
        new URL(`https://files.example.test:${address.port}/fixture`),
        { address: "127.0.0.1", family: 4 },
        1024,
        AbortSignal.timeout(2_000),
      ),
      hasCode("UPLOAD_FAILED"),
    );
    assert.equal(acceptedConnections, 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
});

function hasCode(code: BeautioError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof BeautioError);
    assert.equal(error.code, code);
    return true;
  };
}

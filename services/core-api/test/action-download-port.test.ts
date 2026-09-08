import assert from "node:assert/strict";
import test from "node:test";
import { BeautioError } from "@beautio/domain";
import {
  downloadActionImages,
  downloadActionImagesSettled,
  type HostResolver,
  type PinnedActionRequester,
} from "../src/action-download.ts";

const allowedHosts = new Set(["files.example.test"]);
const reference = (download_link: string) => [{
  name: "synthetic.png", id: "file-1", mime_type: "image/png", download_link,
}];
const timing = { fileTimeoutMs: 500, actionTimeoutMs: 1000 };
const rejectedSource = (error: unknown) => error instanceof BeautioError && error.code === "FILE_SOURCE_REJECTED";

for (const download of [downloadActionImages, downloadActionImagesSettled]) {
  test(`${download.name} rejects initial non-default HTTPS ports before DNS or requests`, { timeout: 2000 }, async () => {
    let lookups = 0, requests = 0;
    const resolver: HostResolver = async () => { lookups++; return [{ address: "8.8.8.8", family: 4 }]; };
    const requester: PinnedActionRequester = async () => { requests++; return { bytes: new Uint8Array([1]), redirectLocation: null }; };
    for (const port of ["80", "8443", "0", "65535"]) {
      await assert.rejects(download(reference(`https://files.example.test:${port}/image`), allowedHosts, resolver, requester, timing), rejectedSource);
      assert.equal(lookups, 0); assert.equal(requests, 0);
    }
  });

  test(`${download.name} rejects same-host non-default-port redirects before a second lookup or request`, { timeout: 2000 }, async () => {
    for (const location of ["https://files.example.test:8443/next", "//files.example.test:8443/next"]) {
      let lookups = 0, requests = 0;
      const resolver: HostResolver = async () => { lookups++; return [{ address: "8.8.8.8", family: 4 }]; };
      const requester: PinnedActionRequester = async (url) => {
        requests++; assert.equal(url.port, "");
        return { bytes: new Uint8Array(), redirectLocation: location };
      };
      await assert.rejects(download(reference("https://files.example.test/image"), allowedHosts, resolver, requester, timing), rejectedSource);
      assert.equal(lookups, 1); assert.equal(requests, 1);
    }
  });

  test(`${download.name} retains default and explicit 443 URLs plus relative redirects`, { timeout: 2000 }, async () => {
    for (const initial of ["https://files.example.test/image", "https://files.example.test:443/image"]) {
      for (const location of [null, "/next", "https://files.example.test:443/next"]) {
        let lookups = 0;
        const requested: string[] = [];
        const resolver: HostResolver = async (hostname) => {
          lookups++; assert.equal(hostname, "files.example.test"); return [{ address: "8.8.8.8", family: 4 }];
        };
        const requester: PinnedActionRequester = async (url, address) => {
          requested.push(url.href);
          assert.equal(url.protocol, "https:"); assert.equal(url.port, "");
          assert.deepEqual(address, { address: "8.8.8.8", family: 4 });
          return requested.length === 1 && location !== null
            ? { bytes: new Uint8Array(), redirectLocation: location }
            : { bytes: new Uint8Array([1, 2, 3]), redirectLocation: null };
        };
        assert.deepEqual(await download(reference(initial), allowedHosts, resolver, requester, timing), [{ source_ref: "file-1", bytes: new Uint8Array([1, 2, 3]) }]);
        assert.deepEqual(requested, location === null ? ["https://files.example.test/image"] : ["https://files.example.test/image", "https://files.example.test/next"]);
        assert.equal(lookups, requested.length);
      }
    }
  });
}

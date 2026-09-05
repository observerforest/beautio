import { BeautioError } from "@beautio/domain";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { assertStorageKey } from "./file-io.ts";
import { isMissingFile } from "./errors.ts";

export interface ReservedImageObject { readonly kind: "reserved_image_object" }
interface Reservation {
  readonly file: FileHandle; readonly path: string; readonly device: number; readonly inode: number;
  written: boolean; discarded: boolean; busy: boolean;
}

/** Owns create-only file identities for at most one ten-image command batch. */
export class ReservedImageObjectStore {
  readonly #root: string;
  readonly #live = new WeakMap<ReservedImageObject, Reservation>();
  readonly #released = new WeakSet<ReservedImageObject>();
  #active = 0;

  /** @param root - Trusted private storage root, shared with ordinary immutable originals. */
  constructor(root: string) { this.#root = resolve(root); }

  /** @param key - Generated opaque key. @returns An instance-owned empty-file capability; existing paths are never claimed. */
  async reserve(key: string): Promise<ReservedImageObject> {
    assertStorageKey(key);
    if (this.#active >= 10) throw failure();
    this.#active += 1;
    let file: FileHandle | undefined;
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const path = resolve(this.#root, key);
      file = await open(path, "wx+", 0o600);
      const identity = await file.stat();
      const handle = Object.freeze({ kind: "reserved_image_object" as const });
      this.#live.set(handle, { file, path, device: identity.dev, inode: identity.ino, written: false, discarded: false, busy: false });
      return handle;
    } catch {
      // Once open succeeds, a rejected close cannot prove that the descriptor
      // released its slot. Keep uncertain ownership charged against the bound.
      if (file === undefined) this.#active -= 1;
      else { await file.close(); this.#active -= 1; }
      throw failure();
    }
  }
  /** @param handle - Same-instance live capability. @param bytes - Validated owned bytes. @returns Completion after one durable write to the reserved identity. */
  async writeReserved(handle: ReservedImageObject, bytes: Uint8Array): Promise<void> {
    await this.withReservation(handle, async (entry) => {
      if (entry.written || entry.discarded) throw failure();
      await this.verifyIdentity(entry);
      if ((await entry.file.stat()).size !== 0) throw failure();
      // A failed write still consumes write authority; this command never retries it.
      entry.written = true;
      await entry.file.writeFile(bytes);
      await entry.file.sync();
      await this.verifyIdentity(entry);
    });
  }
  /** @param handle - Same-instance written object. @param expectedBytes - Full expected content. @returns Completion only after exact byte and identity readback. */
  async verifyReserved(handle: ReservedImageObject, expectedBytes: Uint8Array): Promise<void> {
    await this.withReservation(handle, async (entry) => {
      if (!entry.written || entry.discarded) throw failure();
      await this.verifyIdentity(entry);
      if ((await entry.file.stat()).size !== expectedBytes.byteLength) throw failure();
      const actual = Buffer.alloc(expectedBytes.byteLength);
      let offset = 0;
      while (offset < actual.byteLength) {
        const result = await entry.file.read(actual, offset, actual.byteLength - offset, offset);
        if (result.bytesRead === 0) throw failure();
        offset += result.bytesRead;
      }
      if (!actual.equals(Buffer.from(expectedBytes.buffer, expectedBytes.byteOffset, expectedBytes.byteLength))) throw failure();
      await this.verifyIdentity(entry);
    });
  }
  /** @param handle - Same-instance object. @returns Completion after deleting only its currently matching identity, or confirming absence. */
  async discardReserved(handle: ReservedImageObject): Promise<void> {
    await this.withReservation(handle, async (entry) => {
      if (entry.discarded) return;
      try { await this.verifyIdentity(entry); }
      catch (error) {
        if (!isMissingFile(error)) throw error;
        entry.discarded = true; return;
      }
      await unlink(entry.path);
      entry.discarded = true;
    });
  }
  /** @param handle - Same-instance capability. @returns Completion after closing and retiring it, without deleting the file. */
  async releaseReserved(handle: ReservedImageObject): Promise<void> {
    if (this.#released.has(handle)) return;
    const entry = this.#live.get(handle);
    if (entry === undefined || entry.busy) throw failure();
    entry.busy = true;
    try {
      await entry.file.close();
      this.#live.delete(handle); this.#released.add(handle); this.#active -= 1;
    } finally { entry.busy = false; }
  }
  private async withReservation(handle: ReservedImageObject, action: (entry: Reservation) => Promise<void>): Promise<void> {
    const entry = this.#live.get(handle);
    if (entry === undefined || entry.busy) throw failure();
    entry.busy = true;
    try { await action(entry); } finally { entry.busy = false; }
  }
  private async verifyIdentity(entry: Reservation): Promise<void> {
    const current = await lstat(entry.path);
    const opened = await entry.file.stat();
    if (!current.isFile() || current.dev !== entry.device || current.ino !== entry.inode ||
      opened.dev !== entry.device || opened.ino !== entry.inode) throw failure();
  }
}
function failure(): BeautioError { return new BeautioError("UPLOAD_FAILED", "owned image storage operation failed"); }

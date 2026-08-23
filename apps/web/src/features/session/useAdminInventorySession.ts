import type { InventoryListOutput } from "@beautio/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminApiClient, AdminApiError } from "../../admin-api.ts";
import { localDateForApi } from "../../view-model.ts";

export type SessionPhase = "locked" | "unlocking" | "unlocked";

export interface AdminInventorySession {
  readonly phase: SessionPhase;
  readonly client: AdminApiClient | null;
  readonly inventory: InventoryListOutput | null;
  readonly unlockMessage: string;
  readonly readError: string | null;
  readonly statusMessage: string | null;
  readonly unlock: (token: string) => Promise<boolean>;
  readonly lock: (message: string) => void;
  readonly refresh: (showLoading?: boolean) => Promise<boolean>;
  readonly setStatusMessage: (message: string | null) => void;
}

interface ActiveRefresh {
  readonly client: AdminApiClient;
  readonly operation: Promise<boolean>;
}

/**
 * 管理当前标签页范围内的 Admin 客户端与已认证库存快照。
 * Owns the tab-scoped Admin client and the authenticated inventory snapshot.
 *
 * @returns 会话状态，以及显式的解锁、锁定、刷新与状态操作。 / Session state plus explicit unlock, lock, refresh, and status operations.
 *
 * 密钥会直接交给 AdminApiClient；解锁开始后不会持久化到浏览器存储、URL、Cookie 或 React state。
 * The credential is handed directly to AdminApiClient and is never persisted in browser
 * storage, a URL, a cookie, or React state after unlock begins.
 */
export function useAdminInventorySession(): AdminInventorySession {
  const [phase, setPhase] = useState<SessionPhase>("locked");
  const [client, setClient] = useState<AdminApiClient | null>(null);
  const [inventory, setInventory] = useState<InventoryListOutput | null>(null);
  const [unlockMessage, setUnlockMessage] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const clientRef = useRef<AdminApiClient | null>(null);
  const activeRefreshRef = useRef<ActiveRefresh | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const destroyClient = useCallback(() => {
    generationRef.current += 1;
    const current = clientRef.current;
    clientRef.current = null;
    if (activeRefreshRef.current?.client === current) {
      activeRefreshRef.current = null;
    }
    current?.destroy();
  }, []);

  const lock = useCallback((message: string) => {
    destroyClient();
    setClient(null);
    setInventory(null);
    setReadError(null);
    setStatusMessage(null);
    setPhase("locked");
    setUnlockMessage(message);
  }, [destroyClient]);

  const unlock = useCallback(async (rawToken: string): Promise<boolean> => {
    const token = rawToken.trim();
    if (token.length === 0) {
      setUnlockMessage("请输入管理密钥。");
      return false;
    }

    destroyClient();
    const candidate = new AdminApiClient(token);
    const generation = generationRef.current;
    clientRef.current = candidate;
    setClient(null);
    setInventory(null);
    setReadError(null);
    setStatusMessage(null);
    setUnlockMessage("正在验证密钥并读取库存…");
    setPhase("unlocking");

    try {
      const data = await candidate.readInventory(localDateForApi(new Date()));
      if (
        !mountedRef.current ||
        generationRef.current !== generation ||
        clientRef.current !== candidate
      ) {
        candidate.destroy();
        return false;
      }
      setClient(candidate);
      setInventory(data);
      setUnlockMessage("");
      setPhase("unlocked");
      return true;
    } catch (error) {
      if (
        !mountedRef.current ||
        generationRef.current !== generation ||
        clientRef.current !== candidate ||
        isAbortError(error)
      ) {
        return false;
      }
      candidate.destroy();
      clientRef.current = null;
      setClient(null);
      setInventory(null);
      setPhase("locked");
      setUnlockMessage(
        error instanceof AdminApiError && error.status === 401
          ? "管理密钥无效或已撤销，请重新输入。库存没有被读取。"
          : errorMessage(error),
      );
      return false;
    }
  }, [destroyClient]);

  const refresh = useCallback((showLoading = false): Promise<boolean> => {
    const current = clientRef.current;
    if (current === null) return Promise.resolve(false);
    if (activeRefreshRef.current?.client === current) {
      return activeRefreshRef.current.operation;
    }

    const operation = (async (): Promise<boolean> => {
      if (showLoading) setReadError(null);
      try {
        const data = await current.readInventory(localDateForApi(new Date()));
        if (!mountedRef.current || clientRef.current !== current) return false;
        setInventory(data);
        setReadError(null);
        return true;
      } catch (error) {
        if (!mountedRef.current || clientRef.current !== current || isAbortError(error)) {
          return false;
        }
        if (error instanceof AdminApiError && error.status === 401) {
          lock("管理密钥无效或已撤销，请重新输入。当前页面数据已清除。");
          return false;
        }
        setReadError(errorMessage(error));
        return false;
      }
    })();

    const active = { client: current, operation };
    activeRefreshRef.current = active;
    void operation.finally(() => {
      if (activeRefreshRef.current === active) activeRefreshRef.current = null;
    });
    return operation;
  }, [lock]);

  useEffect(() => {
    mountedRef.current = true;
    const clearForPageExit = (): void => {
      destroyClient();
      setClient(null);
      setInventory(null);
      setReadError(null);
      setStatusMessage(null);
      setPhase("locked");
      setUnlockMessage("页面离开后管理密钥已从内存清除，请重新输入。");
    };
    const clearAfterHistoryRestore = (event: PageTransitionEvent): void => {
      if (event.persisted) clearForPageExit();
    };
    window.addEventListener("pagehide", clearForPageExit);
    window.addEventListener("beforeunload", clearForPageExit);
    window.addEventListener("pageshow", clearAfterHistoryRestore);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("pagehide", clearForPageExit);
      window.removeEventListener("beforeunload", clearForPageExit);
      window.removeEventListener("pageshow", clearAfterHistoryRestore);
      destroyClient();
    };
  }, [destroyClient]);

  return {
    phase,
    client,
    inventory,
    unlockMessage,
    readError,
    statusMessage,
    unlock,
    lock,
    refresh,
    setStatusMessage,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  if (error instanceof TypeError) {
    return "无法连接 Beautio 服务，请确认本地服务正在运行。";
  }
  return "发生了未知错误，请稍后再试。";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

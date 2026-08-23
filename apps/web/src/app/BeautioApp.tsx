import { useEffect, useRef, useState } from "react";
import { InventoryPage } from "../features/inventory/InventoryPage.tsx";
import { LoginPage } from "../features/session/LoginPage.tsx";
import { useAdminInventorySession } from "../features/session/useAdminInventorySession.ts";

/**
 * 围绕单个内存 Admin 会话组合 Beautio 的锁定态与已认证界面。
 * Composes Beautio's locked and authenticated surfaces around one in-memory Admin session.
 *
 * @returns 当前应用页面，并包含恢复刷新与会话清理行为。 / The current application page with resume refresh and session cleanup behavior.
 */
export function BeautioApp() {
  const session = useAdminInventorySession();
  const [dialogOpen, setDialogOpen] = useState(false);
  const lastResumeRefreshAt = useRef(0);

  useEffect(() => {
    const refreshAfterResume = (): void => {
      if (
        document.visibilityState !== "visible" ||
        session.phase !== "unlocked" ||
        dialogOpen
      ) {
        return;
      }
      const now = Date.now();
      if (now - lastResumeRefreshAt.current < 1_000) return;
      lastResumeRefreshAt.current = now;
      void session.refresh();
    };
    window.addEventListener("focus", refreshAfterResume);
    document.addEventListener("visibilitychange", refreshAfterResume);
    return () => {
      window.removeEventListener("focus", refreshAfterResume);
      document.removeEventListener("visibilitychange", refreshAfterResume);
    };
  }, [dialogOpen, session.phase, session.refresh]);

  if (
    session.phase !== "unlocked" ||
    session.client === null ||
    session.inventory === null
  ) {
    return (
      <LoginPage
        busy={session.phase === "unlocking"}
        message={session.unlockMessage}
        onUnlock={session.unlock}
      />
    );
  }

  return (
    <InventoryPage
      client={session.client}
      inventory={session.inventory}
      readError={session.readError}
      statusMessage={session.statusMessage}
      onStatusMessage={session.setStatusMessage}
      onRefresh={session.refresh}
      onLock={session.lock}
      onDialogOpenChange={setDialogOpen}
    />
  );
}

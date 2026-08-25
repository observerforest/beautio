import { useEffect, useRef, useState } from "react";
import { AdminApiClient, AdminApiError, type PrivateImageVariant } from "../../admin-api.ts";
import type { ProductImageChoice } from "./view-model.ts";

export type ProductImageState =
  | { readonly status: "empty"; readonly src: null }
  | { readonly status: "loading"; readonly src: null }
  | { readonly status: "ready"; readonly src: string }
  | { readonly status: "error"; readonly src: null };

/**
 * 解析一个允许的 Product 图片来源，并在清理阶段释放受管 Blob URL。
 * Resolves one allowed Product image source and revokes managed Blob URLs on cleanup.
 *
 * @param client - 当前标签页范围内的 Admin API 客户端。 / Active tab-scoped Admin API client.
 * @param choice - 受管、旧版或缺失的图片投影。 / Managed, legacy, or absent image projection.
 * @param variant - 卡片缩略图或受管图片原图。 / Card rendition or full original managed image.
 * @param onUnauthorized - 图片请求返回 401 时的会话锁定回调。 / Session-lock callback for an image 401.
 * @returns 当前加载状态，以及供渲染图片报告解码失败的入口。 / Current loading state and a way for the rendered image to report decode failure.
 */
export function useProductImage(
  client: AdminApiClient,
  choice: ProductImageChoice,
  variant: PrivateImageVariant,
  onUnauthorized: (message: string) => void,
): ProductImageState & { readonly reportError: () => void } {
  const [state, setState] = useState<ProductImageState>(() => initialState(choice));
  const unauthorizedRef = useRef(onUnauthorized);
  const activeObjectUrlRef = useRef<string | null>(null);
  unauthorizedRef.current = onUnauthorized;
  const managedImageAssetId = choice.kind === "managed" ? choice.imageAssetId : null;
  const legacyImageRef = choice.kind === "legacy" ? choice.imageRef : null;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    if (managedImageAssetId === null) {
      setState(
        legacyImageRef === null
          ? { status: "empty", src: null }
          : { status: "ready", src: legacyImageRef },
      );
      return;
    }

    setState({ status: "loading", src: null });
    void client
      .loadPrivateImage(managedImageAssetId, variant)
      .then((loadedObjectUrl) => {
        if (cancelled) {
          client.revokeObjectUrl(loadedObjectUrl);
          return;
        }
        objectUrl = loadedObjectUrl;
        activeObjectUrlRef.current = loadedObjectUrl;
        setState({ status: "ready", src: loadedObjectUrl });
      })
      .catch((error: unknown) => {
        if (cancelled || isAbortError(error)) return;
        if (error instanceof AdminApiError && error.status === 401) {
          unauthorizedRef.current(
            "管理密钥无效或已撤销，请重新输入。私有图片没有继续加载。",
          );
          return;
        }
        setState({ status: "error", src: null });
      });

    return () => {
      cancelled = true;
      if (objectUrl !== null) {
        client.revokeObjectUrl(objectUrl);
        if (activeObjectUrlRef.current === objectUrl) activeObjectUrlRef.current = null;
      }
    };
  }, [client, legacyImageRef, managedImageAssetId, variant]);

  return {
    ...state,
    reportError: () => {
      const objectUrl = activeObjectUrlRef.current;
      if (objectUrl !== null) {
        client.revokeObjectUrl(objectUrl);
        activeObjectUrlRef.current = null;
      }
      setState({ status: "error", src: null });
    },
  };
}

function initialState(choice: ProductImageChoice): ProductImageState {
  if (choice.kind === "none") return { status: "empty", src: null };
  if (choice.kind === "legacy") return { status: "ready", src: choice.imageRef };
  return { status: "loading", src: null };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

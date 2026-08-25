import { AdminApiClient, type PrivateImageVariant } from "../../admin-api.ts";
import type { ProductImageChoice } from "./view-model.ts";
import { useProductImage } from "./useProductImage.ts";

export interface ProductImageProps {
  readonly client: AdminApiClient;
  readonly choice: ProductImageChoice;
  readonly alt: string;
  readonly variant: PrivateImageVariant;
  readonly className?: string;
  readonly placeholderClassName?: string;
  readonly onUnauthorized: (message: string) => void;
}

/**
 * 呈现受管或旧版 Product 图片，并明确区分私有图片的各类状态。
 * Renders a managed or legacy Product image with explicit private-image states.
 *
 * @param props - 图片来源投影、已认证客户端、展示配置和锁定回调。 / Image source projection, authenticated client, presentation, and lock callback.
 * @returns 图片、加载状态，或如实说明缺失与错误的占位内容。 / An image, loading state, or factual missing/error placeholder.
 */
export function ProductImage({
  client,
  choice,
  alt,
  variant,
  className = "h-full w-full object-cover",
  placeholderClassName = "h-full w-full",
  onUnauthorized,
}: ProductImageProps) {
  const image = useProductImage(client, choice, variant, onUnauthorized);
  if (image.status === "ready") {
    return (
      <img
        src={image.src}
        alt={alt}
        className={className}
        loading={variant === "card" ? "lazy" : "eager"}
        decoding="async"
        onError={image.reportError}
      />
    );
  }

  const copy = {
    empty: "暂无图片",
    loading: "正在读取图片",
    error: "图片读取失败",
  }[image.status];
  return (
    <div
      className={`flex items-center justify-center bg-[linear-gradient(145deg,#F8F5F3,#EEE9E6)] ${placeholderClassName}`}
      role="img"
      aria-label={copy}
    >
      <div className="flex flex-col items-center gap-2 text-[#B9B1AD]">
        <span className="flex size-10 items-center justify-center rounded-full bg-[linear-gradient(135deg,#E5D8CF,#D5D2CF)] text-sm font-light text-white">
          B
        </span>
        <span className="text-[9px] tracking-wide">{copy}</span>
      </div>
    </div>
  );
}

import { useEffect, useId, useRef } from "react";
import { Icon } from "../../components/Icon.tsx";

export interface ImageViewerProps {
  readonly title: string;
  readonly src: string;
  readonly onClose: () => void;
}

/**
 * 在专用的深色原生对话框中展示已加载的私有原图。
 * Shows a loaded private original in a dedicated dark native dialog.
 *
 * @param props - 图片标题、已授权的 Blob URL 和关闭回调。 / Image title, already-authorized Blob URL, and close callback.
 * @returns 不创建或持久化额外图片 URL 的全屏查看器。 / Full-screen viewer that does not create or persist another image URL.
 */
export function ImageViewer({ title, src, onClose }: ImageViewerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="beautio-fullscreen-viewer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-full min-h-0 flex-col" onClick={(event) => event.stopPropagation()}>
        <header className="flex shrink-0 items-center justify-between px-5 py-4 text-white">
          <h2 id={titleId} className="truncate pr-4 text-sm font-medium">{title}</h2>
          <button type="button" onClick={onClose} className="flex size-10 items-center justify-center rounded-full bg-white/10" aria-label="关闭完整原图">
            <Icon name="x" className="size-5" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-5">
          <img src={src} alt={`${title}的完整原图`} className="max-h-full max-w-full object-contain" />
        </div>
        <p className="shrink-0 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-xs text-white/55">
          显示未经卡片裁边的完整原图；可使用浏览器缩放查看细节。
        </p>
      </div>
    </dialog>
  );
}

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";

export interface ModalShellProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly hero?: ReactNode;
  readonly busy?: boolean;
  readonly wide?: boolean;
  readonly onClose: () => void;
}

/**
 * 承载原生模态对话框，同时保留 Figma 的底部抽屉与桌面卡片几何形态。
 * Hosts a native modal dialog while preserving the Figma bottom-sheet and desktop-card geometry.
 *
 * @param props - 对话框文案、正文、可选首屏/页脚、忙碌状态与关闭回调。 / Dialog copy, body, optional hero/footer, busy state, and close callback.
 * @returns 可访问模态框；写入进行时会阻止 Escape 与背景点击关闭。 / An accessible modal that blocks Escape and backdrop dismissal while a write is pending.
 */
export function ModalShell({
  title,
  subtitle,
  children,
  footer,
  hero,
  busy = false,
  wide = false,
  onClose,
}: ModalShellProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="beautio-dialog"
      aria-labelledby={titleId}
      aria-busy={busy}
      onCancel={(event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className={`beautio-dialog-surface ${wide ? "beautio-dialog-surface-wide" : ""}`}
        onClick={(event) => event.stopPropagation()}
      >
        {hero === undefined ? null : <h2 id={titleId} className="sr-only">{title}</h2>}
        {hero ?? (
          <header className="flex shrink-0 items-start justify-between border-b border-[#F2EFED] px-5 pb-4 pt-5">
            <div className="min-w-0 pr-4">
              {subtitle === undefined ? null : (
                <p className="mb-0.5 text-[10px] text-[#A8A3A0]">{subtitle}</p>
              )}
              <h2 id={titleId} className="break-words text-base font-semibold leading-snug text-[#5A4C4A]">
                {title}
              </h2>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#F5F3F1] text-[#A8A3A0] transition-colors hover:bg-[#EEE9E6] disabled:opacity-45"
              aria-label="关闭"
            >
              <Icon name="x" />
            </button>
          </header>
        )}
        <div className="beautio-scrollbar min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer === undefined ? null : (
          <footer className="shrink-0 border-t border-[#F2EFED] bg-white px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3">
            {footer}
          </footer>
        )}
      </section>
    </dialog>
  );
}

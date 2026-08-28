import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";

const MOBILE_DIALOG_EXIT_FALLBACK_MS = 400;

type ModalShellSlot = ReactNode | ((requestClose: () => void) => ReactNode);

interface DocumentScrollSnapshot {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly rootOverflow: string;
  readonly rootOverscrollBehavior: string;
  readonly bodyPosition: string;
  readonly bodyTop: string;
  readonly bodyLeft: string;
  readonly bodyWidth: string;
  readonly bodyOverflow: string;
  readonly bodyOverscrollBehavior: string;
  readonly bodyPaddingRight: string;
}

let documentScrollLockCount = 0;
let documentScrollSnapshot: DocumentScrollSnapshot | null = null;

function lockDocumentScroll(): () => void {
  if (documentScrollLockCount === 0) {
    const root = document.documentElement;
    const body = document.body;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const scrollbarWidth = Math.max(0, window.innerWidth - root.clientWidth);
    documentScrollSnapshot = {
      scrollX,
      scrollY,
      rootOverflow: root.style.overflow,
      rootOverscrollBehavior: root.style.overscrollBehavior,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyWidth: body.style.width,
      bodyOverflow: body.style.overflow,
      bodyOverscrollBehavior: body.style.overscrollBehavior,
      bodyPaddingRight: body.style.paddingRight,
    };
    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "none";
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = `-${scrollX}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    if (scrollbarWidth > 0) {
      const currentPaddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;
      body.style.paddingRight = `${currentPaddingRight + scrollbarWidth}px`;
    }
  }

  documentScrollLockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    documentScrollLockCount = Math.max(0, documentScrollLockCount - 1);
    if (documentScrollLockCount !== 0 || documentScrollSnapshot === null) return;

    const snapshot = documentScrollSnapshot;
    documentScrollSnapshot = null;
    const root = document.documentElement;
    const body = document.body;
    root.style.overflow = snapshot.rootOverflow;
    root.style.overscrollBehavior = snapshot.rootOverscrollBehavior;
    body.style.position = snapshot.bodyPosition;
    body.style.top = snapshot.bodyTop;
    body.style.left = snapshot.bodyLeft;
    body.style.width = snapshot.bodyWidth;
    body.style.overflow = snapshot.bodyOverflow;
    body.style.overscrollBehavior = snapshot.bodyOverscrollBehavior;
    body.style.paddingRight = snapshot.bodyPaddingRight;
    window.scrollTo(snapshot.scrollX, snapshot.scrollY);
  };
}

export interface ModalShellProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
  readonly footer?: ModalShellSlot;
  readonly hero?: ModalShellSlot;
  readonly toast?: ReactNode;
  readonly busy?: boolean;
  readonly wide?: boolean;
  readonly onClose: () => void;
}

/**
 * 承载原生模态对话框，同时保留 Figma 的底部抽屉与桌面卡片几何形态。
 * Hosts a native modal dialog while preserving the Figma bottom-sheet and desktop-card geometry.
 *
 * @param props - 对话框文案、正文、可选首屏/页脚/浮层提示、忙碌状态与关闭回调；可选区域可通过渲染函数接入统一关闭流程。 / Dialog copy, body, optional hero/footer/overlay notice, busy state, and close callback; optional slots can join the shared close flow through render functions.
 * @returns 可访问模态框；写入进行时会阻止 Escape 与背景点击关闭。 / An accessible modal that blocks Escape and backdrop dismissal while a write is pending.
 */
export function ModalShell({
  title,
  subtitle,
  children,
  footer,
  hero,
  toast,
  busy = false,
  wide = false,
  onClose,
}: ModalShellProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeFallbackTimerRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  const closeFinishedRef = useRef(false);
  const [closing, setClosing] = useState(false);
  const titleId = useId();

  const finishClose = useCallback(() => {
    if (closeFinishedRef.current) return;
    closeFinishedRef.current = true;
    if (closeFallbackTimerRef.current !== null) {
      window.clearTimeout(closeFallbackTimerRef.current);
      closeFallbackTimerRef.current = null;
    }
    onClose();
  }, [onClose]);

  const requestClose = useCallback(() => {
    if (busy || closingRef.current) return;
    closingRef.current = true;
    const shouldAnimate = window.matchMedia("(max-width: 767px)").matches
      && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!shouldAnimate) {
      finishClose();
      return;
    }

    setClosing(true);
    closeFallbackTimerRef.current = window.setTimeout(finishClose, MOBILE_DIALOG_EXIT_FALLBACK_MS);
  }, [busy, finishClose]);

  const resolvedHero = typeof hero === "function" ? hero(requestClose) : hero;
  const resolvedFooter = typeof footer === "function" ? footer(requestClose) : footer;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const releaseScrollLock = lockDocumentScroll();
    dialog.showModal();
    return () => {
      if (closeFallbackTimerRef.current !== null) {
        window.clearTimeout(closeFallbackTimerRef.current);
        closeFallbackTimerRef.current = null;
      }
      if (dialog.open) dialog.close();
      releaseScrollLock();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="beautio-dialog"
      aria-labelledby={titleId}
      aria-busy={busy || closing}
      data-closing={closing ? "true" : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (busy) {
          return;
        }
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        className={`beautio-dialog-surface ${wide ? "beautio-dialog-surface-wide" : ""}`}
        onClick={(event) => event.stopPropagation()}
        onAnimationEnd={(event) => {
          if (closing && event.animationName === "beautio-dialog-sheet-exit") finishClose();
        }}
      >
        {resolvedHero === undefined ? null : <h2 id={titleId} className="sr-only">{title}</h2>}
        {resolvedHero ?? (
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
              disabled={busy || closing}
              onClick={requestClose}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/20 text-[#7A7572] shadow-[0_2px_10px_rgba(90,76,74,0.16)] backdrop-blur transition-colors hover:bg-white/35 disabled:opacity-45"
              aria-label="关闭"
            >
              <Icon name="x" />
            </button>
          </header>
        )}
        <div className="beautio-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {resolvedFooter === undefined ? null : (
          <footer className="shrink-0 border-t border-[#F2EFED] bg-white px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3">
            {resolvedFooter}
          </footer>
        )}
      </section>
      {toast}
    </dialog>
  );
}

import type { ReactNode } from "react";
import { Icon } from "./Icon.tsx";

export interface ToastViewportProps {
  readonly children: ReactNode;
}

/**
 * 在视口顶层堆叠非阻塞通知，不参与页面或弹窗的文档流布局。
 * Stacks non-blocking notices at the viewport edge without entering page or dialog layout flow.
 *
 * @param props - 需要叠放的 toast 内容。 / Toast content to stack.
 * @returns 固定定位且仅让通知本身接收点击的 toast 容器。 / A fixed viewport whose notices alone receive pointer input.
 */
export function ToastViewport({ children }: ToastViewportProps) {
  return (
    <div className="pointer-events-none fixed inset-x-4 top-[max(1rem,env(safe-area-inset-top))] z-[100] flex flex-col items-center gap-2 md:left-auto md:right-6 md:w-[440px]">
      {children}
    </div>
  );
}

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastProps {
  readonly message: string;
  readonly tone?: "error" | "info";
  readonly action?: ToastAction;
  readonly onDismiss?: () => void;
}

/**
 * 呈现带可选操作和关闭入口的无障碍浮层通知。
 * Renders an accessible floating notice with optional action and dismissal controls.
 *
 * @param props - 通知文案、语气、可选操作与关闭回调。 / Notice copy, tone, optional action, and dismiss callback.
 * @returns 不改变周围几何布局的 toast 卡片。 / A toast card that does not alter surrounding geometry.
 */
export function Toast({ message, tone = "error", action, onDismiss }: ToastProps) {
  const error = tone === "error";
  return (
    <div
      className={`pointer-events-auto flex w-full items-start gap-3 rounded-2xl border px-4 py-3 shadow-[0_12px_40px_rgba(90,76,74,0.18)] backdrop-blur ${
        error
          ? "border-[#E8C8CB] bg-[#FFF8F8]/95 text-[#8F424C]"
          : "border-[#D7E0E7] bg-[#F8FAFC]/95 text-[#4A6272]"
      }`}
      role={error ? "alert" : "status"}
      aria-live={error ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <Icon name="info" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
        <p className="min-w-0 flex-1 break-words text-sm leading-relaxed">{message}</p>
        {action === undefined ? null : (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-2 shrink-0 rounded-full bg-white px-3 py-1.5 text-xs shadow-sm sm:mt-0"
          >
            {action.label}
          </button>
        )}
      </div>
      {onDismiss === undefined ? null : (
        <button
          type="button"
          onClick={onDismiss}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-current opacity-65 transition-opacity hover:opacity-100"
          aria-label="关闭提示"
        >
          <Icon name="x" className="size-3.5" />
        </button>
      )}
    </div>
  );
}

import type { ReactNode } from "react";
import { Icon } from "../../components/Icon.tsx";

export interface ScopeNoticeProps {
  readonly shared: boolean;
  readonly children: ReactNode;
}

/**
 * 标明一次编辑会影响共享 Product，还是只影响一瓶实体库存。
 * Marks whether an edit affects a shared Product or only one physical bottle.
 *
 * @param props - 作用域分类与说明文案。 / Scope classification and explanatory copy.
 * @returns 明确表达作用域语义的低干扰 Figma 提示。 / A calm Figma notice with explicit scope semantics.
 */
export function ScopeNotice({ shared, children }: ScopeNoticeProps) {
  return (
    <aside
      className={`flex items-center gap-2 rounded-2xl px-3 py-2.5 text-[11px] leading-snug ${
        shared ? "bg-[#EEF1F4] text-[#4A6272]" : "bg-[#FBF6F5] text-[#7A6260]"
      }`}
    >
      <Icon name="info" className="size-3.5 shrink-0" />
      <p>{children}</p>
    </aside>
  );
}

export interface EditorFooterProps {
  readonly shared: boolean;
  readonly notice: string;
  readonly progress: string;
  readonly formId: string;
  readonly saveLabel: string;
  readonly busy: boolean;
  readonly saveDisabled: boolean;
  readonly onCancel: () => void;
}

/**
 * 以 Figma 的单行底栏呈现编辑作用域、取消和保存操作，并保留无障碍进度播报。
 * Renders the Figma single-row editor footer with scope, cancel, and save actions while retaining accessible progress announcements.
 *
 * @param props - 作用域文案、保存状态、目标表单、按钮文案与取消回调。 / Scope copy, save state, target form, button copy, and cancel callback.
 * @returns 不额外占用视觉行的编辑弹窗底栏。 / An editor footer without extra visible status rows.
 */
export function EditorFooter({
  shared,
  notice,
  progress,
  formId,
  saveLabel,
  busy,
  saveDisabled,
  onCancel,
}: EditorFooterProps) {
  return (
    <div className="flex items-center gap-3">
      <div className={`flex min-w-0 flex-1 items-center gap-1.5 text-[11px] leading-snug ${shared ? "text-[#4A6272]" : "text-[#7A6260]"}`}>
        <Icon name="info" className="size-3.5 shrink-0" />
        <p>{notice}</p>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{progress}</p>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="shrink-0 rounded-2xl px-4 py-2.5 text-sm text-[#A8A3A0] disabled:opacity-45"
      >
        取消
      </button>
      <button
        type="submit"
        form={formId}
        disabled={saveDisabled}
        className="shrink-0 rounded-2xl bg-[linear-gradient(120deg,#9B7F7C,#B3A0AD)] px-5 py-2.5 text-sm font-medium text-white disabled:opacity-45"
      >
        {busy ? "保存中…" : saveLabel}
      </button>
    </div>
  );
}

export interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly counter?: string;
  readonly children: ReactNode;
}

/**
 * 用可见标签、可选提示与计数器包裹原生表单控件。
 * Wraps a native form control with a visible label, optional hint, and counter.
 *
 * @param props - 标签、帮助文字、计数文字与一个原生控件。 / Label copy, help text, count text, and one native control.
 * @returns 不替换原生语义的一致编辑字段。 / A consistent editor field without replacing native semantics.
 */
export function Field({ label, hint, counter, children }: FieldProps) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-xs font-medium text-[#A8A3A0]">{label}</span>
      {children}
      {hint === undefined && counter === undefined ? null : (
        <span className="mt-1 flex items-start justify-between gap-3 text-[10px] leading-relaxed text-[#A8A3A0]">
          <span>{hint}</span>
          {counter === undefined ? null : <span className="shrink-0" aria-live="polite">{counter}</span>}
        </span>
      )}
    </label>
  );
}

export const editorInputClass =
  "w-full rounded-2xl border border-[#E0DBD8] bg-white px-4 py-3 text-sm text-[#5A4C4A] outline-none transition-colors placeholder:text-stone-300 disabled:opacity-45";

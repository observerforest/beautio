import type { InventoryListItemOutput } from "@beautio/contracts";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  AdminApiClient,
  AdminApiError,
  type InventoryItemFactsInput,
  type OpenedOnAccuracy,
} from "../../admin-api.ts";
import { ModalShell } from "../../components/ModalShell.tsx";
import { SelectMenu, type SelectMenuOption } from "../../components/SelectMenu.tsx";
import { Toast, ToastViewport } from "../../components/Toast.tsx";
import { isAbortError } from "../../utils/is-abort-error.ts";
import { localDateForApi } from "../../utils/local-date-for-api.ts";
import { canPreserveLegacyAccuracy, openedOnAccuracy, paoDeadlineAccuracy, usabilityLabel } from "./models/index.ts";
import { EditorDateInput, EditorFooter, editorInputClass, Field } from "./EditorPrimitives.tsx";
import { dateWithAccuracy, displayValue, inventoryErrorMessage } from "./utils/inventory-format.ts";
import { useI18n } from "../../i18n.tsx";

export interface BottleEditorDialogProps {
  readonly item: InventoryListItemOutput;
  readonly initialLifecycle: "unopened" | "opened";
  readonly client: AdminApiClient;
  readonly onCancel: () => void;
  readonly onCommitted: (inventoryItemId: string, message: string) => Promise<boolean>;
  readonly onUnauthorized: (message: string) => void;
}

/**
 * 解析酒瓶编辑器中的可选正整数字段，不强制转换无效草稿。
 * Parses an optional positive integer field in the bottle editor without coercing invalid drafts.
 *
 * @param value - 浏览器输入框的当前值。 / Current browser input value.
 * @returns 空字段返回 null，合法值返回正整数，无效输入返回 undefined。 / Null for an empty field, a positive integer, or undefined for invalid input.
 */
function nullablePositiveInteger(value: string): number | null | undefined {
  if (value.length === 0) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 只编辑一瓶在库酒的直接生命周期事实，所有派生值保持只读。
 * Edits only one active bottle's direct lifecycle facts and leaves all derived values read-only.
 *
 * @param props - 现有酒瓶、已认证客户端、取消与刷新操作，以及锁定回调。 / Existing bottle, authenticated client, cancel/refresh operations, and lock callback.
 * @returns 适用于未开封或已开封状态、经过校验的 Figma 酒瓶编辑器。 / A validated Figma bottle editor for unopened or opened lifecycle states.
 */
export function BottleEditorDialog({
  item,
  initialLifecycle,
  client,
  onCancel,
  onCommitted,
  onUnauthorized,
}: BottleEditorDialogProps) {
  const { t } = useI18n();
  const formId = useId();
  const openedDateRef = useRef<HTMLInputElement>(null);
  const accuracyRef = useRef<HTMLButtonElement>(null);
  const paoRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const [lifecycle, setLifecycle] = useState<"unopened" | "opened">(initialLifecycle);
  const [openedOn, setOpenedOn] = useState(item.opened_on ?? "");
  const [accuracy, setAccuracy] = useState<OpenedOnAccuracy | "">(openedOnAccuracy(item) ?? "");
  const [expiresOn, setExpiresOn] = useState(item.expires_on ?? "");
  const [pao, setPao] = useState(item.pao_duration_months === null ? "" : String(item.pao_duration_months));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(t("派生字段不会随表单提交。"));
  const [error, setError] = useState("");
  const [writeCompleted, setWriteCompleted] = useState(false);
  const legacyAllowed = canPreserveLegacyAccuracy(item, lifecycle, openedOn || null);
  const lifecycleOptions: readonly SelectMenuOption<"unopened" | "opened">[] = [
    { value: "unopened", label: t("未开封") },
    { value: "opened", label: t("已开封") },
  ];
  const accuracyOptions: readonly SelectMenuOption<OpenedOnAccuracy | "">[] = [
    { value: "", label: t("请选择日期准确性") },
    { value: "exact", label: t("准确日期") },
    { value: "estimated", label: t("估算日期") },
    ...(legacyAllowed ? [{ value: "legacy_unknown" as const, label: t("保留历史记录的未知准确性") }] : []),
  ];

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setLifecycleAndOpening = (next: "unopened" | "opened"): void => {
    setLifecycle(next);
    if (next === "unopened") {
      setOpenedOn("");
      setAccuracy("");
    }
  };

  useEffect(() => {
    if (accuracy === "legacy_unknown" && !legacyAllowed) setAccuracy("");
  }, [accuracy, legacyAllowed]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy || writeCompleted) return;
    const normalizedOpenedOn = openedOn.length === 0 ? null : openedOn;
    let normalizedAccuracy: OpenedOnAccuracy | null = null;
    if (lifecycle === "opened") {
      if (normalizedOpenedOn === null) {
        setError(t("已开封库存必须填写开封日期。"));
        openedDateRef.current?.focus();
        return;
      }
      if (accuracy === "exact" || accuracy === "estimated") {
        normalizedAccuracy = accuracy;
      } else if (accuracy === "legacy_unknown" && legacyAllowed) {
        normalizedAccuracy = accuracy;
      } else {
        setError(t("请选择准确日期或估算日期。"));
        accuracyRef.current?.focus();
        return;
      }
    }
    const paoMonths = nullablePositiveInteger(pao);
    if (paoMonths === undefined || (paoMonths !== null && paoMonths > 120)) {
      setError(t("PAO 必须是 1–120 的整数，或留空。"));
      paoRef.current?.focus();
      return;
    }
    const input: InventoryItemFactsInput = {
      as_of: localDateForApi(new Date()),
      lifecycle_status: lifecycle,
      opened_on: lifecycle === "opened" ? normalizedOpenedOn : null,
      opened_on_accuracy: lifecycle === "opened" ? normalizedAccuracy : null,
      expires_on: expiresOn.length === 0 ? null : expiresOn,
      pao_duration_months: paoMonths,
    };
    void save(input);
  };

  const save = async (input: InventoryItemFactsInput): Promise<void> => {
    setBusy(true);
    setError("");
    setProgress(t("正在保存单瓶事实并重新计算…"));
    try {
      await client.updateInventoryItemFacts(item.inventory_item_id, input);
      setWriteCompleted(true);
      setProgress(t("单瓶事实已保存，正在重新读取服务端结果…"));
      const refreshed = await onCommitted(item.inventory_item_id, t("单瓶事实已保存；PAO 截止日、最终可用日和状态已重新读取。"));
      if (!refreshed && mountedRef.current) {
        setError(t("保存请求已经完成，但重新读取失败。请先重试读取确认结果，不要重复保存。"));
        setProgress(t("等待重新读取确认。"));
      }
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onUnauthorized(t("管理密钥无效或已撤销，请重新输入。此次修改没有保存。"));
        return;
      }
      if (!isAbortError(caught) && mountedRef.current) {
        setError(inventoryErrorMessage(caught, t));
        setProgress(t("保存失败，页面中的输入仍保留。"));
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const footer = (requestClose: () => void) => (
    <EditorFooter
      shared={false}
      notice={t("仅对当前这一瓶生效，不影响其他瓶或产品资料")}
      progress={progress}
      formId={formId}
      saveLabel={t("保存这瓶")}
      busy={busy}
      saveDisabled={busy || writeCompleted}
      onCancel={requestClose}
    />
  );

  return (
    <ModalShell
      title={item.product?.name ?? t("未记录产品名称")}
      subtitle={t("编辑这瓶")}
      footer={footer}
      busy={busy}
      animateMobileEnter={false}
      animateMobileExit={false}
      onClose={onCancel}
      toast={error.length === 0 ? null : (
        <ToastViewport><Toast message={error} onDismiss={() => setError("")} /></ToastViewport>
      )}
    >
      <form id={formId} onSubmit={handleSubmit} className="min-w-0 w-full space-y-5 px-5 py-5" noValidate>
        <fieldset disabled={busy || writeCompleted} className="min-w-0 w-full space-y-5 disabled:opacity-70">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t("生命周期")}>
              <SelectMenu
                value={lifecycle}
                options={lifecycleOptions}
                onChange={setLifecycleAndOpening}
                ariaLabel={t("生命周期")}
                className="w-full"
                buttonClassName={`${editorInputClass} flex items-center justify-between gap-3 text-left`}
                menuClassName="left-0 right-0 max-h-64 overflow-y-auto"
              />
            </Field>
            <Field label={t("开封日期")} hint={t("已开封时必填；未开封时会清空。")}>
              <EditorDateInput inputRef={openedDateRef} value={openedOn} onChange={(event) => setOpenedOn(event.target.value)} disabled={lifecycle !== "opened"} />
            </Field>
            <Field label={t("开封日期准确性")} hint={t("估算必须明确标记。")}>
              <SelectMenu
                value={accuracy}
                options={accuracyOptions}
                onChange={setAccuracy}
                ariaLabel={t("开封日期准确性")}
                disabled={lifecycle !== "opened"}
                triggerRef={accuracyRef}
                className="w-full"
                buttonClassName={`${editorInputClass} flex items-center justify-between gap-3 text-left`}
                menuClassName="left-0 right-0 max-h-64 overflow-y-auto"
              />
            </Field>
            <Field label={t("包装过期日")} hint={t("没有记录时留空。")}>
              <EditorDateInput value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
            </Field>
            <Field label={t("PAO（月）")} hint={t("整数 1–120；没有记录时留空。")}>
              <input ref={paoRef} type="number" min="1" max="120" step="1" inputMode="numeric" value={pao} onChange={(event) => setPao(event.target.value)} className={editorInputClass} />
            </Field>
          </div>
          <section className="space-y-1 rounded-2xl bg-[#F5F3F1] px-4 py-3.5 text-xs leading-relaxed text-[#A8A3A0]">
            <strong className="block text-[#5A4C4A]">{t("当前只读派生值")}</strong>
            <p>{t("PAO 截止日")}: {dateWithAccuracy(item.pao_deadline, paoDeadlineAccuracy(item), t)}</p>
            <p>{t("最终可用至")}: {t(displayValue(item.usable_until))}</p>
            <p>{t("可用状态")}: {t(usabilityLabel(item.usability_status))}</p>
          </section>
        </fieldset>
      </form>
    </ModalShell>
  );
}

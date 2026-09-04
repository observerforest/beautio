import type { InventoryListItemOutput } from "@beautio/contracts";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  AdminApiClient,
  AdminApiError,
  type EndUseInput,
} from "../../admin-api.ts";
import { ModalShell } from "../../components/ModalShell.tsx";
import { Toast, ToastViewport } from "../../components/Toast.tsx";
import { useI18n } from "../../i18n.tsx";
import { isAbortError } from "../../utils/is-abort-error.ts";
import { localDateForApi } from "../../utils/local-date-for-api.ts";
import { EditorFooter, ScopeNotice } from "./EditorPrimitives.tsx";
import {
  buildEndUseInput,
  emptyEndUseDraft,
  endUseQuickPercentages,
  type EndUseDraft,
  type EndUseTargetLifecycle,
} from "./models/end-use-model.ts";
import { inventoryErrorMessage } from "./utils/inventory-format.ts";

type EndUseOutcome = "editable" | "committed" | "stale" | "uncertain";

export interface EndUseDialogProps {
  readonly item: InventoryListItemOutput;
  readonly client: AdminApiClient;
  readonly onCancel: (message?: string) => void;
  readonly onCommitted: (
    inventoryItemId: string,
    message: string,
  ) => Promise<boolean>;
  readonly onUnauthorized: (message: string) => void;
}

/**
 * Ends one opened bottle through an explicit terminal lifecycle and atomic remaining snapshot.
 *
 * @param props - Opened inventory, authenticated client, refresh/cancel callbacks,
 * and the session-lock callback used when authorization expires.
 * @returns A responsive confirmation dialog that never resends a committed or
 * uncertain write; recovery after either condition performs inventory reads only.
 */
export function EndUseDialog({
  item,
  client,
  onCancel,
  onCommitted,
  onUnauthorized,
}: EndUseDialogProps) {
  const { locale, t } = useI18n();
  const formId = useId();
  const lifecycleRef = useRef<HTMLButtonElement>(null);
  const remainingRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const operationRef = useRef(false);
  const submissionLockedRef = useRef(false);
  const [draft, setDraft] = useState<EndUseDraft>(emptyEndUseDraft);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<EndUseOutcome>("editable");
  const [progress, setProgress] = useState(
    t("请选择结束方式与剩余量；提交前不会修改库存。"),
  );
  const [error, setError] = useState("");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const updateLifecycleStatus = (
    lifecycleStatus: EndUseTargetLifecycle,
  ): void => {
    setDraft((current) => ({ ...current, lifecycleStatus }));
    setError("");
  };

  const selectEstimate = (remainingPercent: number): void => {
    setDraft((current) => ({
      ...current,
      remainingSelection: "estimate",
      remainingPercent,
    }));
    setError("");
  };

  const selectUnknown = (): void => {
    setDraft((current) => ({
      ...current,
      remainingSelection: "unknown",
    }));
    setError("");
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (operationRef.current || submissionLockedRef.current) return;
    const built = buildEndUseInput(draft, localDateForApi(new Date()));
    if (!built.ok) {
      setError(t(built.message));
      if (built.field === "lifecycle") lifecycleRef.current?.focus();
      else remainingRef.current?.focus();
      return;
    }
    operationRef.current = true;
    void save(built.input);
  };

  const save = async (input: EndUseInput): Promise<void> => {
    setBusy(true);
    setError("");
    setProgress(t("正在结束当前瓶的使用…"));
    try {
      await client.endInventoryItem(item.inventory_item_id, input);
      submissionLockedRef.current = true;
      if (!mountedRef.current) return;
      setOutcome("committed");
      setProgress(t("结束使用已写入，正在重新读取库存…"));
      try {
        const refreshed = await onCommitted(
          item.inventory_item_id,
          t("这瓶已结束使用并进入已归档。"),
        );
        if (!refreshed && mountedRef.current) {
          setError(
            t("结束使用已写入，但重新读取失败。请只重试读取，不要再次提交。"),
          );
          setProgress(t("等待重新读取确认。"));
        }
      } catch {
        if (mountedRef.current) {
          setError(
            t("结束使用已写入，但重新读取失败。请只重试读取，不要再次提交。"),
          );
          setProgress(t("等待重新读取确认。"));
        }
      }
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onUnauthorized(
          t("管理密钥无效或已撤销，请重新输入。结束使用请求未获授权。"),
        );
        return;
      }
      if (isAbortError(caught) || !mountedRef.current) return;
      if (isEditableRejection(caught)) {
        setError(inventoryErrorMessage(caught, t));
        setProgress(t("结束使用没有保存，输入仍保留。"));
      } else {
        submissionLockedRef.current = true;
        const stale = isStaleRejection(caught);
        setOutcome(stale ? "stale" : "uncertain");
        setError(
          stale
            ? inventoryErrorMessage(caught, t)
            : t("结束结果暂时无法确认，可能已经写入。为避免重复，提交已锁定；请重新读取库存。"),
        );
        setProgress(
          t(stale ? "库存状态已变化，请先重新读取。" : "结束结果待核对；不会自动重发。"),
        );
      }
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const retryRead = async (): Promise<void> => {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    setError("");
    setProgress(t("正在重新读取库存，不会再次结束使用…"));
    try {
      const refreshed = await onCommitted(
        item.inventory_item_id,
        t("库存已重新读取，请核对当前生命周期与剩余量。"),
      );
      if (!refreshed && mountedRef.current) {
        setError(t("重新读取失败；本次结束操作仍保持锁定。"));
      }
    } catch {
      if (mountedRef.current) {
        setError(t("重新读取失败；本次结束操作仍保持锁定。"));
      }
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const close = (): void => {
    if (outcome === "committed") {
      onCancel(t("结束使用已写入，但页面尚未重新读取。请先刷新库存。"));
      return;
    }
    if (outcome === "uncertain") {
      onCancel(
        t("上次结束结果仍待确认，可能已写入。请先重新读取库存，避免重复提交。"),
      );
      return;
    }
    if (outcome === "stale") {
      onCancel(t("库存状态需重新读取后再决定是否结束使用。"));
      return;
    }
    onCancel();
  };

  const footer = (requestClose: () => void) =>
    outcome === "editable" ? (
      <EditorFooter
        shared={false}
        notice={t("只结束当前这一瓶；确认后会进入已归档。")}
        progress={progress}
        formId={formId}
        saveLabel={t("确认结束使用")}
        busy={busy}
        saveDisabled={busy}
        onCancel={requestClose}
      />
    ) : (
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-[#7A6260]" role="status">
          {t(
            outcome === "committed"
              ? "结束使用已经写入，不会再次提交。"
              : outcome === "uncertain"
                ? "结束结果待确认，提交已锁定。"
                : "库存状态已变化，请先重新读取。",
          )}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={requestClose}
            className="rounded-2xl px-4 py-2.5 text-xs text-[#A8A3A0] disabled:opacity-45"
          >
            {t("关闭")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void retryRead()}
            className="rounded-2xl bg-[linear-gradient(120deg,#9B7F7C,#B3A0AD)] px-5 py-2.5 text-xs text-white disabled:opacity-45"
          >
            {t(busy ? "正在读取…" : "重新读取库存")}
          </button>
        </div>
      </div>
    );

  const estimateSelected = draft.remainingSelection === "estimate";
  const remainingLabel = estimateSelected
    ? locale === "en"
      ? `${draft.remainingPercent}% remaining`
      : `剩余 ${draft.remainingPercent}%`
    : t(
        draft.remainingSelection === "unknown"
          ? "剩余量未知"
          : "剩余量尚未选择",
      );

  return (
    <ModalShell
      title={item.product?.name ?? t("未记录产品名称")}
      subtitle={t("结束使用")}
      footer={footer}
      busy={busy}
      animateMobileEnter={false}
      animateMobileExit={false}
      onClose={close}
      toast={
        error.length === 0 ? null : (
          <ToastViewport>
            <Toast message={error} onDismiss={() => setError("")} />
          </ToastViewport>
        )
      }
    >
      <form
        id={formId}
        onSubmit={handleSubmit}
        className="min-w-0 w-full space-y-5 px-5 py-5"
        noValidate
      >
        <fieldset
          disabled={busy || outcome !== "editable"}
          className="min-w-0 space-y-5 disabled:opacity-70"
        >
          <ScopeNotice shared={false}>
            {t("结束使用只改变当前瓶的生命周期并记录这一刻的剩余量。")}
          </ScopeNotice>

          <section className="space-y-2">
            <h3 className="text-xs font-medium text-[#A8A3A0]">{t("结束方式")}</h3>
            <div
              role="group"
              aria-label={t("结束方式")}
              className="grid grid-cols-2 gap-2"
            >
              {(
                [
                  ["finished", "用完", "瓶内已没有剩余"],
                  ["discarded", "丢弃", "丢弃时记录剩余量"],
                ] as const
              ).map(([lifecycleStatus, label, hint], index) => {
                const selected = draft.lifecycleStatus === lifecycleStatus;
                return (
                  <button
                    key={lifecycleStatus}
                    ref={index === 0 ? lifecycleRef : undefined}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => updateLifecycleStatus(lifecycleStatus)}
                    className={`min-w-0 rounded-2xl border px-3 py-3 text-left transition-colors ${
                      selected
                        ? "border-[#9B7F7C] bg-[#FBF6F5] text-[#5A4C4A]"
                        : "border-[#E0DBD8] bg-white text-[#7A7572]"
                    }`}
                  >
                    <span className="block text-sm font-medium">{t(label)}</span>
                    <span className="mt-0.5 block text-[10px] leading-relaxed text-[#A8A3A0]">
                      {t(hint)}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {draft.lifecycleStatus === "finished" ? (
            <section className="rounded-2xl bg-[#EEF1F4] px-4 py-3.5 text-xs leading-relaxed text-[#4A6272]">
              <strong className="block text-[#5A4C4A]">{t("结束时剩余量")}</strong>
              <p className="mt-1">{t("用完会固定记录为 0% 剩余。")}</p>
            </section>
          ) : null}

          {draft.lifecycleStatus === "discarded" ? (
            <section className="space-y-4 rounded-2xl bg-[#F8F5F3] px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xs font-medium text-[#5A4C4A]">
                    {t("结束时剩余量")}
                  </h3>
                  <p className="mt-1 text-[10px] leading-relaxed text-[#A8A3A0]">
                    {t("拖动容量条、选择快捷值，或明确选择未知。")}
                  </p>
                </div>
                <strong
                  className={`shrink-0 text-sm ${estimateSelected ? "text-[#9B7F7C]" : "text-[#A8A3A0]"}`}
                  aria-live="polite"
                >
                  {remainingLabel}
                </strong>
              </div>

              <label className="block py-1">
                <span className="sr-only">{t("估算剩余量")}</span>
                <span className="relative block h-11">
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 overflow-hidden rounded-full bg-[#E5D8CF]"
                  >
                    <span
                      className={`block h-full rounded-full bg-[linear-gradient(90deg,#B3A0AD,#9B7F7C)] transition-[width,opacity] ${estimateSelected ? "opacity-100" : "opacity-30"}`}
                      style={{ width: `${draft.remainingPercent}%` }}
                    />
                  </span>
                  <span
                    aria-hidden="true"
                    className={`absolute top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white bg-[#9B7F7C] shadow-[0_2px_8px_rgba(90,76,74,0.24)] transition-[left,opacity] ${estimateSelected ? "opacity-100" : "opacity-45"}`}
                    style={{ left: `${draft.remainingPercent}%` }}
                  />
                  <input
                    ref={remainingRef}
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={draft.remainingPercent}
                    onPointerDown={() => selectEstimate(draft.remainingPercent)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "ArrowLeft" ||
                        event.key === "ArrowRight" ||
                        event.key === "ArrowUp" ||
                        event.key === "ArrowDown" ||
                        event.key === "Home" ||
                        event.key === "End" ||
                        event.key === "PageUp" ||
                        event.key === "PageDown"
                      ) {
                        selectEstimate(draft.remainingPercent);
                      }
                    }}
                    onChange={(event) => selectEstimate(Number(event.target.value))}
                    aria-valuetext={remainingLabel}
                    className="absolute inset-0 h-11 w-full cursor-pointer opacity-0"
                  />
                </span>
              </label>

              <div className="flex flex-wrap gap-2" aria-label={t("剩余量快捷值")}>
                {endUseQuickPercentages.map((percentage) => (
                  <button
                    key={percentage}
                    type="button"
                    aria-pressed={
                      estimateSelected && draft.remainingPercent === percentage
                    }
                    onClick={() => selectEstimate(percentage)}
                    className={`min-w-12 flex-1 rounded-full border px-2 py-2 text-xs transition-colors ${
                      estimateSelected && draft.remainingPercent === percentage
                        ? "border-[#9B7F7C] bg-white text-[#9B7F7C]"
                        : "border-[#DDD9D6] bg-white/70 text-[#7A7572]"
                    }`}
                  >
                    {percentage}%
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={draft.remainingSelection === "unknown"}
                  onClick={selectUnknown}
                  className={`min-w-20 flex-1 rounded-full border px-3 py-2 text-xs transition-colors ${
                    draft.remainingSelection === "unknown"
                      ? "border-[#9B7F7C] bg-white text-[#9B7F7C]"
                      : "border-[#DDD9D6] bg-white/70 text-[#7A7572]"
                  }`}
                >
                  {t("未知")}
                </button>
              </div>
            </section>
          ) : null}
        </fieldset>
        <p className="text-[11px] leading-relaxed text-[#A8A3A0]" role="status" aria-live="polite">
          {progress}
        </p>
      </form>
    </ModalShell>
  );
}

function isEditableRejection(error: unknown): boolean {
  return (
    error instanceof AdminApiError &&
    error.status === 400 &&
    error.code === "INVALID_INPUT"
  );
}

function isStaleRejection(error: unknown): boolean {
  return (
    error instanceof AdminApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

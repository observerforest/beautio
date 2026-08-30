import type { InventoryListItemOutput } from "@beautio/contracts";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AdminApiClient, AdminApiError } from "../../admin-api.ts";
import { ModalShell } from "../../components/ModalShell.tsx";
import { Toast, ToastViewport } from "../../components/Toast.tsx";
import { isAbortError } from "../../utils/is-abort-error.ts";
import { normalizeOptionalEditorText, textCharacterCountLabel } from "../../text-fields.ts";
import { editorInputClass, EditorFooter, Field } from "./EditorPrimitives.tsx";
import { inventoryErrorMessage } from "./utils/inventory-format.ts";
import { useI18n } from "../../i18n.tsx";

const NOTES_MAXIMUM = 1_000;

export interface NotesEditorDialogProps {
  readonly item: InventoryListItemOutput;
  readonly client: AdminApiClient;
  readonly onCancel: () => void;
  readonly onCommitted: (inventoryItemId: string, message: string) => Promise<boolean>;
  readonly onUnauthorized: (message: string) => void;
}

/**
 * 只通过窄范围备注端点编辑一瓶酒的自定义备注。
 * Edits only one bottle's custom notes through the narrow notes endpoint.
 *
 * @param props - 现有条目、已认证客户端、取消与刷新操作，以及锁定回调。 / Existing item, authenticated client, cancel/refresh operations, and lock callback.
 * @returns 在终态历史记录中仍可使用的 Figma 备注编辑器。 / A Figma note editor that remains available for terminal history.
 */
export function NotesEditorDialog({ item, client, onCancel, onCommitted, onUnauthorized }: NotesEditorDialogProps) {
  const { t } = useI18n();
  const formId = useId();
  const mountedRef = useRef(true);
  const [notes, setNotes] = useState(item.custom_notes ?? "");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(t("保存只会更新当前瓶的自定义备注。"));
  const [error, setError] = useState("");
  const [writeCompleted, setWriteCompleted] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy || writeCompleted) return;
    void save();
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError("");
    setProgress(t("正在保存当前瓶的自定义备注…"));
    try {
      await client.updateInventoryItemCustomNotes(item.inventory_item_id, {
        custom_notes: normalizeOptionalEditorText(notes),
      });
      setWriteCompleted(true);
      setProgress(t("备注已保存，正在重新读取真实库存…"));
      const refreshed = await onCommitted(item.inventory_item_id, t("当前瓶的自定义备注已保存；其他库存事实已重新读取。"));
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
        setError(t(inventoryErrorMessage(caught)));
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
      saveLabel={t("保存备注")}
      busy={busy}
      saveDisabled={busy || writeCompleted}
      onCancel={requestClose}
    />
  );

  return (
    <ModalShell
      title={item.product?.name ?? t("未记录产品名称")}
      subtitle={t("编辑自定义备注")}
      footer={footer}
      busy={busy}
      animateMobileEnter={false}
      animateMobileExit={false}
      onClose={onCancel}
      toast={error.length === 0 ? null : (
        <ToastViewport><Toast message={error} onDismiss={() => setError("")} /></ToastViewport>
      )}
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-5 px-5 py-5" noValidate>
        <fieldset disabled={busy || writeCompleted} className="disabled:opacity-70">
          <Field label={t("自定义备注")} hint={t("留空并保存会清空当前瓶的备注。")} counter={textCharacterCountLabel(notes, NOTES_MAXIMUM)}>
            <textarea autoFocus value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={NOTES_MAXIMUM} rows={8} className={`${editorInputClass} min-h-44 resize-y`} />
          </Field>
        </fieldset>
      </form>
    </ModalShell>
  );
}

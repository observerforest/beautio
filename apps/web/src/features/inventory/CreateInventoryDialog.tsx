import { productAliasMaximumLength, type CreateInventoryBatchInput, type CreateInventoryBatchOutput, type InventoryListItemOutput } from "@beautio/contracts";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { AdminApiClient, AdminApiError } from "../../admin-api.ts";
import { Icon } from "../../components/Icon.tsx";
import { ModalShell } from "../../components/ModalShell.tsx";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { Toast, ToastViewport } from "../../components/Toast.tsx";
import { useI18n } from "../../i18n.tsx";
import { textCharacterCountLabel } from "../../text-fields.ts";
import { localDateForApi } from "../../utils/local-date-for-api.ts";
import { buildCreateInventoryInput, emptyCreateInventoryDraft, existingInventoryProducts, isConfirmedCreateRejection, type CreateInventoryDraft } from "./create-inventory-draft.ts";
import { EditorDateInput, EditorFooter, editorInputClass, Field, ScopeNotice } from "./EditorPrimitives.tsx";
import { inventoryErrorMessage } from "./utils/inventory-format.ts";
import { paoDurationLabel } from "./models/pao-model.ts";

export interface CreateInventoryDialogProps {
  readonly items: readonly InventoryListItemOutput[];
  readonly client: AdminApiClient;
  readonly onCancel: (message?: string) => void;
  readonly onCommitted: (result: CreateInventoryBatchOutput) => Promise<boolean>;
  readonly onRefreshInventory: () => Promise<boolean>;
  readonly onUnauthorized: (message: string) => void;
}

/**
 * Manually creates one new Product with bottles, or bottles of a selected existing Product.
 *
 * @param props - Actual inventory choices, authenticated client, close/read callbacks, and lock callback.
 * @returns A bilingual editor that uploads only on Save and blocks repeated creation after
 * success or an uncertain response; its recovery actions only read inventory.
 */
export function CreateInventoryDialog({ items, client, onCancel, onCommitted, onRefreshInventory, onUnauthorized }: CreateInventoryDialogProps) {
  const { locale, t } = useI18n();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const operationRef = useRef(false);
  const submissionLockedRef = useRef(false);
  const composingRef = useRef(false);
  const createdRef = useRef<CreateInventoryBatchOutput | null>(null);
  const [draft, setDraft] = useState(emptyCreateInventoryDraft);
  const [productQuery, setProductQuery] = useState("");
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<"editable" | "created" | "uncertain">("editable");
  const [progress, setProgress] = useState(t("保存前不会上传图片或修改数据库。"));
  const [error, setError] = useState("");
  const products = useMemo(() => existingInventoryProducts(items), [items]);
  const matchingProducts = useMemo(() => {
    const query = productQuery.trim().toLocaleLowerCase();
    return products.filter((product) => [product.name, product.alias, product.brand, product.size_label]
      .some((value) => value?.toLocaleLowerCase().includes(query)));
  }, [productQuery, products]);
  const selectedProduct = products.find((product) => product.product_id === draft.productId);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (selectedImage === null) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(selectedImage);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedImage]);

  const update = <Key extends keyof CreateInventoryDraft>(key: Key, value: CreateInventoryDraft[Key]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (operationRef.current || submissionLockedRef.current || composingRef.current) return;
    const built = buildCreateInventoryInput(draft, products, localDateForApi(new Date()));
    if (!built.ok) {
      setError(t(built.message));
      formRef.current?.querySelector<HTMLElement>(`[data-create-field="${built.field}"]`)?.focus();
      return;
    }
    // Acquire before the first await or React render, so rapid clicks cannot submit twice.
    operationRef.current = true;
    void save(built.input);
  };

  const save = async (input: CreateInventoryBatchInput): Promise<void> => {
    setBusy(true);
    setError("");
    let creating = false;
    try {
      let prepared = input;
      if (draft.mode === "new" && selectedImage !== null) {
        setProgress(t("正在上传新图片…"));
        const asset = await client.uploadProductImage(selectedImage);
        prepared = { ...input, products: input.products.map((product) => ({ ...product, image_asset_id: asset.image_asset_id })) };
      }
      if (!mountedRef.current) return;
      setProgress(t("正在新增库存…"));
      creating = true;
      const result = await client.createInventoryBatch(prepared);
      createdRef.current = result;
      submissionLockedRef.current = true;
      if (!mountedRef.current) return;
      setOutcome("created");
      setProgress(t("库存已新增，正在重新读取…"));
      try {
        if (!await onCommitted(result) && mountedRef.current) {
          setError(t("库存已新增，但重新读取失败。请只重试读取，不要再次新增。"));
        }
      } catch {
        if (mountedRef.current) setError(t("库存已新增，但重新读取失败。请只重试读取，不要再次新增。"));
      }
    } catch (caught) {
      if (!mountedRef.current) return;
      if (caught instanceof AdminApiError && caught.status === 401) {
        onUnauthorized(t("管理密钥无效或已撤销，请重新输入。新增请求未获授权。"));
        return;
      }
      if (creating && !isConfirmedCreateRejection(caught)) {
        submissionLockedRef.current = true;
        setOutcome("uncertain");
        setError(t("新增结果暂时无法确认，可能已经写入。为避免重复，本次保存已锁定；请先重新读取并核对库存。"));
        setProgress(t("新增结果待核对；不会自动重发。"));
      } else {
        setError(`${inventoryErrorMessage(caught, t)} ${t(creating ? "请求被拒绝，输入仍保留；请修正后再保存。" : "图片上传未完成，尚未发送新增请求；可以重试保存。")}`);
        setProgress(t("保存前不会上传图片或修改数据库。"));
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
    setProgress(t("正在重新读取库存，不会再次新增…"));
    try {
      const result = createdRef.current;
      const refreshed = result === null ? await onRefreshInventory() : await onCommitted(result);
      if (!mountedRef.current) return;
      if (refreshed && result === null) {
        onCancel(t("库存已重新读取。请核对刚才的产品与瓶数，确认结果后再决定是否新增。"));
      } else if (!refreshed) {
        setError(t("重新读取失败；本次保存仍已锁定，请稍后只重试读取。"));
      }
    } catch {
      if (mountedRef.current) setError(t("重新读取失败；本次保存仍已锁定，请稍后只重试读取。"));
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const close = (): void => onCancel(outcome === "uncertain"
    ? t("上次新增结果仍待确认，可能已写入。请先刷新并核对库存，避免重复新增。")
    : outcome === "created" ? t("库存已新增；请刷新库存确认显示，不要重复新增。") : undefined);
  const footer = (requestClose: () => void) => outcome === "editable" ? (
    <EditorFooter shared={draft.mode === "new"} notice={t("一次保存添加同一产品的指定瓶数")} progress={progress} formId={formId} saveLabel={t("保存并新增")} busy={busy} saveDisabled={busy} onCancel={requestClose} />
  ) : (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-[#7A6260]" role="status">{t(outcome === "created" ? "库存已经新增，不会再次提交。" : "结果待确认，保存已锁定。请先核对库存。")}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy} onClick={requestClose} className="rounded-2xl px-4 py-2.5 text-xs text-[#A8A3A0] disabled:opacity-45">{t("关闭")}</button>
        <button type="button" disabled={busy} onClick={() => void retryRead()} className="rounded-2xl bg-[linear-gradient(120deg,#9B7F7C,#B3A0AD)] px-5 py-2.5 text-xs text-white disabled:opacity-45">{t(busy ? "正在读取…" : "重新读取库存")}</button>
      </div>
    </div>
  );

  return (
    <ModalShell title={t("添加库存")} subtitle={t("手动新增")} footer={footer} busy={busy} onClose={close} toast={error.length === 0 ? null : <ToastViewport><Toast message={error} onDismiss={() => setError("")} /></ToastViewport>}>
      <form
        ref={formRef} id={formId} onSubmit={handleSubmit} className="min-w-0 w-full space-y-5 px-5 py-5" noValidate
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
        }}
      >
        <fieldset disabled={busy || outcome !== "editable"} className="min-w-0 space-y-5 disabled:opacity-70">
          <div role="group" aria-label={t("新增方式")} className="grid grid-cols-2 gap-1 rounded-2xl bg-[#F5F3F1] p-1">
            {([ ["new", "新产品"], ["existing", "已有产品添瓶"] ] as const).map(([mode, label]) => (
              <button key={mode} type="button" aria-pressed={draft.mode === mode} onClick={() => update("mode", mode)} className={`min-w-0 rounded-xl px-3 py-2.5 text-xs ${draft.mode === mode ? "bg-white text-[#5A4C4A] shadow-sm" : "text-[#A8A3A0]"}`}>{t(label)}</button>
            ))}
          </div>

          {draft.mode === "new" ? <>
            <div className="flex flex-col items-center gap-3">
              {preview === null ? null : <div className="size-28 overflow-hidden rounded-2xl bg-[#F8F5F3]"><img src={preview} alt={`${selectedImage?.name ?? t("新图片")} ${t("预览")}`} className="h-full w-full object-cover" /></div>}
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 rounded-full border border-[#D8D4D1] px-4 py-2 text-xs text-[#7A7572]"><Icon name="camera" className="size-4" />{t(selectedImage === null ? "添加图片（可选）" : "更换图片")}</button>
                {selectedImage === null ? null : <button type="button" onClick={() => { setSelectedImage(null); if (fileRef.current !== null) fileRef.current.value = ""; }} className="rounded-full px-3 py-2 text-xs text-[#A8A3A0]">{t("移除所选图片")}</button>}
              </div>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => { setSelectedImage(event.target.files?.[0] ?? null); setError(""); }} />
              <p className="text-center text-[10px] leading-relaxed text-[#A8A3A0]">{t("图片可留空；仅在保存时上传，不会自动识别资料。")}</p>
            </div>
            <Field label={t("产品名称")} hint={t("必填；不会自动按名称查重或合并。")}><input data-create-field="name" value={draft.name} onChange={(event) => update("name", event.target.value)} maxLength={200} className={editorInputClass} required /></Field>
            <Field label={t("产品别名")} hint={locale === "en" ? `A confirmed nickname; up to ${productAliasMaximumLength} characters.` : `已确认的常用称呼；最多 ${productAliasMaximumLength} 个字符。`} counter={textCharacterCountLabel(draft.alias, productAliasMaximumLength)}><input data-create-field="alias" value={draft.alias} onChange={(event) => update("alias", event.target.value)} className={editorInputClass} /></Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {([ ["brand", "品牌"], ["category", "品类"], ["size", "规格"] ] as const).map(([key, label]) => <Field key={key} label={t(label)} hint={t("无法确认时留空。")}><input data-create-field={key} value={draft[key]} onChange={(event) => update(key, event.target.value)} maxLength={100} className={editorInputClass} /></Field>)}
            </div>
            <Field label={t("产品 PAO（月）")} hint={t("开封后可用时长；同款产品共享，整数 1–120，未知时留空。")}><input data-create-field="pao" inputMode="numeric" value={draft.pao} onChange={(event) => update("pao", event.target.value)} className={editorInputClass} /></Field>
            <Field label={t("成分表原文")} hint={t("保留包装文字与内部换行。")} counter={textCharacterCountLabel(draft.ingredients, 5_000)}><textarea data-create-field="ingredients" value={draft.ingredients} onChange={(event) => update("ingredients", event.target.value)} maxLength={5_000} rows={4} className={`${editorInputClass} resize-y`} /></Field>
            <Field label={t("共享备注")} hint={t("同一 Product 的所有库存都会看到。")} counter={textCharacterCountLabel(draft.sharedNotes, 1_000)}><textarea data-create-field="sharedNotes" value={draft.sharedNotes} onChange={(event) => update("sharedNotes", event.target.value)} maxLength={1_000} rows={3} className={`${editorInputClass} resize-y`} /></Field>
          </> : <section className="space-y-3">
            <ScopeNotice shared>{t("只新增瓶数，不修改已有产品的共享资料或图片。")}</ScopeNotice>
            <Field label={t("选择已有产品")} hint={t("仅列出当前库存中有关联记录的产品，包含已归档库存。") }><input data-create-field="productId" type="search" value={productQuery} onChange={(event) => setProductQuery(event.target.value)} placeholder={t("搜索产品、品牌或规格")} className={editorInputClass} /></Field>
            <div role="group" aria-label={t("已有产品列表")} className="max-h-56 space-y-2 overflow-y-auto rounded-2xl border border-[#E0DBD8] p-2">
              {matchingProducts.length === 0 ? <p className="p-3 text-xs text-[#A8A3A0]">{t(products.length === 0 ? "还没有可选择的已有产品，请先新增产品。" : "没有找到匹配的产品。")}</p> : matchingProducts.map((product) => <button type="button" key={product.product_id} aria-pressed={draft.productId === product.product_id} onClick={() => update("productId", product.product_id)} className={`block w-full min-w-0 rounded-xl px-3 py-3 text-left ${draft.productId === product.product_id ? "bg-[#EEF1F4] text-[#4A6272]" : "text-[#5A4C4A] hover:bg-[#F8F5F3]"}`}><span className="block break-words text-sm">{product.name}</span><span className="mt-1 block break-words text-[11px] text-[#A8A3A0]">{product.brand ?? t("品牌未记录")} · {product.size_label ?? t("规格未记录")}</span></button>)}
            </div>
            {selectedProduct === undefined ? null : <div className="space-y-2 rounded-2xl bg-[#EEF1F4] px-4 py-3 text-xs leading-relaxed text-[#4A6272]">
              <p className="break-words">{t("已选择")}: {selectedProduct.name} · {selectedProduct.size_label ?? t("规格未记录")}</p>
              <p>{t("产品共享 PAO")}: {paoDurationLabel(selectedProduct.pao_duration_months, locale, t)}</p>
              <p>{t(selectedProduct.pao_duration_months === null ? "产品尚未记录 PAO；可到「编辑产品资料」补充，也可先按未知时长新增。" : "新增瓶会自动沿用所选产品的 PAO。")}</p>
            </div>}
          </section>}

          <section className="space-y-4 border-t border-[#F2EFED] pt-5">
            <h3 className="text-sm font-medium text-[#5A4C4A]">{t("新增瓶数与单瓶资料")}</h3>
            <ScopeNotice shared={false}>{t("同批每瓶使用下方相同的状态、日期和备注；PAO 自动沿用产品资料，单瓶事实不同请分次新增。")}</ScopeNotice>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t("瓶数")} hint={t(draft.mode === "new" ? "1–100 瓶；只创建一个产品，不是多个产品。" : "1–100 瓶；关联所选产品，不创建新产品。")}><input data-create-field="quantity" inputMode="numeric" value={draft.quantity} onChange={(event) => update("quantity", event.target.value)} className={editorInputClass} /></Field>
              <Field label={t("生命周期")}><SelectMenu value={draft.lifecycle} options={[{ value: "unopened", label: t("未开封") }, { value: "opened", label: t("已开封") }]} onChange={(value) => setDraft((current) => ({ ...current, lifecycle: value, ...(value === "unopened" ? { openedOn: "", accuracy: "" } : {}) }))} ariaLabel={t("生命周期")} className="w-full" buttonClassName={`${editorInputClass} flex items-center justify-between gap-3 text-left`} menuClassName="left-0 right-0 max-h-64 overflow-y-auto" /></Field>
              <Field label={t("开封日期")} hint={t("已开封时必填；未开封时会清空。")}><EditorDateInput data-create-field="openedOn" value={draft.openedOn} onChange={(event) => update("openedOn", event.target.value)} disabled={draft.lifecycle !== "opened"} /></Field>
              <Field label={t("开封日期准确性")} hint={t("估算必须明确标记。")}><SelectMenu value={draft.accuracy} options={[{ value: "", label: t("请选择日期准确性") }, { value: "exact", label: t("准确日期") }, { value: "estimated", label: t("估算日期") }]} onChange={(value) => update("accuracy", value)} ariaLabel={t("开封日期准确性")} disabled={draft.lifecycle !== "opened"} triggerRef={(node) => { node?.setAttribute("data-create-field", "accuracy"); }} className="w-full" buttonClassName={`${editorInputClass} flex items-center justify-between gap-3 text-left`} menuClassName="left-0 right-0 max-h-64 overflow-y-auto" /></Field>
              <Field label={t("包装过期日")} hint={t("没有记录时留空。")}><EditorDateInput data-create-field="expiresOn" value={draft.expiresOn} onChange={(event) => update("expiresOn", event.target.value)} /></Field>
            </div>
            <Field label={t("单瓶备注")} hint={t("将分别写入本次新增的每一瓶，不改变共享备注。")} counter={textCharacterCountLabel(draft.customNotes, 1_000)}><textarea data-create-field="customNotes" value={draft.customNotes} onChange={(event) => update("customNotes", event.target.value)} maxLength={1_000} rows={3} className={`${editorInputClass} resize-y`} /></Field>
          </section>
        </fieldset>
        <p className="text-[11px] leading-relaxed text-[#A8A3A0]" role="status" aria-live="polite">{progress}</p>
      </form>
    </ModalShell>
  );
}

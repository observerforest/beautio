import type { InventoryListItemOutput } from "@beautio/contracts";
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  AdminApiClient,
  AdminApiError,
  type ProductFactsInput,
} from "../../admin-api.ts";
import { Icon } from "../../components/Icon.tsx";
import { ModalShell } from "../../components/ModalShell.tsx";
import { isAbortError } from "../../utils/is-abort-error.ts";
import { normalizeOptionalEditorText, textCharacterCountLabel } from "../../text-fields.ts";
import { managedImageAssetId, type ProductImageChoice } from "./view-model.ts";
import { editorInputClass, Field, ScopeNotice } from "./EditorPrimitives.tsx";
import { inventoryErrorMessage } from "./utils/inventory-format.ts";
import { useProductImage } from "./useProductImage.ts";

const INGREDIENT_LIST_TEXT_MAXIMUM = 5_000;
const NOTES_MAXIMUM = 1_000;

export interface ProductEditorDialogProps {
  readonly item: InventoryListItemOutput;
  readonly product: NonNullable<InventoryListItemOutput["product"]>;
  readonly client: AdminApiClient;
  readonly onCancel: () => void;
  readonly onCommitted: (inventoryItemId: string, message: string) => Promise<boolean>;
  readonly onUnauthorized: (message: string) => void;
}

/**
 * 编辑完整的 Product 可变事实集合，并可选择替换其受管图片。
 * Edits the complete mutable Product fact set and optionally replaces its managed image.
 *
 * @param props - 现有条目、已认证客户端、取消与刷新操作，以及锁定回调。 / Existing item, authenticated client, cancel/refresh operations, and lock callback.
 * @returns 贴合 Figma 且仅在明确提交后写入的 Product 编辑器。 / A Figma-aligned Product editor that writes only after explicit submit.
 */
export function ProductEditorDialog({
  item,
  product,
  client,
  onCancel,
  onCommitted,
  onUnauthorized,
}: ProductEditorDialogProps) {
  const formId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState(product.category ?? "");
  const [size, setSize] = useState(product.size_label ?? "");
  const [ingredients, setIngredients] = useState(product.ingredient_list_text ?? "");
  const [sharedNotes, setSharedNotes] = useState(product.shared_notes ?? "");
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [clearImage, setClearImage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("保存前不会上传图片或修改数据库。");
  const [error, setError] = useState("");
  const [writeCompleted, setWriteCompleted] = useState(false);
  const currentImageAssetId = managedImageAssetId(item);
  const currentChoice = useMemo<ProductImageChoice>(
    () => currentImageAssetId === null ? { kind: "none" } : { kind: "managed", imageAssetId: currentImageAssetId },
    [currentImageAssetId],
  );
  const currentImage = useProductImage(client, currentChoice, "original", onUnauthorized);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (selectedImage === null) {
      setLocalPreview(null);
      return;
    }
    const objectUrl = URL.createObjectURL(selectedImage);
    setLocalPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [selectedImage]);

  const handleFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const selected = event.target.files?.[0] ?? null;
    setSelectedImage(selected);
    setClearImage(false);
    setError("");
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy || writeCompleted) return;
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      setError("产品名称不能为空。");
      nameRef.current?.focus();
      return;
    }
    const input: ProductFactsInput = {
      name: normalizedName,
      category: normalizeOptionalEditorText(category),
      size_label: normalizeOptionalEditorText(size),
      image_asset_id: clearImage ? null : currentImageAssetId,
      ingredient_list_text: normalizeOptionalEditorText(ingredients),
      shared_notes: normalizeOptionalEditorText(sharedNotes),
    };
    void save(input);
  };

  const save = async (input: ProductFactsInput): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      let imageAssetId = input.image_asset_id;
      if (selectedImage !== null) {
        setProgress("正在上传新图片…");
        const asset = await client.uploadProductImage(selectedImage);
        imageAssetId = asset.image_asset_id;
      }
      setProgress("正在保存产品资料…");
      await client.updateProduct(product.product_id, { ...input, image_asset_id: imageAssetId });
      setWriteCompleted(true);
      setProgress("产品资料已保存，正在重新读取真实库存…");
      const refreshed = await onCommitted(
        item.inventory_item_id,
        "产品资料已保存。共享该 Product 的库存已重新读取。",
      );
      if (!refreshed && mountedRef.current) {
        setError("保存请求已经完成，但重新读取失败。请先重试读取确认结果，不要重复保存。");
        setProgress("等待重新读取确认。");
      }
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        onUnauthorized("管理密钥无效或已撤销，请重新输入。此次修改没有保存。");
        return;
      }
      if (!isAbortError(caught) && mountedRef.current) {
        setError(`${inventoryErrorMessage(caught)}${selectedImage === null ? "" : " 若图片已上传但尚未关联，服务器会按临时资产规则清理。"}`);
        setProgress("保存失败，页面中的输入仍保留。");
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const preview = clearImage ? (
    <ImagePlaceholder copy="保存后将清空管理图片" />
  ) : localPreview !== null ? (
    <img src={localPreview} alt={`${selectedImage?.name ?? "新图片"}预览`} className="h-full w-full object-cover" />
  ) : currentImage.status === "ready" ? (
    <img src={currentImage.src} alt={`${product.name}当前管理图片`} className="h-full w-full object-cover" onError={currentImage.reportError} />
  ) : (
    <ImagePlaceholder copy={currentImage.status === "loading" ? "正在读取当前图片" : currentImage.status === "error" ? "当前图片读取失败" : product.image_ref === null ? "暂无管理图片" : "旧图片引用不自动加载"} />
  );

  const footer = (
    <div className="space-y-3">
      <ScopeNotice shared>修改将同步影响该 Product 的所有库存瓶。</ScopeNotice>
      <p className="text-[11px] text-[#A8A3A0]" role="status" aria-live="polite">{progress}</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-2xl px-4 py-2.5 text-sm text-[#A8A3A0] disabled:opacity-45">取消</button>
        <button type="submit" form={formId} disabled={busy || writeCompleted} className="rounded-2xl bg-[linear-gradient(120deg,#9B7F7C,#B3A0AD)] px-5 py-2.5 text-sm font-medium text-white disabled:opacity-45">
          {busy ? "保存中…" : "保存产品资料"}
        </button>
      </div>
    </div>
  );

  return (
    <ModalShell title={product.name} subtitle="编辑产品资料" footer={footer} busy={busy} onClose={onCancel}>
      <form id={formId} onSubmit={handleSubmit} className="space-y-5 px-5 py-5" noValidate>
        <fieldset disabled={busy || writeCompleted} className="space-y-5 disabled:opacity-70">
          <div className="flex flex-col items-center gap-3">
            <div className="size-32 overflow-hidden rounded-2xl bg-[#F8F5F3]">{preview}</div>
            <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 rounded-full border border-[#D8D4D1] px-4 py-2 text-xs text-[#7A7572] hover:bg-stone-50">
              <Icon name="camera" className="size-4" />更换图片
            </button>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={handleFile} />
            <p className="text-center text-[10px] text-[#A8A3A0]">选择后只在点击保存时上传 JPEG、PNG 或静态 WebP。</p>
            <label className={`flex items-center gap-2 text-xs text-[#7A7572] ${currentImageAssetId === null || selectedImage !== null ? "opacity-45" : ""}`}>
              <input
                type="checkbox"
                checked={clearImage}
                disabled={currentImageAssetId === null || selectedImage !== null}
                onChange={(event) => {
                  setClearImage(event.target.checked);
                  if (event.target.checked) {
                    setSelectedImage(null);
                    if (fileRef.current !== null) fileRef.current.value = "";
                  }
                }}
              />
              清空当前管理图片
            </label>
          </div>

          <div className="space-y-4">
            <Field label="产品名称" hint="必填；不会自动按名称查重或合并。">
              <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} maxLength={200} className={editorInputClass} required />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="品类" hint="无法确认时留空。">
                <input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={100} className={editorInputClass} />
              </Field>
              <Field label="规格" hint="无法确认时留空。">
                <input value={size} onChange={(event) => setSize(event.target.value)} maxLength={100} className={editorInputClass} />
              </Field>
            </div>
            <Field label="成分表原文" hint="保留包装文字与内部换行。" counter={textCharacterCountLabel(ingredients, INGREDIENT_LIST_TEXT_MAXIMUM)}>
              <textarea value={ingredients} onChange={(event) => setIngredients(event.target.value)} maxLength={INGREDIENT_LIST_TEXT_MAXIMUM} rows={8} className={`${editorInputClass} resize-y`} />
            </Field>
            <Field label="共享备注" hint="同一 Product 的所有库存都会看到。" counter={textCharacterCountLabel(sharedNotes, NOTES_MAXIMUM)}>
              <textarea value={sharedNotes} onChange={(event) => setSharedNotes(event.target.value)} maxLength={NOTES_MAXIMUM} rows={5} className={`${editorInputClass} resize-y`} />
            </Field>
          </div>
        </fieldset>
        {error.length === 0 ? null : <p role="alert" className="rounded-xl bg-[#FBF3F2] px-3 py-2 text-sm text-[#9D4C57]">{error}</p>}
      </form>
    </ModalShell>
  );
}

function ImagePlaceholder({ copy }: { readonly copy: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[linear-gradient(145deg,#F8F5F3,#EEE9E6)] text-[#B0AAA7]" role="img" aria-label={copy}>
      <div className="size-10 rounded-full bg-[linear-gradient(135deg,#E5D8CF,#D5D2CF)]" />
      <span className="text-[9px]">{copy}</span>
    </div>
  );
}

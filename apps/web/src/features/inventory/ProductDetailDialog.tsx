import type { InventoryListItemOutput } from "@beautio/contracts";
import { useMemo, useState } from "react";
import { AdminApiClient } from "../../admin-api.ts";
import { Icon } from "../../components/Icon.tsx";
import { ModalShell } from "../../components/ModalShell.tsx";
import {
  lifecycleLabel,
  managedImageAssetId,
  openedOnAccuracy,
  paoDeadlineAccuracy,
  usabilityLabel,
  warningLabel,
  type ProductImageChoice,
} from "./view-model.ts";
import { ImageViewer } from "./ImageViewer.tsx";
import { dateWithAccuracy, displayValue } from "./utils/inventory-format.ts";
import { useProductImage } from "./useProductImage.ts";

export interface ProductDetailDialogProps {
  readonly item: InventoryListItemOutput;
  readonly asOf: string;
  readonly client: AdminApiClient;
  readonly feedback: string;
  readonly onClose: () => void;
  readonly onEditProduct: () => void;
  readonly onEditBottle: () => void;
  readonly onEditNotes: () => void;
  readonly onUnauthorized: (message: string) => void;
}

/**
 * 分开呈现一瓶经服务端确认的酒所对应的 Product、酒瓶与派生信息范围。
 * Renders one server-confirmed bottle with Product, bottle, and derived scopes separated.
 *
 * @param props - 库存条目、读取日期、已认证图片客户端和对话框操作。 / Inventory item, read date, authenticated image client, and dialog actions.
 * @returns 不混淆生命周期与可用性的已确认 Figma 详情呈现。 / The approved Figma detail treatment without collapsing lifecycle and usability.
 */
export function ProductDetailDialog({
  item,
  asOf,
  client,
  feedback,
  onClose,
  onEditProduct,
  onEditBottle,
  onEditNotes,
  onUnauthorized,
}: ProductDetailDialogProps) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const productName = item.product?.name ?? "未记录产品名称";
  const imageAssetId = managedImageAssetId(item);
  const detailChoice = useMemo<ProductImageChoice>(
    () => imageAssetId === null ? { kind: "none" } : { kind: "managed", imageAssetId },
    [imageAssetId],
  );
  const image = useProductImage(client, detailChoice, "original", onUnauthorized);
  const terminal = item.lifecycle_status === "finished" || item.lifecycle_status === "discarded";
  const bottleLabel =
    item.product_inventory_count !== null &&
    item.product_inventory_count > 1 &&
    item.product_inventory_position !== null
      ? `第${item.product_inventory_position}瓶`
      : null;

  const hero = (
    <header className="relative shrink-0">
      <div className="relative h-52 overflow-hidden rounded-t-3xl bg-[#F8F5F3] md:h-64">
        {image.status === "ready" ? (
          <img src={image.src} alt={productName} className="h-full w-full object-cover" onError={image.reportError} />
        ) : (
          <div className="flex h-full items-center justify-center bg-[linear-gradient(145deg,#F8F5F3,#EEE9E6)]" role="img" aria-label={image.status === "loading" ? "正在读取完整原图" : image.status === "error" ? "完整原图读取失败" : "暂无管理原图"}>
            <div className="size-20 rounded-full bg-[linear-gradient(135deg,#E5D8CF,#D5D2CF)]" />
          </div>
        )}
        <div className="absolute inset-0 bg-[linear-gradient(to_top,rgba(60,45,43,0.68)_0%,transparent_58%)]" />
      </div>
      <button type="button" onClick={onClose} className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-white/20 text-white backdrop-blur" aria-label="关闭库存详情">
        <Icon name="x" />
      </button>
      {image.status === "ready" ? (
        <button type="button" onClick={() => setViewerOpen(true)} className="absolute right-4 top-16 rounded-full bg-black/20 px-3 py-1.5 text-[10px] text-white backdrop-blur">
          查看完整原图
        </button>
      ) : null}
      <div className="absolute bottom-0 left-0 right-0 px-5 pb-4 text-white">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-[#FBF3F2] px-2.5 py-0.5 text-[11px] font-medium text-[#9B7F7C]">{lifecycleLabel(item.lifecycle_status)}</span>
          <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-[11px] font-medium backdrop-blur">{usabilityLabel(item.usability_status)}</span>
          {bottleLabel === null ? null : <span className="ml-auto text-[11px] text-white/65">{bottleLabel}</span>}
        </div>
        <h3 className="break-words text-lg font-semibold leading-snug">{productName}</h3>
        <p className="mt-0.5 text-xs text-white/65">{item.product?.category ?? "品类未记录"} · {item.product?.size_label ?? "规格未记录"}</p>
      </div>
    </header>
  );

  const footer = (
    <div className="space-y-3">
      <p className="text-[11px] text-[#A8A3A0]" role="status" aria-live="polite">{feedback}</p>
      <div className="flex gap-2">
        <button type="button" onClick={onEditProduct} disabled={item.product === null} title={item.product === null ? "这条库存没有关联 Product" : undefined} className="flex-1 rounded-2xl bg-[#F5F3F1] py-3 text-sm text-[#5A4C4A] disabled:opacity-45">
          编辑产品资料
        </button>
        <button type="button" onClick={onEditBottle} disabled={terminal} title={terminal ? "已结束库存不能修改生命周期事实" : undefined} className="flex-1 rounded-2xl bg-[linear-gradient(120deg,#9B7F7C,#B3A0AD)] py-3 text-sm font-medium text-white disabled:opacity-45">
          编辑这瓶
        </button>
      </div>
    </div>
  );

  return (
    <>
      <ModalShell title={productName} hero={hero} footer={footer} onClose={onClose} wide>
        <div className="space-y-5 px-5 py-5">
          <section className="flex items-start gap-2 rounded-2xl bg-[#F5F3F1] px-4 py-3 text-[11px] leading-relaxed text-[#7A7572]">
            <Icon name="info" className="mt-0.5 size-3.5 shrink-0" />
            <p>产品成分与共享备注属于同款 Product；自定义备注只属于当前瓶。期限和可用状态由服务端计算。</p>
          </section>

          <DetailSection title="产品资料" badge="共享 · 影响全部瓶" tone="shared">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <InfoCell label="产品名称" value={item.product?.name ?? "未记录"} />
              <InfoCell label="品类" value={item.product?.category ?? "未记录"} />
              <InfoCell label="规格" value={item.product?.size_label ?? "未记录"} />
            </div>
            <LongFact label="成分表原文" value={item.product?.ingredient_list_text ?? null} />
            <LongFact label="共享备注" value={item.product?.shared_notes ?? null} />
            <p className="break-all text-[10px] text-[#B0AAA7]">Product ID · {displayValue(item.product_id)}</p>
          </DetailSection>

          <DetailSection title="这一瓶" badge="仅当前瓶" tone="bottle">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <InfoCell label="生命周期" value={lifecycleLabel(item.lifecycle_status)} />
              <InfoCell label="开封日期" value={dateWithAccuracy(item.opened_on, openedOnAccuracy(item))} />
              <InfoCell label="包装过期日" value={displayValue(item.expires_on)} />
              <InfoCell label="PAO" value={item.pao_duration_months === null ? "未记录" : `${item.pao_duration_months} 个月`} />
              <InfoCell label="状态判断日" value={asOf} />
            </div>
            <div className="rounded-2xl bg-[#F5F3F1] px-4 py-3">
              <div className="mb-1 flex items-center justify-between gap-3">
                <span className="text-[10px] text-[#A8A3A0]">自定义备注（仅这瓶）</span>
                <button type="button" onClick={onEditNotes} className="rounded-full bg-[#EEF1F4] px-2 py-0.5 text-[10px] text-[#4A6272]">编辑</button>
              </div>
              <p className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${item.custom_notes === null ? "text-[#B8B2AF]" : "text-[#5A4C4A]"}`}>{item.custom_notes ?? "未填写"}</p>
            </div>
            <p className="break-all text-[10px] text-[#B0AAA7]">Inventory ID · {item.inventory_item_id}</p>
          </DetailSection>

          <DetailSection title="服务端派生结果" badge="只读" tone="derived">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <InfoCell label="PAO 截止日" value={dateWithAccuracy(item.pao_deadline, paoDeadlineAccuracy(item))} />
              <InfoCell label="最终可用至" value={displayValue(item.usable_until)} />
              <InfoCell label="可用状态" value={usabilityLabel(item.usability_status)} />
            </div>
            <div className="rounded-2xl bg-[#FBF6F5] px-4 py-3">
              <p className="mb-1 text-[10px] text-[#9B7F7C]">系统警告</p>
              {item.warnings.length === 0 ? (
                <p className="text-xs text-[#7A7572]">当前没有警告</p>
              ) : (
                <ul className="space-y-1 text-xs text-[#9D4C57]">
                  {item.warnings.map((warning) => <li key={warning}>• {warningLabel(warning)}</li>)}
                </ul>
              )}
            </div>
          </DetailSection>
        </div>
      </ModalShell>
      {viewerOpen && image.status === "ready" ? <ImageViewer title={productName} src={image.src} onClose={() => setViewerOpen(false)} /> : null}
    </>
  );
}

function DetailSection({ title, badge, tone, children }: { readonly title: string; readonly badge: string; readonly tone: "shared" | "bottle" | "derived"; readonly children: React.ReactNode }) {
  const badgeClass = tone === "shared" ? "bg-[#EEF1F4] text-[#4A6272]" : tone === "bottle" ? "bg-[#FBF6F5] text-[#7A6260]" : "bg-[#F3F0ED] text-[#7A7572]";
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold uppercase tracking-[0.06em] text-[#A8A3A0]">{title}</h4>
        <span className={`rounded-full px-2 py-0.5 text-[10px] ${badgeClass}`}>{badge}</span>
      </div>
      {children}
    </section>
  );
}

function InfoCell({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0 rounded-2xl bg-[#F5F3F1] px-3 py-2.5">
      <span className="block text-[10px] text-[#A8A3A0]">{label}</span>
      <span className="mt-0.5 block break-words text-xs font-medium leading-snug text-[#5A4C4A]">{value}</span>
    </div>
  );
}

function LongFact({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="rounded-2xl bg-[#F5F3F1] px-4 py-3">
      <span className="mb-1 block text-[10px] text-[#A8A3A0]">{label}</span>
      <p className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${value === null ? "text-[#B8B2AF]" : "text-[#5A4C4A]"}`}>{value ?? "未填写"}</p>
    </div>
  );
}

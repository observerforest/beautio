import type { InventoryListItemOutput } from "@beautio/contracts";
import { AdminApiClient } from "../../admin-api.ts";
import type { InventoryCardView } from "./view-model.ts";
import { ProductImage } from "./ProductImage.tsx";

export interface ProductCardProps {
  readonly item: InventoryListItemOutput;
  readonly view: InventoryCardView;
  readonly client: AdminApiClient;
  readonly onOpen: () => void;
  readonly onUnauthorized: (message: string) => void;
}

/**
 * 按已确认的紧凑 Figma 卡片呈现一个实体 InventoryItem。
 * Renders one physical InventoryItem using the approved compact Figma card.
 *
 * @param props - 库存事实、卡片投影、已认证图片客户端和操作入口。 / Inventory facts, card projection, authenticated image client, and actions.
 * @returns 每张只对应一瓶、可通过键盘操作的卡片。 / A keyboard-operable card that never groups multiple bottles.
 */
export function ProductCard({
  item,
  view,
  client,
  onOpen,
  onUnauthorized,
}: ProductCardProps) {
  return (
    <article className="min-w-0">
      <button
        type="button"
        onClick={onOpen}
        aria-label={view.accessibleName}
        aria-haspopup="dialog"
        className="group flex w-full min-w-0 flex-col overflow-hidden rounded-2xl bg-white text-left shadow-[0_1px_6px_rgba(90,76,74,0.06)] transition-transform active:scale-[0.97]"
      >
        <span className="relative aspect-square w-full overflow-hidden bg-[#F8F5F3]">
          <ProductImage
            client={client}
            choice={view.image}
            alt={view.displayName}
            variant="card"
            onUnauthorized={onUnauthorized}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
          {view.alerts.length === 0 ? null : (
            <span className="absolute right-1.5 top-1.5 flex flex-col items-end gap-1">
              {view.alerts.map((alert) => (
                <span
                  key={`${alert.tone}-${alert.label}`}
                  className={`rounded-full border-2 border-white px-1.5 py-0.5 text-[8px] font-medium shadow-sm ${
                    alert.tone === "expired"
                      ? "bg-[#A4515C] text-white"
                      : alert.tone === "terminal"
                        ? "bg-[#8A827E] text-white"
                        : "bg-[#FBF3EE] text-[#B46D4E]"
                  }`}
                >
                  {alert.label}
                </span>
              ))}
            </span>
          )}
        </span>

        <span className="flex min-w-0 flex-col gap-0.5 p-2.5">
          <strong className="min-w-0 break-words text-[11px] font-medium leading-tight text-[#5A4C4A] sm:text-xs">
            {view.displayName}
          </strong>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[#A8A3A0]">
            <span className="break-words">{view.sizeLabel}</span>
            {view.bottleLabel === null ? null : <span>{view.bottleLabel}</span>}
          </span>
          <span
            className={`break-words text-[10px] ${
              item.usable_until === null ? "text-[#9B7F7C]" : "text-[#A8A3A0]"
            }`}
          >
            {view.usableUntilLabel}
          </span>
        </span>
      </button>
    </article>
  );
}

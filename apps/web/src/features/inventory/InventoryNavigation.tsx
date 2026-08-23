import { Icon } from "../../components/Icon.tsx";
import { Logo } from "../../components/Logo.tsx";
import type { InventoryBrowseCounts, InventoryCollectionView } from "../../view-model.ts";
import { CollectionTabs } from "./InventoryControls.tsx";

export interface DesktopSidebarProps {
  readonly view: InventoryCollectionView;
  readonly counts: InventoryBrowseCounts;
  readonly settingsOpen: boolean;
  readonly onViewChange: (view: InventoryCollectionView) => void;
  readonly onSettingsToggle: () => void;
}

/**
 * 渲染已确认的 240 像素桌面导航与真实库存概览。
 * Renders the approved 240-pixel desktop navigation and factual inventory overview.
 *
 * @param props - 集合状态、源数据计数、设置状态与回调。 / Collection state, source counts, settings state, and callbacks.
 * @returns 仅桌面显示的侧栏，尚不可用的入口保持禁用。 / Desktop-only sidebar with unavailable destinations disabled.
 */
export function DesktopSidebar({
  view,
  counts,
  settingsOpen,
  onViewChange,
  onSettingsToggle,
}: DesktopSidebarProps) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-[#E5D8CF] bg-white md:flex">
      <div className="px-6 pb-6 pt-8"><Logo className="h-[30px] w-auto max-w-[180px] object-contain object-left" /></div>
      <div className="beautio-scrollbar flex-1 overflow-y-auto px-3">
        <p className="mb-2 px-3 text-[10px] uppercase tracking-[0.18em] text-[#A8A3A0]">我的库存</p>
        <CollectionTabs view={view} counts={counts} onChange={onViewChange} />
        <div className="mx-3 mb-5 mt-5 h-px bg-[#E5D8CF]" />
        <p className="mb-2 px-3 text-[10px] uppercase tracking-[0.18em] text-[#A8A3A0]">库存概况</p>
        {[
          { label: "已开封", count: counts.opened, color: "#9B7F7C" },
          { label: "未开封", count: counts.unopened, color: "#7A8793" },
          { label: "需留意", count: counts.attention, color: "#C07A5A" },
        ].map((entry) => (
          <div key={entry.label} className="flex items-center justify-between px-3 py-1.5">
            <span className="text-xs text-[#A8A3A0]">{entry.label}</span>
            <strong className="text-xs" style={{ color: entry.color }}>{entry.count}</strong>
          </div>
        ))}
      </div>
      <div className="border-t border-[#E5D8CF] px-3 pb-6 pt-3">
        <button
          type="button"
          onClick={onSettingsToggle}
          aria-pressed={settingsOpen}
          className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm transition-colors ${settingsOpen ? "bg-[#EEF1F4] text-[#4A6272]" : "text-[#A8A3A0] hover:bg-[#F8F6F4]"}`}
        >
          <Icon name="gear" className="size-4" />设置
        </button>
      </div>
    </aside>
  );
}

export interface MobileNavigationProps {
  readonly active: "inventory" | "settings";
  readonly onChange: (view: "inventory" | "settings") => void;
}

/**
 * 渲染 Figma 的移动端胶囊导航，并让尚不可用的知识入口保持无操作。
 * Renders the Figma mobile navigation pill with unavailable knowledge kept inert.
 *
 * @param props - 当前移动端页面与导航回调。 / Current mobile page and navigation callback.
 * @returns 仅移动端显示、适配安全区的导航。 / Mobile-only safe-area navigation.
 */
export function MobileNavigation({ active, onChange }: MobileNavigationProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 flex justify-center pb-[calc(env(safe-area-inset-bottom,0px)+14px)] pt-1.5 md:hidden" aria-label="移动端主要页面">
      <div className="flex items-center gap-3 rounded-full bg-white p-1.5 shadow-[0_4px_24px_rgba(90,76,74,0.14)]">
        <button
          type="button"
          onClick={() => onChange("inventory")}
          aria-current={active === "inventory" ? "page" : undefined}
          className={`flex size-12 items-center justify-center rounded-full transition-colors ${active === "inventory" ? "bg-[#F5F0EF] text-[#9B7F7C]" : "text-[#C4C0BD]"}`}
          aria-label="库存"
        >
          <Icon name="inventory" className="size-5" />
        </button>
        <button type="button" disabled title="护肤知识即将开放" className="flex size-12 items-center justify-center rounded-full text-[#DDD9D6]" aria-label="护肤知识即将开放">
          <Icon name="tree" className="size-5" />
        </button>
        <button
          type="button"
          onClick={() => onChange("settings")}
          aria-current={active === "settings" ? "page" : undefined}
          className={`flex size-12 items-center justify-center rounded-full transition-colors ${active === "settings" ? "bg-[#F5F0EF] text-[#9B7F7C]" : "text-[#C4C0BD]"}`}
          aria-label="设置"
        >
          <Icon name="gear" className="size-5" />
        </button>
      </div>
    </nav>
  );
}

export interface SettingsPanelProps {
  readonly desktop: boolean;
  readonly onClose?: () => void;
  readonly onLock: () => void;
}

/**
 * 渲染当前会话设置，不把尚未实现的账户功能伪装成可用能力。
 * Renders current-session settings without presenting unavailable account features as functional.
 *
 * @param props - 桌面浮层模式、关闭回调与显式锁定操作。 / Desktop popover mode, close callback, and explicit lock operation.
 * @returns 设置列表与当前标签页的退出控件。 / Settings list and current-tab logout control.
 */
export function SettingsPanel({ desktop, onClose, onLock }: SettingsPanelProps) {
  const content = (
    <>
      {desktop ? (
        <header className="flex items-center justify-between border-b border-[#F2EFED] px-4 pb-3 pt-4">
          <span className="text-sm font-medium text-[#5A4C4A]">设置</span>
          <button type="button" onClick={onClose} className="text-[#A8A3A0]" aria-label="关闭设置"><Icon name="x" /></button>
        </header>
      ) : null}
      <div>
        {["账户信息", "通知设置", "数据备份", "隐私政策"].map((item, index) => (
          <div key={item}>
            <button type="button" disabled title={`${item}即将开放`} className="flex w-full items-center justify-between px-4 py-3.5 text-left text-sm text-[#AAA5A2]">
              {item}<Icon name="chevron-right" className="size-4" />
            </button>
            {index < 3 ? <div className="mx-4 h-px bg-[#F2EFED]" /> : null}
          </div>
        ))}
        <div className="mx-4 h-px bg-[#F2EFED]" />
        <button type="button" onClick={onLock} className="w-full py-3.5 text-sm font-medium text-[#9B7F7C] hover:bg-rose-50">
          退出登录
        </button>
      </div>
    </>
  );

  if (!desktop) {
    return (
      <section className="mx-5 mt-4 overflow-hidden rounded-2xl bg-white shadow-[0_1px_6px_rgba(90,76,74,0.06)]" aria-label="设置">
        {content}
      </section>
    );
  }
  return (
    <section className="fixed bottom-20 left-3 z-50 w-[222px] overflow-hidden rounded-2xl bg-white shadow-[0_-4px_40px_rgba(90,76,74,0.16),0_4px_20px_rgba(90,76,74,0.10)]" aria-label="设置">
      {content}
    </section>
  );
}

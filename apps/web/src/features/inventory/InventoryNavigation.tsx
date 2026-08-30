import { useRef, useState, type ChangeEvent } from "react";
import {
  AdminApiClient,
  prepareBeautioBackupFile,
  type PreparedBeautioBackupFile,
} from "../../admin-api.ts";
import { Icon } from "../../components/Icon.tsx";
import { Logo } from "../../components/Logo.tsx";
import { useI18n } from "../../i18n.tsx";
import type { InventoryBrowseCounts, InventoryCollectionView } from "./models/index.ts";
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
  const { t } = useI18n();
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-[#E5D8CF] bg-white md:flex">
      <div className="px-6 pb-6 pt-8"><Logo className="h-[30px] w-auto max-w-[180px] object-contain object-left" /></div>
      <div className="beautio-scrollbar flex-1 overflow-y-auto px-3">
        <p className="mb-2 px-3 text-[10px] uppercase tracking-[0.18em] text-[#A8A3A0]">{t("我的库存")}</p>
        <CollectionTabs view={view} counts={counts} onChange={onViewChange} />
        <div className="mx-3 mb-5 mt-5 h-px bg-[#E5D8CF]" />
        <p className="mb-2 px-3 text-[10px] uppercase tracking-[0.18em] text-[#A8A3A0]">{t("库存概况")}</p>
        {[
          { label: "已开封", count: counts.opened, color: "#9B7F7C" },
          { label: "未开封", count: counts.unopened, color: "#7A8793" },
          { label: "需留意", count: counts.attention, color: "#C07A5A" },
        ].map((entry) => (
          <div key={entry.label} className="flex items-center justify-between px-3 py-1.5">
            <span className="text-xs text-[#A8A3A0]">{t(entry.label)}</span>
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
          <Icon name="gear" className="size-4" />{t("设置")}
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
  const { t } = useI18n();
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 flex justify-center pb-[calc(env(safe-area-inset-bottom,0px)+14px)] pt-1.5 md:hidden" aria-label={t("移动端主要页面")}>
      <div className="flex items-center gap-3 rounded-full bg-white p-1.5 shadow-[0_4px_24px_rgba(90,76,74,0.14)]">
        <button
          type="button"
          onClick={() => onChange("inventory")}
          aria-current={active === "inventory" ? "page" : undefined}
          className={`flex size-12 items-center justify-center rounded-full transition-colors ${active === "inventory" ? "bg-[#F5F0EF] text-[#9B7F7C]" : "text-[#C4C0BD]"}`}
          aria-label={t("库存")}
        >
          <Icon name="inventory" className="size-5" />
        </button>
        <button type="button" disabled title={t("护肤知识即将开放")} className="flex size-12 items-center justify-center rounded-full text-[#DDD9D6]" aria-label={t("护肤知识即将开放")}>
          <Icon name="tree" className="size-5" />
        </button>
        <button
          type="button"
          onClick={() => onChange("settings")}
          aria-current={active === "settings" ? "page" : undefined}
          className={`flex size-12 items-center justify-center rounded-full transition-colors ${active === "settings" ? "bg-[#F5F0EF] text-[#9B7F7C]" : "text-[#C4C0BD]"}`}
          aria-label={t("设置")}
        >
          <Icon name="gear" className="size-5" />
        </button>
      </div>
    </nav>
  );
}

export interface SettingsPanelProps {
  readonly desktop: boolean;
  readonly readOnly?: boolean;
  readonly client: AdminApiClient;
  readonly onClose?: () => void;
  readonly onLock: () => void;
  readonly onBackupRestored: (message: string) => Promise<void>;
}

/**
 * 渲染当前会话设置，不把尚未实现的账户功能伪装成可用能力。
 * Renders current-session settings without presenting unavailable account features as functional.
 *
 * @param props - 桌面浮层模式、关闭回调与显式锁定操作。 / Desktop popover mode, close callback, and explicit lock operation.
 * @returns 设置列表与当前标签页的退出控件。 / Settings list and current-tab logout control.
 */
export function SettingsPanel({
  desktop,
  readOnly = false,
  client,
  onClose,
  onLock,
  onBackupRestored,
}: SettingsPanelProps) {
  const { locale, setLocale, t } = useI18n();
  const backupEnabled =
    !readOnly && import.meta.env.VITE_BEAUTIO_BACKUP_ENABLED === "true";
  const [view, setView] = useState<"root" | "backup" | "privacy" | "language">("root");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pendingBackup, setPendingBackup] = useState<PreparedBeautioBackupFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const exportBackup = (): void => {
    setBusy(true);
    setMessage("");
    void client.downloadBackup().then((download) => {
      const url = URL.createObjectURL(download.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = download.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(t("完整备份已导出。"));
    }).catch((error: unknown) => {
      setMessage(error instanceof Error ? t(error.message) : t("备份导出失败。"));
    }).finally(() => setBusy(false));
  };

  const chooseBackup = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    setMessage("");
    void prepareBeautioBackupFile(file).then(setPendingBackup).catch((error: unknown) => {
      setPendingBackup(null);
      setMessage(error instanceof Error ? t(error.message) : t("备份文件无法读取。"));
    });
  };

  const restoreBackup = (): void => {
    if (pendingBackup === null) return;
    setBusy(true);
    setMessage("");
    void client.restoreBackupFile(pendingBackup.file).then(async (result) => {
      setPendingBackup(null);
      const restoredMessage =
        locale === "en"
          ? `Restored ${result.products} products, ${result.inventory_items} inventory items, and ${result.images} images.`
          : `已恢复 ${result.products} 个产品、${result.inventory_items} 件库存和 ${result.images} 张图片。`;
      setMessage(restoredMessage);
      await onBackupRestored(restoredMessage);
    }).catch((error: unknown) => {
      setMessage(error instanceof Error ? t(error.message) : t("备份恢复失败。"));
    }).finally(() => setBusy(false));
  };

  const title =
    view === "backup"
      ? t("数据备份")
      : view === "privacy"
        ? t("隐私政策")
        : view === "language"
          ? t("语言")
          : t("设置");

  const rootContent = (
    <div>
      <SettingsRow label={t("语言")} value={locale === "en" ? "English" : "简体中文"} onClick={() => setView("language")} />
      <SettingsRow
        label={t("数据备份")}
        {...(backupEnabled
          ? { onClick: () => setView("backup") }
          : { value: t("未开放"), disabled: true })}
      />
      <SettingsRow label={t("隐私政策")} onClick={() => setView("privacy")} />
      <SettingsRow label={t("账户信息")} value={t("未开放")} disabled />
      <SettingsRow label={t("通知设置")} value={t("未开放")} disabled last />
      <div className="mx-4 h-px bg-[#F2EFED]" />
      <button type="button" onClick={onLock} className="w-full py-3.5 text-sm font-medium text-[#9B7F7C] hover:bg-rose-50">
        {t("退出登录")}
      </button>
    </div>
  );

  const detailContent = (
    <div className="space-y-4 px-4 py-4 text-sm text-[#6E6461]">
      {view === "language" ? (
        <div className="grid grid-cols-2 gap-2">
          {(["zh-CN", "en"] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => setLocale(choice)}
              aria-pressed={locale === choice}
              className={`rounded-xl border px-3 py-3 text-sm ${locale === choice ? "border-[#B3A0AD] bg-[#F5F0EF] text-[#5A4C4A]" : "border-[#E5D8CF] bg-white text-[#8D8581]"}`}
            >
              {choice === "zh-CN" ? "简体中文" : "English"}
            </button>
          ))}
        </div>
      ) : null}
      {view === "backup" ? (
        <>
          <p className="text-xs leading-relaxed text-[#8D8581]">{t("备份包含产品、库存、成分、备注与原始图片，不包含任何密钥。")}</p>
          <button type="button" disabled={busy} onClick={exportBackup} className="w-full rounded-xl bg-[#EEF1F4] px-4 py-3 text-sm text-[#4A6272] disabled:opacity-45">
            {busy ? t("正在导出…") : t("导出完整备份")}
          </button>
          <input ref={fileInputRef} type="file" accept=".beautio-backup,application/json" className="hidden" onChange={chooseBackup} />
          <button type="button" disabled={busy} onClick={() => fileInputRef.current?.click()} className="w-full rounded-xl border border-[#E5D8CF] px-4 py-3 text-sm text-[#7A7572] disabled:opacity-45">
            {t("选择备份文件")}
          </button>
          {pendingBackup === null ? null : (
            <div className="rounded-xl bg-[#FAF8F6] p-3 text-xs leading-relaxed">
              <p className="break-all">{pendingBackup.file.name}</p>
              <p className="mt-1 text-[#A8A3A0]">{formatBackupFileSize(pendingBackup.byteSize, locale)}</p>
              <p className="mt-2 text-[#A06E62]">{t("恢复会用备份内容替换当前全部库存，操作前请核对预览。")}</p>
              <div className="mt-3 flex gap-2">
                <button type="button" disabled={busy} onClick={() => setPendingBackup(null)} className="flex-1 rounded-lg border border-[#E5D8CF] py-2">{t("取消")}</button>
                <button type="button" disabled={busy} onClick={restoreBackup} className="flex-1 rounded-lg bg-[#9B7F7C] py-2 text-white">{busy ? t("正在恢复…") : t("确认恢复")}</button>
              </div>
            </div>
          )}
        </>
      ) : null}
      {view === "privacy" ? <PrivacyNotice /> : null}
      {message.length === 0 ? null : <p role="status" className="rounded-xl bg-[#FAF8F6] p-3 text-xs leading-relaxed">{message}</p>}
    </div>
  );

  const content = (
    <>
      <header className="flex items-center justify-between border-b border-[#F2EFED] px-4 pb-3 pt-4">
        <button type="button" onClick={view === "root" ? onClose : () => setView("root")} className={view === "root" && !desktop ? "invisible" : "text-[#A8A3A0]"} aria-label={view === "root" ? t("关闭") : t("返回设置")}>
          {view === "root" ? <Icon name="x" /> : <Icon name="chevron-left" />}
        </button>
        <span className="text-sm font-medium text-[#5A4C4A]">{title}</span>
        <span className="size-4" aria-hidden="true" />
      </header>
      {view === "root" ? rootContent : detailContent}
    </>
  );

  if (!desktop) {
    return (
      <section className="mx-5 mt-4 overflow-hidden rounded-2xl bg-white shadow-[0_1px_6px_rgba(90,76,74,0.06)]" aria-label={t("设置")}>
        {content}
      </section>
    );
  }
  return (
    <section className="fixed bottom-20 left-3 z-50 w-[222px] overflow-hidden rounded-2xl bg-white shadow-[0_-4px_40px_rgba(90,76,74,0.16),0_4px_20px_rgba(90,76,74,0.10)]" aria-label={t("设置")}>
      {content}
    </section>
  );
}

function formatBackupFileSize(byteSize: number, locale: "zh-CN" | "en"): string {
  const mebibytes = byteSize / (1024 * 1024);
  return locale === "en"
    ? `${mebibytes.toFixed(1)} MiB selected`
    : `已选择 ${mebibytes.toFixed(1)} MiB`;
}

function SettingsRow({
  label,
  value,
  disabled = false,
  last = false,
  onClick,
}: {
  readonly label: string;
  readonly value?: string;
  readonly disabled?: boolean;
  readonly last?: boolean;
  readonly onClick?: () => void;
}) {
  return (
    <div>
      <button type="button" disabled={disabled} onClick={onClick} className={`flex w-full items-center justify-between px-4 py-3.5 text-left text-sm ${disabled ? "text-[#AAA5A2]" : "text-[#6E6461] hover:bg-[#FAF8F6]"}`}>
        <span>{label}</span>
        <span className="flex items-center gap-2 text-xs text-[#AAA5A2]">{value}<Icon name="chevron-right" className={`size-4 ${disabled ? "opacity-30" : ""}`} /></span>
      </button>
      {last ? null : <div className="mx-4 h-px bg-[#F2EFED]" />}
    </div>
  );
}

function PrivacyNotice() {
  const { t } = useI18n();
  return (
    <div className="space-y-3 text-xs leading-relaxed text-[#7A7572]">
      <h3 className="text-sm font-medium text-[#5A4C4A]">{t("当前隐私边界")}</h3>
      {[
        "Beautio 当前是私人单用户库存工具，不提供公开账户注册。",
        "库存资料、成分、备注和产品图片保存在当前 Beautio 实例的私有存储中。",
        "管理页面不会把管理密钥写入浏览器持久存储；锁定页面后密钥会从当前标签页内存清除。",
        "通过 ChatGPT、Claude 或其他外部 Agent 使用 Beautio 时，对话内容和工具返回的数据会由相应平台按其政策处理。",
        "导出的备份未加密，含有私人库存与图片，应只保存在你信任的位置。",
        "本说明描述当前版本的实际行为；公开注册、多人数据隔离和通知功能尚未开放。",
      ].map((paragraph) => <p key={paragraph}>{t(paragraph)}</p>)}
    </div>
  );
}

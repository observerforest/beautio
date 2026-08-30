import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  AdminApiClient,
  AdminApiError,
  prepareBeautioBackupFile,
  type BackupDownload,
  type PreparedBeautioBackupFile,
} from "../../admin-api.ts";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { Logo } from "../../components/Logo.tsx";
import { Toast, ToastViewport } from "../../components/Toast.tsx";
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
        <button type="button" disabled title={t("护肤知识建设中")} className="flex size-12 items-center justify-center rounded-full text-[#DDD9D6]" aria-label={t("护肤知识建设中")}>
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
  readonly readOnly?: boolean;
  readonly client: AdminApiClient;
  readonly onLock: () => void;
  readonly onBackupRestored: (message: string) => Promise<void>;
}

/**
 * 渲染当前会话设置，不把尚未实现的账户功能伪装成可用能力。
 * Renders current-session settings without presenting unavailable account features as functional.
 *
 * @param props - 当前会话能力、备份客户端、显式锁定与恢复回调。 / Current-session capabilities, backup client, explicit lock, and restore callback.
 * @returns 与第二版 FigmaUI 对齐的响应式设置页。 / A responsive settings page aligned with the second FigmaUI revision.
 */
export function SettingsPanel({
  readOnly = false,
  client,
  onLock,
  onBackupRestored,
}: SettingsPanelProps) {
  const { locale, setLocale, t } = useI18n();
  const backupEnabled =
    !readOnly && import.meta.env.VITE_BEAUTIO_BACKUP_ENABLED === "true";
  const [view, setView] = useState<"root" | "backup" | "privacy">("root");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"error" | "info">("info");
  const [pendingBackup, setPendingBackup] = useState<PreparedBeautioBackupFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (message.length === 0) return;
    const timeoutId = window.setTimeout(
      () => setMessage(""),
      messageTone === "info" ? 4_000 : 8_000,
    );
    return () => window.clearTimeout(timeoutId);
  }, [message, messageTone]);

  const exportBackup = (): void => {
    setBusy(true);
    setMessage("");
    void client.downloadBackup().then((download) => {
      triggerBackupDownload(download);
      setMessageTone("info");
      setMessage(t("完整备份已导出。"));
    }).catch((error: unknown) => {
      setMessageTone("error");
      setMessage(backupErrorMessage(error, "备份导出失败。", t));
    }).finally(() => setBusy(false));
  };

  const chooseBackup = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    setMessage("");
    try {
      setPendingBackup(prepareBeautioBackupFile(file));
    } catch (error) {
      setPendingBackup(null);
      setMessageTone("error");
      setMessage(backupErrorMessage(error, "备份文件无法读取。", t));
    }
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
      setMessageTone("info");
      setMessage(restoredMessage);
      await onBackupRestored(restoredMessage);
    }).catch((error: unknown) => {
      setMessageTone("error");
      setMessage(backupErrorMessage(error, "备份恢复失败。", t));
    }).finally(() => setBusy(false));
  };

  const rootContent = (
    <>
      <section className="mb-3 overflow-hidden rounded-2xl bg-white shadow-[0_1px_8px_rgba(90,76,74,0.07)]">
        <SettingsRow icon="user" label={t("账户信息")} value={t("建设中")} disabled />
        <div className="flex items-center gap-3.5 px-5 py-3.5">
          <Icon name="globe" className="size-4 shrink-0 text-[#A8A3A0]" />
          <span className="min-w-0 flex-1 text-sm text-[#5A4C4A]">{t("语言")}</span>
          <div className="flex shrink-0 items-center gap-0.5 rounded-xl bg-[#F5F3F1] p-0.5">
            {(["zh-CN", "en"] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => setLocale(choice)}
                aria-pressed={locale === choice}
                className={`rounded-[10px] px-3 py-1.5 text-xs font-medium transition-all ${
                  locale === choice
                    ? "bg-white text-[#5A4C4A] shadow-[0_1px_4px_rgba(90,76,74,0.10)]"
                    : "text-[#A8A3A0]"
                }`}
              >
                {choice === "zh-CN" ? "简体中文" : "English"}
              </button>
            ))}
          </div>
        </div>
        <div className="mx-5 h-px bg-[#F2EFED]" />
        <SettingsRow
          icon="database"
          label={t("数据备份")}
          {...(backupEnabled
            ? { onClick: () => setView("backup") }
            : { value: t("建设中"), disabled: true })}
        />
        <SettingsRow icon="shield" label={t("隐私政策")} onClick={() => setView("privacy")} />
        <SettingsRow icon="bell" label={t("通知设置")} value={t("建设中")} disabled last />
      </section>

      <section className="overflow-hidden rounded-2xl bg-white shadow-[0_1px_8px_rgba(90,76,74,0.07)]">
        <button
          type="button"
          onClick={onLock}
          className="flex w-full items-center justify-center gap-2 py-4 text-sm font-medium text-[#9B7F7C] transition-colors hover:bg-stone-50"
        >
          <Icon name="logout" className="size-4" />
          {t("退出登录")}
        </button>
      </section>

      <p className="mt-8 text-center text-[11px] tracking-[0.04em] text-[#C4BFBC]">
        Beautio · Beauty in Flow
      </p>
    </>
  );

  const detailContent = (
    <>
      {view === "backup" ? (
        <>
          <SettingsSubHeader title={t("数据备份")} onBack={() => setView("root")} />
          <section className="mb-4 rounded-2xl bg-white p-6 shadow-[0_1px_8px_rgba(90,76,74,0.07)]">
            <h3 className="mb-2 text-sm font-semibold text-[#5A4C4A]">{t("备份当前数据")}</h3>
            <p className="mb-5 text-[13px] leading-relaxed text-[#8D8581]">
              {t("备份包含产品、库存、成分、备注与原始图片，不包含任何密钥。")}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={exportBackup}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#EEF1F4] py-3.5 text-sm font-medium text-[#4A6272] transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              <Icon name="download" className="size-4" />
              {busy ? t("正在导出…") : t("下载备份")}
            </button>
          </section>

          <section className="rounded-2xl bg-white p-6 shadow-[0_1px_8px_rgba(90,76,74,0.07)]">
            <h3 className="mb-2 text-sm font-semibold text-[#5A4C4A]">{t("从备份恢复")}</h3>
            <p className="mb-5 text-[13px] leading-relaxed text-[#8D8581]">
              {t("选择之前导出的备份文件。选择文件不会立即上传或修改数据。")}
            </p>
            <input ref={fileInputRef} type="file" accept=".beautio-backup,application/json" className="hidden" onChange={chooseBackup} />
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[#E0DBD8] py-3.5 text-sm text-[#5A4C4A] transition-colors hover:bg-stone-50 disabled:opacity-45"
            >
              <Icon name="folder" className="size-4" />
              {t("选择 .beautio-backup 文件")}
            </button>
            {pendingBackup === null ? null : (
              <div className="mt-4 rounded-xl bg-[#FAF8F6] p-4 text-xs leading-relaxed text-[#6E6461]">
                <p className="break-all">{pendingBackup.file.name}</p>
                <p className="mt-1 text-[#A8A3A0]">{formatBackupFileSize(pendingBackup.byteSize, locale)}</p>
                <p className="mt-2 text-[#A06E62]">{t("恢复会用备份内容替换当前全部库存，且无法撤销。操作前请核对文件。")}</p>
                <div className="mt-4 flex gap-2">
                  <button type="button" disabled={busy} onClick={() => setPendingBackup(null)} className="flex-1 rounded-xl border border-[#E5D8CF] py-2.5">{t("取消")}</button>
                  <button type="button" disabled={busy} onClick={restoreBackup} className="flex-1 rounded-xl bg-[#9B7F7C] py-2.5 text-white">{busy ? t("正在恢复…") : t("确认恢复")}</button>
                </div>
              </div>
            )}
          </section>
        </>
      ) : null}
      {view === "privacy" ? (
        <>
          <SettingsSubHeader title={t("隐私政策")} onBack={() => setView("root")} />
          <section className="rounded-2xl bg-white p-6 shadow-[0_1px_8px_rgba(90,76,74,0.07)]">
            <PrivacyNotice />
          </section>
        </>
      ) : null}
    </>
  );

  return (
    <>
      <section className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[#F5F3F1]" aria-label={t("设置")}>
        <div className="mx-auto max-w-xl px-5 pb-32 pt-5 md:pb-10 md:pt-10">
          {view === "root" ? rootContent : detailContent}
        </div>
      </section>
      {message.length === 0 ? null : (
        <ToastViewport>
          <Toast
            message={message}
            tone={messageTone}
            onDismiss={() => setMessage("")}
          />
        </ToastViewport>
      )}
    </>
  );
}

function formatBackupFileSize(byteSize: number, locale: "zh-CN" | "en"): string {
  const mebibytes = byteSize / (1024 * 1024);
  return locale === "en"
    ? `${mebibytes.toFixed(1)} MiB selected`
    : `已选择 ${mebibytes.toFixed(1)} MiB`;
}

/**
 * Starts a browser download from a Blob URL while keeping the URL alive long
 * enough for engines that consume the click asynchronously.
 *
 * @param download - Backup Blob and safe server-provided filename.
 * @returns Nothing after the download click has been dispatched.
 */
function triggerBackupDownload(download: BackupDownload): void {
  const url = URL.createObjectURL(download.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = download.filename;
  anchor.hidden = true;
  try {
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

function backupErrorMessage(
  error: unknown,
  fallback: string,
  translate: (source: string) => string,
): string {
  if (error instanceof AdminApiError) {
    const source = (() => {
      switch (error.code) {
        case "EMPTY_BACKUP":
          return "备份文件为空。";
        case "BACKUP_TOO_LARGE":
          return "备份文件超过 280 MiB 上限。";
        case "INVALID_INPUT":
          return "备份文件不是有效的 Beautio 备份。";
        case "UNSUPPORTED_MEDIA_TYPE":
          return "备份文件版本或内容无法识别。";
        case "UPLOAD_TOO_LARGE":
          return "备份图片超过 200 MiB 总上限。";
        case "UNAUTHORIZED":
          return "管理密钥无效或已撤销，请重新输入。库存没有被读取。";
        default:
          return fallback;
      }
    })();
    const message = translate(source);
    return error.status > 0 ? `${message} (HTTP ${error.status})` : message;
  }
  if (error instanceof TypeError) {
    return translate("无法连接 Beautio 服务，请确认服务正在运行。");
  }
  return translate(fallback);
}

function SettingsSubHeader({
  title,
  onBack,
}: {
  readonly title: string;
  readonly onBack: () => void;
}) {
  const { t } = useI18n();
  return (
    <header className="mb-5 flex items-center">
      <button
        type="button"
        onClick={onBack}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-[#A8A3A0] transition-colors hover:bg-black/5"
        aria-label={t("返回设置")}
      >
        <Icon name="chevron-left" className="size-5" />
      </button>
      <h2 className="min-w-0 flex-1 pr-8 text-center text-[15px] font-semibold tracking-[0.02em] text-[#5A4C4A]">
        {title}
      </h2>
    </header>
  );
}

function SettingsRow({
  icon,
  label,
  value,
  disabled = false,
  last = false,
  onClick,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly value?: string;
  readonly disabled?: boolean;
  readonly last?: boolean;
  readonly onClick?: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={`flex w-full items-center gap-3.5 px-5 py-4 text-left transition-colors ${
          disabled ? "cursor-default text-[#C4BFBC]" : "text-[#5A4C4A] hover:bg-black/[0.025] active:bg-black/[0.04]"
        }`}
      >
        <Icon name={icon} className={`size-4 shrink-0 ${disabled ? "text-[#D0CBC8]" : "text-[#A8A3A0]"}`} />
        <span className="min-w-0 flex-1 text-sm">{label}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-[#A8A3A0]">
          {value}
          <Icon name="chevron-right" className={`size-4 ${disabled ? "opacity-30" : ""}`} />
        </span>
      </button>
      {last ? null : <div className="mx-5 h-px bg-[#F2EFED]" />}
    </div>
  );
}

function PrivacyNotice() {
  const { t } = useI18n();
  return (
    <div className="space-y-4 text-[13px] leading-relaxed text-[#6B6460]">
      <h3 className="mb-5 text-[13px] font-semibold text-[#5A4C4A]">{t("当前隐私边界")}</h3>
      {[
        "Beautio 当前是私人单用户库存工具，不提供公开账户注册。",
        "库存资料、成分、备注和产品图片保存在当前 Beautio 实例的私有存储中。",
        "管理页面不会把管理密钥写入浏览器持久存储；锁定页面后密钥会从当前标签页内存清除。",
        "通过 ChatGPT、Claude 或其他外部 Agent 使用 Beautio 时，对话内容和工具返回的数据会由相应平台按其政策处理。",
        "导出的备份未加密，含有私人库存与图片，应只保存在你信任的位置。",
        "本说明描述当前版本的实际行为；公开注册、多人数据隔离和通知功能仍在建设中。",
      ].map((paragraph) => <p key={paragraph}>{t(paragraph)}</p>)}
    </div>
  );
}

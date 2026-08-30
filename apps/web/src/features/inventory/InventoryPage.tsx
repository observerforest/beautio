import type { InventoryListItemOutput, InventoryListOutput } from "@beautio/contracts";
import { useEffect, useMemo, useState } from "react";
import { AdminApiClient } from "../../admin-api.ts";
import { Icon } from "../../components/Icon.tsx";
import { Logo } from "../../components/Logo.tsx";
import { Toast, ToastViewport } from "../../components/Toast.tsx";
import { useI18n } from "../../i18n.tsx";
import {
  inventoryCardViews,
  projectInventoryBrowse,
  type InventoryBrowseOptions,
  type InventoryCollectionView,
  type InventoryStatusFilter,
} from "./models/index.ts";
import { BottleEditorDialog } from "./BottleEditorDialog.tsx";
import {
  BrowseToolbar,
  CollectionTabs,
  InventoryFilterControls,
  InventorySearchField,
  StatusTabs,
} from "./InventoryControls.tsx";
import { DesktopSidebar, MobileNavigation, SettingsPanel } from "./InventoryNavigation.tsx";
import { NotesEditorDialog } from "./NotesEditorDialog.tsx";
import { ProductCard } from "./ProductCard.tsx";
import { ProductDetailDialog } from "./ProductDetailDialog.tsx";
import { ProductEditorDialog } from "./ProductEditorDialog.tsx";

type DialogMode = "detail" | "edit-product" | "edit-bottle" | "edit-notes";

export interface InventoryPageProps {
  readonly client: AdminApiClient;
  readonly inventory: InventoryListOutput;
  readonly readError: string | null;
  readonly statusMessage: string | null;
  readonly readOnly?: boolean;
  readonly onStatusMessage: (message: string | null) => void;
  readonly onDismissReadError: () => void;
  readonly onRefresh: (showLoading?: boolean) => Promise<boolean>;
  readonly onLock: (message: string) => void;
  readonly onDialogOpenChange: (open: boolean) => void;
}

const initialBrowseOptions: InventoryBrowseOptions = {
  view: "active",
  status: "opened",
  query: "",
  brand: null,
  category: null,
  sort: "deadline-asc",
};

/**
 * 围绕真实 Core API 快照组合已认证的 Figma 库存界面。
 * Composes the authenticated Figma inventory shell around the real Core API snapshot.
 *
 * @param props - 已认证客户端、源库存、反馈、刷新、锁定和模态框回调。 / Authenticated client, source inventory, feedback, refresh, lock, and modal callbacks.
 * @returns 响应式库存导航、浏览、卡片、设置和写入对话框。 / Responsive inventory navigation, browsing, cards, settings, and write dialogs.
 */
export function InventoryPage({
  client,
  inventory,
  readError,
  statusMessage,
  readOnly = false,
  onStatusMessage,
  onDismissReadError,
  onRefresh,
  onLock,
  onDialogOpenChange,
}: InventoryPageProps) {
  const { t } = useI18n();
  const [browseOptions, setBrowseOptions] = useState<InventoryBrowseOptions>(initialBrowseOptions);
  const [queryInput, setQueryInput] = useState("");
  const [mobilePage, setMobilePage] = useState<"inventory" | "settings">("inventory");
  const [desktopSettingsOpen, setDesktopSettingsOpen] = useState(false);
  const [selectedInventoryItemId, setSelectedInventoryItemId] = useState<string | null>(null);
  const [dialogMode, setDialogMode] = useState<DialogMode>("detail");
  const [animateDetailEnter, setAnimateDetailEnter] = useState(true);
  const [editorItemFingerprint, setEditorItemFingerprint] = useState<string | null>(null);
  const [dialogFeedback, setDialogFeedback] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setBrowseOptions((current) => ({ ...current, query: queryInput }));
    }, 140);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  const projection = useMemo(
    () => projectInventoryBrowse(inventory.items, browseOptions),
    [browseOptions, inventory.items],
  );
  const selectedItem = useMemo(
    () => selectedInventoryItemId === null
      ? null
      : inventory.items.find((item) => item.inventory_item_id === selectedInventoryItemId) ?? null,
    [inventory.items, selectedInventoryItemId],
  );
  const finishedCount = useMemo(
    () => inventory.items.filter((item) => item.lifecycle_status === "finished").length,
    [inventory.items],
  );
  const discardedCount = useMemo(
    () => inventory.items.filter((item) => item.lifecycle_status === "discarded").length,
    [inventory.items],
  );
  const selectedItemFingerprint = selectedItem === null ? null : inventoryItemFingerprint(selectedItem);
  const editorSnapshotChanged =
    dialogMode !== "detail" &&
    editorItemFingerprint !== null &&
    selectedItemFingerprint !== null &&
    editorItemFingerprint !== selectedItemFingerprint;

  useEffect(() => {
    const selectedBrand = browseOptions.brand;
    if (selectedBrand === null) return;
    const canonicalBrand = projection.brandChoices.find(
      (choice) => choice.toLowerCase() === selectedBrand.toLowerCase(),
    );
    if (canonicalBrand === undefined) {
      setBrowseOptions((current) => ({ ...current, brand: null }));
    } else if (canonicalBrand !== selectedBrand) {
      setBrowseOptions((current) => ({ ...current, brand: canonicalBrand }));
    }
  }, [browseOptions.brand, projection.brandChoices]);

  useEffect(() => {
    if (
      browseOptions.category !== null &&
      !projection.categoryChoices.includes(browseOptions.category)
    ) {
      setBrowseOptions((current) => ({ ...current, category: null }));
    }
  }, [browseOptions.category, projection.categoryChoices]);

  useEffect(() => {
    if (selectedInventoryItemId !== null && selectedItem === null) {
      setSelectedInventoryItemId(null);
      setEditorItemFingerprint(null);
    }
  }, [selectedInventoryItemId, selectedItem]);

  useEffect(() => {
    if (!editorSnapshotChanged) return;
    setSelectedInventoryItemId(null);
    setDialogMode("detail");
    setEditorItemFingerprint(null);
    onStatusMessage(t("这条库存已被新读取结果更新。为避免旧草稿覆盖新事实，编辑器已关闭，请重新打开。"));
  }, [editorSnapshotChanged, onStatusMessage, t]);

  const dialogOpen = selectedItem !== null && !editorSnapshotChanged;
  useEffect(() => {
    onDialogOpenChange(dialogOpen);
    return () => onDialogOpenChange(false);
  }, [dialogOpen, onDialogOpenChange]);

  const changeCollection = (view: InventoryCollectionView): void => {
    setMobilePage("inventory");
    setBrowseOptions((current) => ({
      ...current,
      view,
      status: view === "active" ? "opened" : "all",
      brand: null,
      category: null,
    }));
    setSelectedInventoryItemId(null);
  };

  const changeStatus = (status: InventoryStatusFilter): void => {
    if (browseOptions.view === "archive") return;
    setBrowseOptions((current) => ({ ...current, status }));
    setSelectedInventoryItemId(null);
  };

  const openDetail = (item: InventoryListItemOutput): void => {
    setDialogFeedback(t("选择编辑入口后才会产生可保存的修改。"));
    setAnimateDetailEnter(true);
    setDialogMode("detail");
    setEditorItemFingerprint(null);
    setSelectedInventoryItemId(item.inventory_item_id);
  };

  const closeDialog = (): void => {
    setSelectedInventoryItemId(null);
    setAnimateDetailEnter(true);
    setDialogMode("detail");
    setEditorItemFingerprint(null);
  };

  const returnToDetail = (message: string): void => {
    setDialogFeedback(message);
    setDialogMode("detail");
    setEditorItemFingerprint(null);
  };

  const openEditor = (mode: Exclude<DialogMode, "detail">): void => {
    if (readOnly || selectedItem === null) return;
    setAnimateDetailEnter(false);
    setEditorItemFingerprint(inventoryItemFingerprint(selectedItem));
    setDialogMode(mode);
  };

  const handleCommitted = async (
    inventoryItemId: string,
    message: string,
  ): Promise<boolean> => {
    const refreshed = await onRefresh(false);
    if (!refreshed) return false;
    setSelectedInventoryItemId(inventoryItemId);
    setDialogFeedback(message);
    setDialogMode("detail");
    setEditorItemFingerprint(null);
    onStatusMessage(message);
    return true;
  };

  const clearFilters = (): void => {
    setQueryInput("");
    setBrowseOptions((current) => ({
      ...current,
      query: "",
      brand: null,
      category: null,
      status: current.view === "active" ? "opened" : "all",
    }));
  };

  const cardViews = inventoryCardViews(projection.items);
  const hasNonDefaultFilters =
    browseOptions.query.trim().length > 0 ||
    browseOptions.brand !== null ||
    browseOptions.category !== null ||
    browseOptions.status !== (browseOptions.view === "active" ? "opened" : "all");
  const lock = (message?: string): void => {
    setSelectedInventoryItemId(null);
    setDesktopSettingsOpen(false);
    onLock(message ?? t("管理页已锁定，密钥已从当前标签页内存清除。"));
  };
  const handleBackupRestored = async (message: string): Promise<void> => {
    client.revokeAllObjectUrls();
    const refreshed = await onRefresh(false);
    if (!refreshed) {
      throw new Error(t("备份已恢复，但库存页面刷新失败，请手动刷新页面。"));
    }
    onStatusMessage(message);
  };

  return (
    <div className="h-dvh overflow-hidden bg-[#F5F3F1] text-[#5A4C4A] md:h-auto md:min-h-screen md:overflow-visible">
      <DesktopSidebar
        view={browseOptions.view}
        counts={projection.counts}
        settingsOpen={desktopSettingsOpen}
        onViewChange={(view) => {
          changeCollection(view);
          setDesktopSettingsOpen(false);
        }}
        onSettingsToggle={() => setDesktopSettingsOpen((open) => !open)}
      />

      <div className="flex h-full min-h-0 flex-col overflow-hidden md:ml-60 md:block md:h-auto md:min-h-screen md:overflow-visible">
        <header className="z-20 shrink-0 bg-white shadow-[0_1px_0_rgba(229,216,207,0.5)] md:hidden">
          <div className={`beautio-safe-top px-5 ${mobilePage === "settings" ? "pb-2" : ""}`}>
            <div className={`relative flex items-center gap-3 ${mobilePage === "settings" ? "" : "mb-4"}`}>
              <Logo className="h-6 w-auto max-w-[110px] object-contain object-left" />
              {mobilePage === "settings" ? (
                <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-sm tracking-[0.08em] text-[#5A4C4A]">
                  {t("设置")}
                </span>
              ) : (
                <InventorySearchField compact query={queryInput} onQueryChange={setQueryInput} />
              )}
            </div>
            {mobilePage === "inventory" ? (
              <CollectionTabs compact view={browseOptions.view} counts={projection.counts} onChange={changeCollection} />
            ) : null}
          </div>
        </header>

        {mobilePage === "settings" ? (
          <main className="flex min-h-0 flex-1 md:hidden">
            <SettingsPanel
              readOnly={readOnly}
              client={client}
              onLock={() => lock()}
              onBackupRestored={handleBackupRestored}
            />
          </main>
        ) : (
          <InventorySurface
            inventory={inventory}
            client={client}
            projection={projection}
            cardViews={cardViews}
            browseOptions={browseOptions}
            queryInput={queryInput}
            finishedCount={finishedCount}
            discardedCount={discardedCount}
            readOnly={readOnly}
            hasNonDefaultFilters={hasNonDefaultFilters}
            onQueryInput={setQueryInput}
            onBrowseOptions={setBrowseOptions}
            onStatusChange={changeStatus}
            onClearFilters={clearFilters}
            onOpenDetail={openDetail}
            onUnauthorized={lock}
          />
        )}
      </div>

      {mobilePage === "inventory" && !readOnly ? (
        <button type="button" disabled title={t("添加产品建设中")} className="fixed bottom-24 right-5 z-30 flex size-12 items-center justify-center rounded-full bg-[linear-gradient(135deg,#9B7F7C,#B3A0AD)] text-white shadow-[0_4px_18px_rgba(155,127,124,0.38)] md:hidden" aria-label={t("添加产品建设中")}>
          <Icon name="plus" />
        </button>
      ) : null}
      <MobileNavigation active={mobilePage} onChange={setMobilePage} />

      {readError === null && statusMessage === null ? null : (
        <ToastViewport>
          {readError === null ? null : (
            <Toast
              message={`${t("库存重新读取失败：")}${readError}`}
              action={{ label: t("再试一次"), onClick: () => void onRefresh() }}
              onDismiss={onDismissReadError}
            />
          )}
          {statusMessage === null ? null : (
            <Toast
              message={statusMessage}
              tone="info"
              onDismiss={() => onStatusMessage(null)}
            />
          )}
        </ToastViewport>
      )}

      {desktopSettingsOpen ? (
        <div className="fixed inset-y-0 left-60 right-0 z-20 hidden bg-[#F5F3F1] md:flex">
          <SettingsPanel
            readOnly={readOnly}
            client={client}
            onLock={() => lock()}
            onBackupRestored={handleBackupRestored}
          />
        </div>
      ) : null}

      {selectedItem === null || editorSnapshotChanged ? null : (
        <InventoryDialog
          mode={dialogMode}
          item={selectedItem}
          asOf={inventory.as_of}
          client={client}
          feedback={dialogFeedback}
          animateDetailEnter={animateDetailEnter}
          onClose={closeDialog}
          onMode={openEditor}
          onReturn={returnToDetail}
          onCommitted={handleCommitted}
          onUnauthorized={lock}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}

interface InventorySurfaceProps {
  readonly inventory: InventoryListOutput;
  readonly client: AdminApiClient;
  readonly projection: ReturnType<typeof projectInventoryBrowse>;
  readonly cardViews: ReturnType<typeof inventoryCardViews>;
  readonly browseOptions: InventoryBrowseOptions;
  readonly queryInput: string;
  readonly finishedCount: number;
  readonly discardedCount: number;
  readonly readOnly: boolean;
  readonly hasNonDefaultFilters: boolean;
  readonly onQueryInput: (query: string) => void;
  readonly onBrowseOptions: React.Dispatch<React.SetStateAction<InventoryBrowseOptions>>;
  readonly onStatusChange: (status: InventoryStatusFilter) => void;
  readonly onClearFilters: () => void;
  readonly onOpenDetail: (item: InventoryListItemOutput) => void;
  readonly onUnauthorized: (message: string) => void;
}

function InventorySurface({
  client,
  projection,
  cardViews,
  browseOptions,
  queryInput,
  finishedCount,
  discardedCount,
  readOnly,
  hasNonDefaultFilters,
  onQueryInput,
  onBrowseOptions,
  onStatusChange,
  onClearFilters,
  onOpenDetail,
  onUnauthorized,
}: InventorySurfaceProps) {
  const { t } = useI18n();
  return (
    <main className="flex min-h-0 flex-1 flex-col md:block md:min-h-screen md:pb-12">
      <div className="hidden border-b border-[#E5D8CF] bg-white px-8 py-4 md:block">
        <BrowseToolbar
          query={queryInput}
          brand={browseOptions.brand}
          brands={projection.brandChoices}
          category={browseOptions.category}
          categories={projection.categoryChoices}
          sort={browseOptions.sort}
          onQueryChange={onQueryInput}
          onBrandChange={(brand) => onBrowseOptions((current) => ({ ...current, brand }))}
          onCategoryChange={(category) => onBrowseOptions((current) => ({ ...current, category }))}
          onSortChange={(sort) => onBrowseOptions((current) => ({ ...current, sort }))}
        />
        {readOnly ? null : (
          <button type="button" disabled title={t("添加产品建设中")} className="absolute right-8 top-4 hidden items-center gap-2 rounded-full bg-[linear-gradient(120deg,#9B7F7C,#B3A0AD)] px-5 py-2.5 text-sm text-white opacity-45 xl:flex">
            <Icon name="plus" />{t("添加产品")}
          </button>
        )}
      </div>

      <div className="shrink-0 bg-[#F5F3F1] px-5 pb-2 pt-3 md:hidden">
        <div className="mb-3">
          <StatusTabs
            view={browseOptions.view}
            status={browseOptions.status}
            counts={projection.counts}
            finishedCount={finishedCount}
            discardedCount={discardedCount}
            onChange={onStatusChange}
          />
        </div>
        <InventoryFilterControls
          brand={browseOptions.brand}
          brands={projection.brandChoices}
          category={browseOptions.category}
          categories={projection.categoryChoices}
          sort={browseOptions.sort}
          onBrandChange={(brand) => onBrowseOptions((current) => ({ ...current, brand }))}
          onCategoryChange={(category) => onBrowseOptions((current) => ({ ...current, category }))}
          onSortChange={(sort) => onBrowseOptions((current) => ({ ...current, sort }))}
        />
      </div>

      <div className="hidden px-8 pb-3 pt-4 md:block">
        <StatusTabs
          view={browseOptions.view}
          status={browseOptions.status}
          counts={projection.counts}
          finishedCount={finishedCount}
          discardedCount={discardedCount}
          onChange={onStatusChange}
        />
      </div>

      <div className="beautio-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-32 pt-1 md:overflow-visible md:px-8 md:pb-0 md:pt-0">
        {readOnly ? (
          <div className="mb-4 flex items-center gap-2 rounded-2xl bg-[#EEF1F4] px-4 py-3 text-sm text-[#4A6272]" role="status">
            <Icon name="info" className="size-4 shrink-0" />
            <span>{t("正在实时查看生产数据 · 本地只读，不会修改生产库存")}</span>
          </div>
        ) : null}
        {projection.items.length === 0 ? (
          <section className="flex flex-col items-center gap-3 py-20 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-[#E5D8CF] text-[#9B7F7C]"><Icon name="search" /></div>
            <h2 className="text-sm font-medium text-[#5A4C4A]">{t("暂时没有结果")}</h2>
            <p className="max-w-sm text-sm text-[#A8A3A0]">{t(projection.emptyCopy ?? "当前没有库存。")}</p>
            {hasNonDefaultFilters ? <button type="button" onClick={onClearFilters} className="mt-2 rounded-full border border-[#D8D4D1] px-4 py-2 text-xs text-[#7A7572]">{t("清除筛选")}</button> : null}
          </section>
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-3 lg:grid-cols-4 md:gap-4">
            {projection.items.map((item, index) => {
              const view = cardViews[index];
              if (view === undefined) return null;
              return (
                <ProductCard
                  key={item.inventory_item_id}
                  item={item}
                  view={view}
                  client={client}
                  onOpen={() => onOpenDetail(item)}
                  onUnauthorized={onUnauthorized}
                />
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

interface InventoryDialogProps {
  readonly mode: DialogMode;
  readonly item: InventoryListItemOutput;
  readonly asOf: string;
  readonly client: AdminApiClient;
  readonly feedback: string;
  readonly animateDetailEnter: boolean;
  readonly onClose: () => void;
  readonly onMode: (mode: Exclude<DialogMode, "detail">) => void;
  readonly onReturn: (message: string) => void;
  readonly onCommitted: (inventoryItemId: string, message: string) => Promise<boolean>;
  readonly onUnauthorized: (message: string) => void;
  readonly readOnly: boolean;
}

function InventoryDialog({
  mode,
  item,
  asOf,
  client,
  feedback,
  animateDetailEnter,
  onClose,
  onMode,
  onReturn,
  onCommitted,
  onUnauthorized,
  readOnly,
}: InventoryDialogProps) {
  const { t } = useI18n();
  if (readOnly && mode !== "detail") {
    return null;
  }
  if (mode === "edit-product") {
    if (item.product === null) return null;
    return (
      <ProductEditorDialog
        item={item}
        product={item.product}
        client={client}
        onCancel={() => onReturn(t("已取消产品编辑，没有保存任何修改。"))}
        onCommitted={onCommitted}
        onUnauthorized={onUnauthorized}
      />
    );
  }
  if (mode === "edit-bottle") {
    if (item.lifecycle_status !== "unopened" && item.lifecycle_status !== "opened") return null;
    return (
      <BottleEditorDialog
        item={item}
        initialLifecycle={item.lifecycle_status}
        client={client}
        onCancel={() => onReturn(t("已取消单瓶编辑，没有保存任何修改。"))}
        onCommitted={onCommitted}
        onUnauthorized={onUnauthorized}
      />
    );
  }
  if (mode === "edit-notes") {
    return (
      <NotesEditorDialog
        item={item}
        client={client}
        onCancel={() => onReturn(t("已取消自定义备注编辑，没有保存任何修改。"))}
        onCommitted={onCommitted}
        onUnauthorized={onUnauthorized}
      />
    );
  }
  return (
    <ProductDetailDialog
      item={item}
      asOf={asOf}
      client={client}
      feedback={feedback}
      animateMobileEnter={animateDetailEnter}
      readOnly={readOnly}
      onClose={onClose}
      onEditProduct={() => onMode("edit-product")}
      onEditBottle={() => onMode("edit-bottle")}
      onEditNotes={() => onMode("edit-notes")}
      onUnauthorized={onUnauthorized}
    />
  );
}

function inventoryItemFingerprint(item: InventoryListItemOutput): string {
  return JSON.stringify(item);
}

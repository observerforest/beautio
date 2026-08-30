import { Icon } from "../../components/Icon.tsx";
import { SelectMenu, type SelectMenuOption } from "../../components/SelectMenu.tsx";
import { useI18n } from "../../i18n.tsx";
import type {
  InventoryBrowseCounts,
  InventoryCollectionView,
  InventorySortOption,
  InventoryStatusFilter,
} from "./models/index.ts";

export interface CollectionTabsProps {
  readonly view: InventoryCollectionView;
  readonly counts: Pick<InventoryBrowseCounts, "active" | "archive">;
  readonly compact?: boolean;
  readonly onChange: (view: InventoryCollectionView) => void;
}

/**
 * 渲染在库/归档导航，并让尚不可用的愿望清单界面保持无操作。
 * Renders active/archive navigation while keeping unavailable wishlist UI inert.
 *
 * @param props - 当前集合、源数据计数、紧凑模式与切换回调。 / Current collection, source counts, compact mode, and change callback.
 * @returns 符合 Figma 的页签或侧栏语义导航。 / Figma-aligned navigation with tab or sidebar semantics.
 */
export function CollectionTabs({ view, counts, compact = false, onChange }: CollectionTabsProps) {
  const { t } = useI18n();
  const definitions = [
    { key: "active" as const, label: "库存", count: counts.active, icon: "box" as const },
    { key: "archive" as const, label: "已归档", count: counts.archive, icon: "archive" as const },
  ];
  if (compact) {
    const activeIndex = view === "active" ? 0 : 1;
    return (
      <div className="relative grid min-w-0 grid-cols-3 items-center" role="tablist" aria-label={t("库存范围")}>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-0 h-0.5 w-1/3 rounded-full bg-[#AEB7C1] transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
          style={{ transform: `translateX(${activeIndex * 100}%)` }}
        />
        {definitions.map((definition) => {
          const selected = definition.key === view;
          return (
            <button
              key={definition.key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onChange(definition.key)}
              className={`flex min-w-0 items-center justify-center gap-1 py-2.5 text-xs duration-200 transition-colors ${
                selected
                  ? "font-medium text-[#AEB7C1]"
                  : "font-normal text-[#A8A3A0]"
              }`}
            >
              <Icon name={definition.icon} className="size-3.5 shrink-0" />
              <span className="truncate">{t(definition.label)}</span>
            </button>
          );
        })}
        <button
          type="button"
          role="tab"
          aria-selected="false"
          disabled
          title={t("愿望清单建设中")}
          className="flex min-w-0 items-center justify-center gap-1 py-2.5 text-xs font-normal text-[#A8A3A0]"
        >
          <Icon name="heart" className="size-3.5 shrink-0" />
          <span className="truncate">{t("愿望清单")}</span>
        </button>
      </div>
    );
  }

  return (
    <nav className="space-y-1" aria-label={t("库存范围")}>
      {definitions.map((definition) => {
        const selected = definition.key === view;
        return (
          <button
            key={definition.key}
            type="button"
            aria-pressed={selected}
            aria-label={`${t(definition.label)} ${definition.count}`}
            onClick={() => onChange(definition.key)}
            className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
              selected ? "bg-[#EEF1F4] font-medium text-[#5A4C4A]" : "text-[#7A7572] hover:bg-[#F8F6F4]"
            }`}
          >
            <span className="flex items-center gap-2"><Icon name={definition.icon} className="size-4" />{t(definition.label)}</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${selected ? "bg-[#DDE4EA] text-[#4A6272]" : "bg-[#F0EDE8] text-[#A8A3A0]"}`}>
              {definition.count}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        disabled
        title={t("愿望清单建设中")}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-[#CBC6C3]"
      >
        <Icon name="heart" className="size-4" />{t("愿望清单")}
      </button>
    </nav>
  );
}

export interface StatusTabsProps {
  readonly view: InventoryCollectionView;
  readonly status: InventoryStatusFilter;
  readonly counts: InventoryBrowseCounts;
  readonly finishedCount: number;
  readonly discardedCount: number;
  readonly onChange: (status: InventoryStatusFilter) => void;
}

/**
 * 根据源快照渲染在库状态筛选，或真实归档计数。
 * Renders active inventory filters or factual archive counts from the source snapshot.
 *
 * @param props - 集合范围、已选筛选、源数据计数与筛选回调。 / Collection scope, selected filter, source counts, and filter callback.
 * @returns 紧凑的四格 Figma 状态栏。 / A compact four-cell Figma status bar.
 */
export function StatusTabs({
  view,
  status,
  counts,
  finishedCount,
  discardedCount,
  onChange,
}: StatusTabsProps) {
  const { locale, t } = useI18n();
  if (view === "archive") {
    const archive = [
      { label: "已归档", count: counts.archive, icon: "archive" as const },
      { label: "已用完", count: finishedCount, icon: "opened" as const },
      { label: "已弃置", count: discardedCount, icon: "bell" as const },
    ];
    return (
      <div className="grid grid-cols-3 overflow-hidden rounded-2xl border border-[#E5D8CF] bg-white" aria-label={t("已归档库存摘要")}>
        {archive.map((entry, index) => (
          <span key={entry.label} className={`flex items-center justify-center gap-1 py-2 text-[#7A7572] ${index < archive.length - 1 ? "border-r border-[#E5D8CF]" : ""}`}>
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
              <Icon
                name={entry.icon}
                className={entry.icon === "opened" ? "size-4 -translate-y-px" : "size-3"}
              />
            </span>
            <span className="text-[10px]">{t(entry.label)}</span>
            <strong className="text-[10px]">{entry.count}</strong>
          </span>
        ))}
      </div>
    );
  }

  const definitions = [
    { key: "opened" as const, label: "已开封", compactEnglishLabel: "Open", count: counts.opened, icon: "opened" as const, color: "#9B7F7C" },
    { key: "unopened" as const, label: "未开封", compactEnglishLabel: "Sealed", count: counts.unopened, icon: "sealed" as const, color: "#7A8793" },
    { key: "attention" as const, label: "需留意", compactEnglishLabel: "Alerts", count: counts.attention, icon: "bell" as const, color: "#C07A5A" },
    { key: "all" as const, label: "总库存", compactEnglishLabel: "Total", count: counts.active, icon: "grid" as const, color: "#5A4C4A" },
  ];
  return (
    <div className="grid grid-cols-4 overflow-hidden rounded-2xl border border-[#E5D8CF] bg-white" aria-label={t("库存状态筛选")}>
      {definitions.map((definition, index) => {
        const selected = status === definition.key;
        return (
          <button
            key={definition.key}
            type="button"
            aria-pressed={selected}
            aria-label={`${t(definition.label)} ${definition.count}`}
            onClick={() => onChange(definition.key)}
            className={`flex min-w-0 items-center justify-center py-2 transition-colors ${locale === "en" ? "gap-0.5" : "gap-1"} ${index < definitions.length - 1 ? "border-r border-[#E5D8CF]" : ""} ${selected ? "bg-[#FAF9F8]" : "bg-white"}`}
            style={{ color: selected ? definition.color : "#A8A3A0" }}
          >
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
              <Icon
                name={definition.icon}
                className={
                  definition.icon === "opened" || definition.icon === "sealed"
                    ? "size-4 -translate-y-px"
                    : "size-3"
                }
              />
            </span>
            <span className="hidden whitespace-nowrap text-[10px] min-[320px]:inline">
              {locale === "en" ? definition.compactEnglishLabel : t(definition.label)}
            </span>
            <strong className="shrink-0 text-[10px]">{definition.count}</strong>
          </button>
        );
      })}
    </div>
  );
}

export interface BrowseToolbarProps {
  readonly query: string;
  readonly brand: string | null;
  readonly brands: readonly string[];
  readonly category: string | null;
  readonly categories: readonly string[];
  readonly sort: InventorySortOption;
  readonly onQueryChange: (query: string) => void;
  readonly onBrandChange: (brand: string | null) => void;
  readonly onCategoryChange: (category: string | null) => void;
  readonly onSortChange: (sort: InventorySortOption) => void;
}

export interface InventorySearchFieldProps {
  readonly query: string;
  readonly compact?: boolean;
  readonly onQueryChange: (query: string) => void;
}

/**
 * 以桌面工具栏或移动端标题栏形态渲染共享库存搜索框。
 * Renders the shared inventory search field in desktop-toolbar or mobile-header form.
 *
 * @param props - 当前查询、紧凑展示模式与输入回调。 / Current query, compact presentation, and input callback.
 * @returns 基于真实库存事实而非模拟品牌数据的搜索输入框。 / A real search input backed by inventory facts rather than mock brand data.
 */
export function InventorySearchField({
  query,
  compact = false,
  onQueryChange,
}: InventorySearchFieldProps) {
  const { t } = useI18n();
  return (
    <label
      className={`flex min-w-0 items-center gap-2 rounded-full border border-[#DDD9D6] bg-white ${
        compact ? "flex-1 px-3 py-2" : "flex-1 px-4 py-2.5 md:max-w-[380px]"
      }`}
    >
      <Icon name="search" className="size-4 shrink-0 text-[#B0AAA7]" />
      <span className="sr-only">{t("搜索库存")}</span>
      <input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        autoComplete="off"
        placeholder={compact ? t("搜索库存") : t("搜索产品、别名、品牌、品类或备注")}
        title={t("可搜产品、品牌、成分、备注等")}
        className={`min-w-0 flex-1 bg-transparent font-light text-[#5A4C4A] outline-none placeholder:text-stone-400 ${
          compact ? "text-xs" : "text-sm"
        }`}
      />
    </label>
  );
}

export interface InventoryFilterControlsProps {
  readonly brand: string | null;
  readonly brands: readonly string[];
  readonly category: string | null;
  readonly categories: readonly string[];
  readonly sort: InventorySortOption;
  readonly onBrandChange: (brand: string | null) => void;
  readonly onCategoryChange: (category: string | null) => void;
  readonly onSortChange: (sort: InventorySortOption) => void;
}

/**
 * 渲染由真实库存数据支持的品牌、品类与排序控件。
 * Renders the brand, category, and sort controls backed by real inventory data.
 *
 * @param props - 当前筛选、可用品类与切换回调。 / Current filters, available categories, and change callbacks.
 * @returns 可复用的 Figma 筛选胶囊行。 / The reusable Figma filter-chip row.
 */
export function InventoryFilterControls({
  brand,
  brands,
  category,
  categories,
  sort,
  onBrandChange,
  onCategoryChange,
  onSortChange,
}: InventoryFilterControlsProps) {
  const { t } = useI18n();
  const brandOptions: readonly SelectMenuOption<string>[] = [
    { value: "", label: t("全部品牌") },
    ...brands.map((choice) => ({ value: choice, label: choice })),
  ];
  const orderedCategories = [
    ...categories.filter((choice) => choice !== "其他"),
    ...categories.filter((choice) => choice === "其他"),
  ];
  const categoryOptions: readonly SelectMenuOption<string>[] = [
    { value: "", label: t("全部品类") },
    ...orderedCategories.map((choice) => ({ value: choice, label: choice })),
  ];
  const sortOptions: readonly SelectMenuOption<InventorySortOption>[] = [
    { value: "deadline-asc", label: t("按临期排序"), icon: "calendar" },
    { value: "created-desc", label: t("按最近添加"), icon: "sort" },
  ];
  const selectedSortLabel = sortOptions.find((option) => option.value === sort)?.label ?? t("排序");

  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-visible md:gap-2">
      <SelectMenu
        value={brand ?? ""}
        options={brandOptions}
        onChange={(nextBrand) => onBrandChange(nextBrand || null)}
        ariaLabel={t("按品牌筛选")}
        leadingIcon="tag"
        triggerLabel={brand ?? t("品牌")}
        variant="compact"
        disabled={brands.length === 0}
        className="min-w-0 shrink md:shrink-0"
        buttonClassName="flex w-auto max-w-full min-w-0 items-center justify-center gap-1 rounded-full border border-[#D8D4D1] px-2.5 py-1.5 text-xs text-[#7A7572] transition-all disabled:cursor-not-allowed disabled:opacity-45 md:gap-1.5 md:px-3"
        menuClassName="left-0"
      />

      <SelectMenu
        value={category ?? ""}
        options={categoryOptions}
        onChange={(nextCategory) => onCategoryChange(nextCategory || null)}
        ariaLabel={t("按品类筛选")}
        leadingIcon="category"
        triggerLabel={category ?? t("全部品类")}
        variant="compact"
        menuSize="narrow"
        className="min-w-0 shrink md:shrink-0"
        buttonClassName="flex w-auto max-w-full min-w-0 items-center justify-center gap-1 rounded-full border border-[#D8D4D1] px-2.5 py-1.5 text-xs text-[#7A7572] transition-all md:gap-1.5 md:px-3"
        menuClassName="left-0"
      />

      <SelectMenu
        value={sort}
        options={sortOptions}
        onChange={onSortChange}
        ariaLabel={t("库存排序")}
        leadingIcon="sort"
        triggerLabel={selectedSortLabel}
        variant="compact"
        menuSize="narrow"
        className="min-w-0 shrink md:shrink-0"
        buttonClassName="flex w-auto max-w-full min-w-0 items-center justify-center gap-1 rounded-full border border-[#D8D4D1] px-2.5 py-1.5 text-xs text-[#7A7572] transition-all md:gap-1.5 md:px-3"
        menuClassName="right-0 md:left-0 md:right-auto"
      />
    </div>
  );
}

/**
 * 渲染当前 contracts 支持的真实库存浏览控件。
 * Renders the factual inventory browsing controls backed by current contracts.
 *
 * @param props - 受控搜索、品牌、品类、排序值与回调。 / Controlled search, brand, category, sorting values and callbacks.
 * @returns 只使用真实库存事实的响应式 Figma 工具栏。 / Responsive Figma toolbar backed only by real inventory facts.
 */
export function BrowseToolbar({
  query,
  brand,
  brands,
  category,
  categories,
  sort,
  onQueryChange,
  onBrandChange,
  onCategoryChange,
  onSortChange,
}: BrowseToolbarProps) {
  return (
    <form className="flex min-w-0 flex-col gap-3 md:flex-row md:items-center" role="search" onSubmit={(event) => event.preventDefault()}>
      <InventorySearchField query={query} onQueryChange={onQueryChange} />
      <InventoryFilterControls
        brand={brand}
        brands={brands}
        category={category}
        categories={categories}
        sort={sort}
        onBrandChange={onBrandChange}
        onCategoryChange={onCategoryChange}
        onSortChange={onSortChange}
      />
    </form>
  );
}

import { Icon } from "../../components/Icon.tsx";
import { SelectMenu, type SelectMenuOption } from "../../components/SelectMenu.tsx";
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
  const definitions = [
    { key: "active" as const, label: "库存", count: counts.active, icon: "box" as const },
    { key: "archive" as const, label: "已归档", count: counts.archive, icon: "archive" as const },
  ];
  if (compact) {
    return (
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto" role="tablist" aria-label="库存范围">
        {definitions.map((definition) => {
          const selected = definition.key === view;
          return (
            <button
              key={definition.key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onChange(definition.key)}
              className={`shrink-0 border-b-2 px-2.5 pb-2 pt-1 text-xs transition-colors ${
                selected
                  ? "border-[#9B7F7C] font-medium text-[#5A4C4A]"
                  : "border-transparent text-[#A8A3A0]"
              }`}
            >
              {definition.label} <span className="ml-0.5 text-[10px]">{definition.count}</span>
            </button>
          );
        })}
        <button
          type="button"
          role="tab"
          aria-selected="false"
          disabled
          title="愿望清单即将开放"
          className="shrink-0 border-b-2 border-transparent px-2.5 pb-2 pt-1 text-xs text-[#CBC6C3]"
        >
          愿望清单
        </button>
      </div>
    );
  }

  return (
    <nav className="space-y-1" aria-label="库存范围">
      {definitions.map((definition) => {
        const selected = definition.key === view;
        return (
          <button
            key={definition.key}
            type="button"
            aria-pressed={selected}
            aria-label={`${definition.label} ${definition.count}`}
            onClick={() => onChange(definition.key)}
            className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
              selected ? "bg-[#EEF1F4] font-medium text-[#5A4C4A]" : "text-[#7A7572] hover:bg-[#F8F6F4]"
            }`}
          >
            <span className="flex items-center gap-2"><Icon name={definition.icon} className="size-4" />{definition.label}</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${selected ? "bg-[#DDE4EA] text-[#4A6272]" : "bg-[#F0EDE8] text-[#A8A3A0]"}`}>
              {definition.count}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        disabled
        title="愿望清单即将开放"
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-[#CBC6C3]"
      >
        <Icon name="heart" className="size-4" />愿望清单
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
  if (view === "archive") {
    const archive = [
      { label: "已归档", count: counts.archive, icon: "archive" as const },
      { label: "已用完", count: finishedCount, icon: "opened" as const },
      { label: "已弃置", count: discardedCount, icon: "bell" as const },
    ];
    return (
      <div className="grid grid-cols-3 overflow-hidden rounded-2xl border border-[#E5D8CF] bg-white" aria-label="已归档库存摘要">
        {archive.map((entry, index) => (
          <span key={entry.label} className={`flex items-center justify-center gap-1 py-2 text-[#7A7572] ${index < archive.length - 1 ? "border-r border-[#E5D8CF]" : ""}`}>
            <Icon name={entry.icon} className="size-3.5" />
            <span className="text-[10px]">{entry.label}</span>
            <strong className="text-[10px]">{entry.count}</strong>
          </span>
        ))}
      </div>
    );
  }

  const definitions = [
    { key: "opened" as const, label: "已开封", count: counts.opened, icon: "opened" as const, color: "#9B7F7C" },
    { key: "unopened" as const, label: "未开封", count: counts.unopened, icon: "sealed" as const, color: "#7A8793" },
    { key: "attention" as const, label: "需留意", count: counts.attention, icon: "bell" as const, color: "#C07A5A" },
    { key: "all" as const, label: "总库存", count: counts.active, icon: "grid" as const, color: "#5A4C4A" },
  ];
  return (
    <div className="grid grid-cols-4 overflow-hidden rounded-2xl border border-[#E5D8CF] bg-white" aria-label="库存状态筛选">
      {definitions.map((definition, index) => {
        const selected = status === definition.key;
        return (
          <button
            key={definition.key}
            type="button"
            aria-pressed={selected}
            aria-label={`${definition.label} ${definition.count}`}
            onClick={() => onChange(definition.key)}
            className={`flex min-w-0 items-center justify-center gap-1 py-2 transition-colors ${index < definitions.length - 1 ? "border-r border-[#E5D8CF]" : ""} ${selected ? "bg-[#FAF9F8]" : "bg-white"}`}
            style={{ color: selected ? definition.color : "#A8A3A0" }}
          >
            <Icon name={definition.icon} className="size-3.5 shrink-0" />
            <span className="hidden text-[10px] min-[360px]:inline">{definition.label}</span>
            <strong className="text-[10px]">{definition.count}</strong>
          </button>
        );
      })}
    </div>
  );
}

export interface BrowseToolbarProps {
  readonly query: string;
  readonly category: string | null;
  readonly categories: readonly string[];
  readonly sort: InventorySortOption;
  readonly onQueryChange: (query: string) => void;
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
  return (
    <label
      className={`flex min-w-0 items-center gap-2 rounded-full border border-[#DDD9D6] bg-white ${
        compact ? "flex-1 px-3 py-2" : "flex-1 px-4 py-2.5 md:max-w-[380px]"
      }`}
    >
      <Icon name="search" className={`shrink-0 text-[#B0AAA7] ${compact ? "size-3.5" : "size-4"}`} />
      <span className="sr-only">搜索库存</span>
      <input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        autoComplete="off"
        placeholder={compact ? "搜索产品、品类" : "搜索产品、品类或备注"}
        className={`min-w-0 flex-1 bg-transparent font-light text-[#5A4C4A] outline-none placeholder:text-stone-400 ${
          compact ? "text-xs" : "text-sm"
        }`}
      />
    </label>
  );
}

export interface InventoryFilterControlsProps {
  readonly category: string | null;
  readonly categories: readonly string[];
  readonly sort: InventorySortOption;
  readonly onCategoryChange: (category: string | null) => void;
  readonly onSortChange: (sort: InventorySortOption) => void;
}

/**
 * 在不可用的品牌筛选旁渲染有真实数据支持的品类与排序控件。
 * Renders the factual category and sort controls beside the unavailable brand chip.
 *
 * @param props - 当前筛选、可用品类与切换回调。 / Current filters, available categories, and change callbacks.
 * @returns 可复用的 Figma 筛选胶囊行。 / The reusable Figma filter-chip row.
 */
export function InventoryFilterControls({
  category,
  categories,
  sort,
  onCategoryChange,
  onSortChange,
}: InventoryFilterControlsProps) {
  const categoryOptions: readonly SelectMenuOption<string>[] = [
    { value: "", label: "全部品类" },
    ...categories.map((choice) => ({ value: choice, label: choice })),
  ];
  const sortOptions: readonly SelectMenuOption<InventorySortOption>[] = [
    { value: "deadline-asc", label: "按临期排序", icon: "calendar" },
    { value: "name-asc", label: "按名称排序", icon: "sort" },
  ];

  return (
    <div className="flex min-w-0 items-center gap-2 pb-1 md:pb-0">
      <button
        type="button"
        aria-disabled="true"
        data-beautio-select-trigger="compact"
        title="当前数据还没有品牌字段"
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-[#D8D4D1] px-3 py-1.5 text-xs text-[#7A7572]"
      >
        <Icon name="tag" className="size-3" />品牌<Icon name="chevron-down" className="size-3" />
      </button>

      <SelectMenu
        value={category ?? ""}
        options={categoryOptions}
        onChange={(nextCategory) => onCategoryChange(nextCategory || null)}
        ariaLabel="按品类筛选"
        leadingIcon="category"
        triggerLabel="品类"
        variant="compact"
        className="shrink-0"
        buttonClassName="flex items-center gap-1.5 rounded-full border border-[#D8D4D1] px-3 py-1.5 text-xs text-[#7A7572] transition-all"
        menuClassName="left-0"
      />

      <SelectMenu
        value={sort}
        options={sortOptions}
        onChange={onSortChange}
        ariaLabel="库存排序"
        leadingIcon="sort"
        triggerLabel="排序"
        variant="compact"
        className="shrink-0"
        buttonClassName="flex items-center gap-1.5 rounded-full border border-[#D8D4D1] px-3 py-1.5 text-xs text-[#7A7572] transition-all"
        menuClassName="left-0"
      />
    </div>
  );
}

/**
 * 只渲染当前 contracts 支持的浏览控件，并让缺失能力保持无操作。
 * Renders only browse controls backed by current contracts and marks absent capabilities inert.
 *
 * @param props - 受控搜索、品类、排序值与回调。 / Controlled search, category, sorting values and callbacks.
 * @returns 不伪造品牌、录入时间或添加行为的响应式 Figma 工具栏。 / Responsive Figma toolbar without fake brand, recorded-at, or add behavior.
 */
export function BrowseToolbar({
  query,
  category,
  categories,
  sort,
  onQueryChange,
  onCategoryChange,
  onSortChange,
}: BrowseToolbarProps) {
  return (
    <form className="flex min-w-0 flex-col gap-3 md:flex-row md:items-center" role="search" onSubmit={(event) => event.preventDefault()}>
      <InventorySearchField query={query} onQueryChange={onQueryChange} />
      <InventoryFilterControls
        category={category}
        categories={categories}
        sort={sort}
        onCategoryChange={onCategoryChange}
        onSortChange={onSortChange}
      />
    </form>
  );
}

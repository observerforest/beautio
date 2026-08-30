import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type BeautioLocale = "zh-CN" | "en";

const STORAGE_KEY = "beautio_locale_v1";

const english: Readonly<Record<string, string>> = {
  "关于你，也关于时间": "About you, and about time",
  "生产数据只读观察 · 请输入本机只读密钥。生产管理密钥不会进入浏览器。":
    "Read-only production view · Enter the local read-only key. The production admin key never enters the browser.",
  "邮箱 / 手机号": "Email / phone",
  "账户登录建设中": "Account sign-in is in development",
  "本机只读密钥": "Local read-only key",
  "管理密钥": "Admin key",
  "输入本机只读密钥": "Enter the local read-only key",
  "输入当前实例的管理密钥": "Enter this instance's admin key",
  "隐藏管理密钥": "Hide admin key",
  "显示管理密钥": "Show admin key",
  "隐藏": "Hide",
  "显示": "Show",
  "忘记密钥?": "Forgot key?",
  "正在验证…": "Verifying…",
  "进入 Beautio": "Enter Beautio",
  "或": "or",
  "还没有账户？": "No account yet?",
  "立即注册": "Create account",
  "请输入管理密钥。": "Enter the admin key.",
  "我的库存": "My inventory",
  "库存概况": "Inventory overview",
  "库存": "Inventory",
  "已归档": "Archived",
  "愿望清单": "Wishlist",
  "愿望清单建设中": "Wishlist is in development",
  "库存范围": "Inventory collection",
  "已归档库存摘要": "Archived inventory summary",
  "库存状态筛选": "Inventory status filters",
  "已开封": "Opened",
  "未开封": "Unopened",
  "需留意": "Attention",
  "总库存": "Total",
  "已用完": "Finished",
  "已弃置": "Discarded",
  "设置": "Settings",
  "移动端主要页面": "Primary mobile navigation",
  "护肤知识建设中": "Skincare knowledge is in development",
  "账户信息": "Account",
  "通知设置": "Notifications",
  "数据备份": "Data backup",
  "隐私政策": "Privacy policy",
  "语言": "Language",
  "建设中": "In development",
  "退出登录": "Sign out",
  "简体中文": "Simplified Chinese",
  "English": "English",
  "返回设置": "Back to settings",
  "导出完整备份": "Export complete backup",
  "下载备份": "Download backup",
  "备份当前数据": "Back up current data",
  "正在导出…": "Exporting…",
  "从备份恢复": "Restore from backup",
  "选择备份文件": "Choose backup file",
  "选择 .beautio-backup 文件": "Choose .beautio-backup file",
  "选择之前导出的备份文件。选择文件不会立即上传或修改数据。":
    "Choose a previously exported backup. Selecting a file does not upload it or change any data.",
  "备份包含产品、库存、成分、备注与原始图片，不包含任何密钥。":
    "The backup contains products, inventory, ingredients, notes, and original images. It never contains credentials.",
  "恢复会用备份内容替换当前全部库存，操作前请核对预览。":
    "Restore replaces all current inventory with the backup. Review the preview before continuing.",
  "恢复会用备份内容替换当前全部库存，且无法撤销。操作前请核对文件。":
    "Restore replaces all current inventory and cannot be undone. Verify the file before continuing.",
  "确认恢复": "Confirm restore",
  "取消": "Cancel",
  "正在恢复…": "Restoring…",
  "产品": "products",
  "件库存": "inventory items",
  "张图片": "images",
  "当前隐私边界": "Current privacy boundary",
  "Beautio 当前是私人单用户库存工具，不提供公开账户注册。":
    "Beautio is currently a private single-user inventory tool and does not offer public account registration.",
  "库存资料、成分、备注和产品图片保存在当前 Beautio 实例的私有存储中。":
    "Inventory facts, ingredients, notes, and product images are stored in this Beautio instance's private storage.",
  "管理页面不会把管理密钥写入浏览器持久存储；锁定页面后密钥会从当前标签页内存清除。":
    "The management page does not persist the admin key in browser storage. Locking the page clears it from the current tab's memory.",
  "通过 ChatGPT、Claude 或其他外部 Agent 使用 Beautio 时，对话内容和工具返回的数据会由相应平台按其政策处理。":
    "When Beautio is used through ChatGPT, Claude, or another external agent, that platform processes the conversation and tool-returned data under its own policies.",
  "导出的备份未加密，含有私人库存与图片，应只保存在你信任的位置。":
    "Exported backups are not encrypted. They contain private inventory and images and should be kept only in locations you trust.",
  "本说明描述当前版本的实际行为；公开注册、多人数据隔离和通知功能仍在建设中。":
    "This notice describes the current version. Public registration, multi-user data isolation, and notifications are still in development.",
  "搜索库存": "Search inventory",
  "可搜产品、品牌、成分、备注等": "Search products, brands, ingredients, notes, and more",
  "搜索产品、别名、品牌、品类或备注": "Search products, aliases, brands, categories, or notes",
  "搜索产品、品牌": "Search products or brands",
  "全部品牌": "All brands",
  "品牌": "Brand",
  "全部品类": "All categories",
  "品类": "Category",
  "按临期排序": "Expiring soon",
  "按最近添加": "Recently added",
  "排序": "Sort",
  "按品牌筛选": "Filter by brand",
  "按品类筛选": "Filter by category",
  "库存排序": "Inventory sort",
  "清除筛选": "Clear filters",
  "刷新": "Refresh",
  "添加产品建设中": "Add product is in development",
  "添加产品": "Add product",
  "图片读取失败": "Image unavailable",
  "暂无图片": "No image",
  "正在读取图片": "Loading image",
  "正在读取完整原图": "Loading original image",
  "完整原图读取失败": "Original image unavailable",
  "暂无管理原图": "No managed original image",
  "关闭库存详情": "Close inventory details",
  "查看完整原图": "View original image",
  "查看详情": "View details",
  "关闭完整原图": "Close original image",
  "完整原图": "Original image",
  "显示未经卡片裁边的完整原图；可使用浏览器缩放查看细节。":
    "Shows the uncropped original image. Use browser zoom to inspect details.",
  "未记录产品名称": "Unnamed product",
  "品牌未记录": "Brand not recorded",
  "品类未记录": "Category not recorded",
  "规格未记录": "Size not recorded",
  "生产实时数据 · 当前为本地只读观察模式。":
    "Live production data · Local read-only observation mode.",
  "这条库存没有关联 Product": "This inventory item has no linked Product",
  "已结束库存不能修改生命周期事实":
    "Finished or discarded inventory cannot change lifecycle facts",
  "编辑产品资料": "Edit product details",
  "编辑这瓶": "Edit this bottle",
  "产品成分与共享备注属于同款 Product；自定义备注只属于当前瓶。期限和可用状态由服务端计算。":
    "Ingredients and shared notes belong to the Product; custom notes belong only to this bottle. Dates and usability are calculated by the server.",
  "产品资料": "Product details",
  "共享 · 影响全部瓶": "Shared · affects every bottle",
  "产品名称": "Product name",
  "产品别名": "Product alias",
  "规格": "Size",
  "成分表": "Ingredients",
  "共享备注": "Shared notes",
  "成分表原文": "Ingredient list",
  "这一瓶": "This bottle",
  "仅当前瓶": "This bottle only",
  "生命周期": "Lifecycle",
  "开封日期": "Opened on",
  "包装过期日": "Package expiry",
  "自定义备注（仅这瓶）": "Custom notes (this bottle only)",
  "编辑自定义备注": "Edit custom notes",
  "未记录": "Not recorded",
  "未填写": "Not provided",
  "只读": "Read only",
  "服务端派生结果": "Server-derived results",
  "截至": "As of",
  "PAO 截止日": "PAO deadline",
  "最终可用至": "Usable until",
  "可用状态": "Usability",
  "系统警告": "System warnings",
  "当前没有警告": "No current warnings",
  "可用": "Usable",
  "已过可用期": "Past usable date",
  "暂时未知": "Unknown for now",
  "期限未知": "Date unknown",
  "可用期未知": "Usable date unknown",
  "在所选日期已经超过可用期限": "Already past the usable date on the selected date",
  "没有 PAO（月数）记录，无法计算开封后期限":
    "PAO months are not recorded, so the after-opening deadline cannot be calculated",
  "精确": "Exact",
  "估算": "Estimated",
  "单瓶备注": "Bottle notes",
  "编辑产品": "Edit product",
  "编辑单瓶": "Edit bottle",
  "编辑备注": "Edit notes",
  "关闭": "Close",
  "关闭设置": "Close settings",
  "备份已恢复，但库存页面刷新失败，请手动刷新页面。":
    "The backup was restored, but the inventory view could not refresh. Refresh the page manually.",
  "保存": "Save",
  "保存中…": "Saving…",
  "未知": "Unknown",
  "备份导出失败。": "Backup export failed.",
  "备份文件无法读取。": "The backup file could not be read.",
  "备份文件为空。": "The backup file is empty.",
  "备份文件超过 280 MiB 上限。":
    "The backup file exceeds the 280 MiB limit.",
  "备份恢复失败。": "Backup restore failed.",
  "正在实时查看生产数据 · 本地只读，不会修改生产库存":
    "Viewing live production data · Local read-only mode cannot modify production inventory",
  "暂时没有结果": "No results",
  "当前没有库存。": "There is no inventory yet.",
  "还没有库存记录。": "There are no inventory records yet.",
  "还没有已归档的库存。": "There is no archived inventory yet.",
  "没有找到匹配的库存。": "No matching inventory was found.",
  "没有符合当前筛选条件的库存。": "No inventory matches the current filters.",
  "完整备份已导出。": "Complete backup exported.",
  "备份文件不是有效的 Beautio 备份。": "This file is not a valid Beautio backup.",
  "备份文件版本或内容无法识别。": "The backup version or contents are not recognized.",
  "备份图片超过 200 MiB 总上限。": "Backup images exceed the 200 MiB total limit.",
  "关闭提示": "Dismiss notice",
  "请选择": "Select",
  "保存前不会上传图片或修改数据库。": "No image is uploaded and no database change is made before saving.",
  "产品名称不能为空。": "Product name is required.",
  "正在上传新图片…": "Uploading the new image…",
  "正在保存产品资料…": "Saving product details…",
  "产品资料已保存，正在重新读取真实库存…": "Product details saved. Refreshing the server inventory…",
  "产品资料已保存。共享该 Product 的库存已重新读取。": "Product details saved. Inventory sharing this Product has been refreshed.",
  "保存请求已经完成，但重新读取失败。请先重试读取确认结果，不要重复保存。": "The save completed, but refresh failed. Retry the refresh to confirm the result; do not save again.",
  "等待重新读取确认。": "Waiting for refresh confirmation.",
  "管理密钥无效或已撤销，请重新输入。此次修改没有保存。": "The admin key is invalid or revoked. Enter it again. This change was not saved.",
  "保存失败，页面中的输入仍保留。": "Save failed. Your inputs remain on this page.",
  "若图片已上传但尚未关联，服务器会按临时资产规则清理。": "If the image was uploaded but not linked, the server will clean it up as a temporary asset.",
  "保存后将清空管理图片": "The managed image will be cleared when saved",
  "新图片": "New image",
  "预览": "preview",
  "当前管理图片": "current managed image",
  "正在读取当前图片": "Loading current image",
  "当前图片读取失败": "Current image unavailable",
  "暂无管理图片": "No managed image",
  "旧图片引用不自动加载": "Legacy image references are not loaded automatically",
  "修改将同步影响该产品的所有库存瓶": "Changes affect every inventory bottle for this Product",
  "保存产品资料": "Save product details",
  "更换图片": "Replace image",
  "选择后只在点击保存时上传 JPEG、PNG 或静态 WebP。": "The selected JPEG, PNG, or static WebP is uploaded only when you save.",
  "清空当前管理图片": "Clear current managed image",
  "必填；不会自动按名称查重或合并。": "Required; names are not automatically deduplicated or merged.",
  "无法确认时留空。": "Leave blank when unknown.",
  "保留包装文字与内部换行。": "Preserve package wording and line breaks.",
  "同一 Product 的所有库存都会看到。": "Visible to all inventory for this Product.",
  "派生字段不会随表单提交。": "Derived fields are not submitted with the form.",
  "请选择日期准确性": "Select date accuracy",
  "准确日期": "Exact date",
  "估算日期": "Estimated date",
  "保留历史记录的未知准确性": "Preserve legacy unknown accuracy",
  "已开封库存必须填写开封日期。": "Opened inventory requires an opening date.",
  "请选择准确日期或估算日期。": "Select exact or estimated date accuracy.",
  "PAO 必须是 1–120 的整数，或留空。": "PAO must be an integer from 1 to 120, or blank.",
  "正在保存单瓶事实并重新计算…": "Saving bottle facts and recalculating…",
  "单瓶事实已保存，正在重新读取服务端结果…": "Bottle facts saved. Refreshing server results…",
  "单瓶事实已保存；PAO 截止日、最终可用日和状态已重新读取。": "Bottle facts saved. The PAO deadline, final usable date, and status were refreshed.",
  "仅对当前这一瓶生效，不影响其他瓶或产品资料": "Applies only to this bottle; other bottles and Product details are unchanged",
  "保存这瓶": "Save bottle",
  "开封日期准确性": "Opening-date accuracy",
  "已开封时必填；未开封时会清空。": "Required when opened; cleared when unopened.",
  "估算必须明确标记。": "Estimated dates must be marked explicitly.",
  "没有记录时留空。": "Leave blank when not recorded.",
  "PAO（月）": "PAO (months)",
  "整数 1–120；没有记录时留空。": "Integer from 1 to 120; leave blank when not recorded.",
  "当前只读派生值": "Current read-only derived values",
  "保存只会更新当前瓶的自定义备注。": "Saving updates only this bottle's custom notes.",
  "正在保存当前瓶的自定义备注…": "Saving this bottle's custom notes…",
  "备注已保存，正在重新读取真实库存…": "Notes saved. Refreshing the server inventory…",
  "当前瓶的自定义备注已保存；其他库存事实已重新读取。": "This bottle's custom notes were saved; other inventory facts were refreshed.",
  "保存备注": "Save notes",
  "自定义备注": "Custom notes",
  "留空并保存会清空当前瓶的备注。": "Save a blank value to clear this bottle's notes.",
  "选择编辑入口后才会产生可保存的修改。": "Choose an edit action before making saveable changes.",
  "这条库存已被新读取结果更新。为避免旧草稿覆盖新事实，编辑器已关闭，请重新打开。": "This inventory item changed after a refresh. The editor was closed to prevent an old draft from overwriting new facts; open it again.",
  "管理页已锁定，密钥已从当前标签页内存清除。": "The management page is locked and the key was cleared from this tab's memory.",
  "库存重新读取失败：": "Inventory refresh failed: ",
  "再试一次": "Try again",
  "已取消产品编辑，没有保存任何修改。": "Product editing canceled. No changes were saved.",
  "已取消单瓶编辑，没有保存任何修改。": "Bottle editing canceled. No changes were saved.",
  "已取消自定义备注编辑，没有保存任何修改。": "Custom-note editing canceled. No changes were saved.",
  "正在验证密钥并读取库存…": "Verifying the key and loading inventory…",
  "管理密钥无效或已撤销，请重新输入。库存没有被读取。": "The admin key is invalid or revoked. Enter it again. Inventory was not loaded.",
  "管理密钥无效或已撤销，请重新输入。当前页面数据已清除。": "The admin key is invalid or revoked. Enter it again. Data on this page was cleared.",
  "页面离开后管理密钥已从内存清除，请重新输入。": "The admin key was cleared from memory after leaving the page. Enter it again.",
  "无法连接 Beautio 服务，请确认本地服务正在运行。": "Cannot connect to the Beautio service. Confirm that the local service is running.",
  "发生了未知错误，请稍后再试。": "An unknown error occurred. Try again later.",
  "无法连接 Beautio 服务，请确认服务正在运行。": "Cannot connect to the Beautio service. Confirm that the service is running.",
  "管理密钥无效或已撤销，请重新输入。私有图片没有继续加载。": "The admin key is invalid or revoked. Enter it again. Private images stopped loading.",
  "Beautio 服务返回错误响应。": "The Beautio service returned an error response.",
  "服务器返回了无法识别的响应。": "The server returned an unrecognized response.",
};

export interface I18nValue {
  readonly locale: BeautioLocale;
  readonly setLocale: (locale: BeautioLocale) => void;
  readonly t: (source: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

/**
 * Provides the persisted interface language without translating user data.
 *
 * @param props - React children rendered under the language context.
 * @returns The provider wrapping the supplied application tree.
 */
export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const [locale, setLocale] = useState<BeautioLocale>(readInitialLocale);
  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // A blocked preference store does not prevent the in-memory switch.
    }
  }, [locale]);
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (source) => (locale === "en" ? (english[source] ?? source) : source),
    }),
    [locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Reads the current Beautio interface language and translation function.
 *
 * @returns The nearest required language context.
 */
export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return value;
}

function readInitialLocale(): BeautioLocale {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "zh-CN";
  } catch {
    return "zh-CN";
  }
}

/**
 * 选择 inventory 页面允许展示的 Product 图片来源。
 * Selects the Product image source that the inventory interface may render.
 */
import type { InventoryListItemOutput } from "@beautio/contracts";

export type ProductImageChoice =
  | { readonly kind: "managed"; readonly imageAssetId: string }
  | { readonly kind: "legacy"; readonly imageRef: string }
  | { readonly kind: "none" };

/**
 * 选择浏览器获准渲染的唯一 Product 图片来源。
 * Selects the one product image source the browser is allowed to render.
 *
 * @param item - Product 可能包含受管图片和旧版图片事实的库存记录。 / Inventory item whose Product may contain managed and legacy image facts.
 * @returns 优先返回受管 ImageAsset，否则返回未经改写的旧版引用；两者都没有时返回 none。 / Managed ImageAsset first, otherwise the unchanged legacy reference, otherwise none.
 */
export function productImageChoice(
  item: InventoryListItemOutput,
): ProductImageChoice {
  const imageAssetId = managedImageAssetId(item);
  if (imageAssetId !== null) {
    return { kind: "managed", imageAssetId };
  }
  const imageRef = item.product?.image_ref ?? null;
  return imageRef === null
    ? { kind: "none" }
    : { kind: "legacy", imageRef };
}

/**
 * 读取服务端管理的 Product 图片标识，不解释其内部格式。
 * Reads the server-managed product image identifier without interpreting its format.
 *
 * @param item - Product 可能带有受管图片的库存记录。 / Inventory item whose Product may have a managed image.
 * @returns 不透明的 ImageAsset 标识；没有受管图片时返回 null。 / The opaque ImageAsset identifier, or null when no managed image exists.
 */
export function managedImageAssetId(
  item: InventoryListItemOutput,
): string | null {
  return item.product?.image_asset_id ?? null;
}

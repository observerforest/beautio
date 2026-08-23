export interface LogoProps {
  readonly className?: string;
  readonly decorative?: boolean;
}

/**
 * 渲染公共品牌资源中已确认的 Beautio 横向组合标志。
 * Renders the approved horizontal Beautio lockup from the public brand bundle.
 *
 * @param props - 可选尺寸类，以及是否隐藏辅助文本。 / Optional sizing classes and whether assistive text is suppressed.
 * @returns 登录页与库存外壳共用的品牌图片。 / The shared brand image used by login and inventory shells.
 */
export function Logo({ className = "h-8 w-auto", decorative = false }: LogoProps) {
  return (
    <img
      src="/brand/beautio-lockup-horizontal.png"
      alt={decorative ? "" : "Beautio — Beauty in Flow"}
      aria-hidden={decorative || undefined}
      className={className}
    />
  );
}

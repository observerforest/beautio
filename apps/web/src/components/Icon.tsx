import type { SVGProps } from "react";

export type IconName =
  | "archive"
  | "bell"
  | "box"
  | "calendar"
  | "camera"
  | "category"
  | "chevron-down"
  | "chevron-right"
  | "chevron-up"
  | "gear"
  | "grid"
  | "heart"
  | "info"
  | "inventory"
  | "opened"
  | "plus"
  | "search"
  | "sealed"
  | "sort"
  | "tag"
  | "tree"
  | "x";

export interface IconProps extends SVGProps<SVGSVGElement> {
  readonly name: IconName;
}

/**
 * 渲染已确认 Figma Make 源码中携带的精确图标路径。
 * Renders an exact icon path carried by the approved Figma Make source.
 *
 * @param props - 图标名称与标准 SVG 展示属性。 / Icon name plus standard SVG presentation attributes.
 * @returns 继承周围文字颜色的装饰性 SVG。 / A decorative SVG that inherits the surrounding text color.
 */
export function Icon({ name, className = "size-4", ...props }: IconProps) {
  const common = {
    className,
    fill: "none",
    stroke: "currentColor",
    viewBox: "0 0 24 24",
    "aria-hidden": true,
    ...props,
  } as const;

  switch (name) {
    case "search":
      return <svg {...common} strokeWidth="1.8"><circle cx="11" cy="11" r="7.5" /><path d="m20.5 20.5-4.5-4.5" strokeLinecap="round" /></svg>;
    case "chevron-down":
      return <svg {...common} strokeWidth="2.2"><path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "chevron-up":
      return <svg {...common} strokeWidth="2.2"><path d="m18 15-6-6-6 6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "chevron-right":
      return <svg {...common} strokeWidth="1.8"><path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "tag":
      return <svg {...common} strokeWidth="1.8"><path d="m20.59 13.41-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" /><circle cx="7" cy="7" r="1.5" fill="currentColor" /></svg>;
    case "category":
      return <svg {...common} strokeWidth="1.8"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>;
    case "sort":
      return <svg {...common} strokeWidth="2"><path d="M7 16V4m0 0L3 8m4-4 4 4m6 0v12m0 0 4-4m-4 4-4-4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "calendar":
      return <svg {...common} strokeWidth="1.5"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" strokeLinecap="round" /></svg>;
    case "opened":
      return <svg {...common} strokeWidth="1.5"><rect x="8" y="11" width="8" height="11" rx="2" /><path d="M10.5 11V9M13.5 11V9M10.5 9h3M17 6h2.5M16 4.5 19 6" strokeLinecap="round" /></svg>;
    case "sealed":
      return <svg {...common} strokeWidth="1.5"><rect x="8" y="11" width="8" height="11" rx="2" /><path d="M10.5 11V9M13.5 11V9" strokeLinecap="round" /><rect x="9" y="5" width="6" height="4" rx="1.5" /></svg>;
    case "bell":
      return <svg {...common} strokeWidth="1.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" /></svg>;
    case "grid":
      return <svg {...common} strokeWidth="1.6"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>;
    case "inventory":
      return <svg {...common} strokeWidth="1.5"><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M12 12v4M10 14h4" strokeLinecap="round" /></svg>;
    case "tree":
      return <svg {...common} strokeWidth="1.5"><path d="M12 21v-6M9 21h6" strokeLinecap="round" /><path d="M12 15c-4 0-7-2.5-7-6a7 7 0 0 1 14 0c0 3.5-3 6-7 6Z" strokeLinejoin="round" /></svg>;
    case "gear":
      return <svg {...common} strokeWidth="1.5"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.18V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 7.1 19.73l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3.09 14H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.27 7.1l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 2.9 1.18l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.91 10H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15Z" /></svg>;
    case "box":
      return <svg {...common} strokeWidth="1.7"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.27 6.96 8.73 5.05 8.73-5.05M12 22.08V12" strokeLinecap="round" /></svg>;
    case "archive":
      return <svg {...common} strokeWidth="1.7"><path d="M21 8v13H3V8M1 3h22v5H1Z" /><path d="M10 12h4" strokeLinecap="round" /></svg>;
    case "heart":
      return <svg {...common} strokeWidth="1.7"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78Z" /></svg>;
    case "plus":
      return <svg {...common} strokeWidth="2"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>;
    case "x":
      return <svg {...common} strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" /></svg>;
    case "camera":
      return <svg {...common} strokeWidth="1.6"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z" /><circle cx="12" cy="13" r="4" /></svg>;
    case "info":
      return <svg {...common} strokeWidth="1.8"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" strokeLinecap="round" /></svg>;
  }
}

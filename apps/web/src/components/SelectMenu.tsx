import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { Icon, type IconName } from "./Icon.tsx";

export interface SelectMenuOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly icon?: IconName;
}

export interface SelectMenuProps<Value extends string> {
  readonly value: Value;
  readonly options: readonly SelectMenuOption<Value>[];
  readonly onChange: (value: Value) => void;
  readonly ariaLabel: string;
  readonly leadingIcon?: IconName;
  readonly triggerLabel?: string;
  readonly variant?: "compact" | "field";
  readonly disabled?: boolean;
  readonly className?: string;
  readonly buttonClassName?: string;
  readonly menuClassName?: string;
  readonly triggerRef?: Ref<HTMLButtonElement>;
}

/**
 * 渲染符合 Beautio Figma 视觉、不会调用系统原生弹层的受控选择菜单。
 * Renders a controlled Beautio Figma select menu without invoking the native system popup.
 *
 * @param props - 当前值、选项、视觉变体、可访问名称和变更回调。 / Current value, options, visual variants, accessible name, and change callback.
 * @returns 支持指针、方向键、Home、End、Enter、Space 与 Escape 的组合框。 / A combobox supporting pointer, arrow, Home, End, Enter, Space, and Escape input.
 */
export function SelectMenu<Value extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  leadingIcon,
  triggerLabel,
  variant = "field",
  disabled = false,
  className = "",
  buttonClassName = "",
  menuClassName = "",
  triggerRef,
}: SelectMenuProps<Value>) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selectedOption = options[selectedIndex];

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const assignTriggerRef = (node: HTMLButtonElement | null): void => {
    internalTriggerRef.current = node;
    if (typeof triggerRef === "function") triggerRef(node);
    else if (triggerRef !== undefined && triggerRef !== null) triggerRef.current = node;
  };

  const showMenu = (index = selectedIndex): void => {
    setActiveIndex(index);
    setOpen(true);
  };

  const choose = (option: SelectMenuOption<Value>): void => {
    onChange(option.value);
    setOpen(false);
    internalTriggerRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (options.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (!open) {
        showMenu(selectedIndex);
        return;
      }
      setActiveIndex((current) => (current + direction + options.length) % options.length);
      return;
    }
    if (open && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (open && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const option = options[activeIndex];
      if (option !== undefined) choose(option);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "Tab") setOpen(false);
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={assignTriggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${listboxId}-${activeIndex}` : undefined}
        disabled={disabled}
        data-beautio-select-trigger={variant}
        onClick={() => (open ? setOpen(false) : showMenu())}
        onKeyDown={handleKeyDown}
        className={buttonClassName}
      >
        {leadingIcon === undefined ? null : <Icon name={leadingIcon} className="size-3 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{triggerLabel ?? selectedOption?.label ?? "请选择"}</span>
        <Icon name={open ? "chevron-up" : "chevron-down"} className="size-3 shrink-0" />
      </button>

      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          data-beautio-select-menu={variant}
          className={`absolute top-full z-50 mt-2 min-w-full overflow-hidden rounded-2xl bg-white py-0 shadow-[0_8px_32px_rgba(90,76,74,0.14)] ${menuClassName}`}
        >
          {options.map((option, index) => (
            <div key={option.value}>
              <button
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                id={`${listboxId}-${index}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                data-beautio-select-option
                onPointerEnter={() => setActiveIndex(index)}
                onClick={() => choose(option)}
                className={`flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm transition-colors ${
                  index === activeIndex
                    ? "bg-[#FBF6F5] text-[#9B7F7C]"
                    : "bg-white text-[#5A4C4A] hover:bg-stone-50"
                }`}
              >
                {option.icon === undefined ? null : <Icon name={option.icon} className="size-4 shrink-0" />}
                <span className="whitespace-nowrap">{option.label}</span>
              </button>
              {index === options.length - 1 ? null : <div role="separator" className="mx-4 h-px bg-[#F2EFED]" />}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

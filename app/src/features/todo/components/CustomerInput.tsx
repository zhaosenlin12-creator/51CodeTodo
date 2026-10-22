import { useEffect, useId, useRef, useState } from "react";
import { todoTexts } from "../todoTexts";

interface CustomerInputProps {
  value: string;
  suggestions: string[];
  error: boolean;
  onChange(value: string): void;
  placeholder?: string;
  ariaLabel?: string;
}

/** 普通输入不弹菜单；箭头主动展开。菜单与输入框共同管理焦点和关闭行为。 */
export default function CustomerInput({ value, suggestions, error, onChange, placeholder = todoTexts.customerPlaceholder, ariaLabel = todoTexts.customerLabel }: CustomerInputProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const options = [...new Set(suggestions)].filter(name => name.toLocaleLowerCase().includes(value.trim().toLocaleLowerCase()));
  const active = activeIndex >= 0 && activeIndex < options.length ? activeIndex : -1;

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (open && active >= 0) root.current?.querySelector(`[data-option-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  return <div className="todo-dialog-field todo-customer-field" ref={root}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.preventDefault(); event.stopPropagation(); setOpen(false);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); setOpen(true);
        setActiveIndex(event.key === "ArrowDown" ? Math.min(active + 1, options.length - 1) : Math.max(active - 1, 0));
      } else if (event.key === "Enter" && open && active >= 0) {
        event.preventDefault(); event.stopPropagation(); onChange(options[active]); setOpen(false);
      }
    }}>
    <input ref={input} className={`dialog-input todo-dialog-input todo-customer-input${error ? " error" : ""}`}
      placeholder={placeholder} aria-label={ariaLabel} aria-required="true" aria-invalid={error}
      role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
      autoComplete="off" value={value} onChange={(event) => { onChange(event.target.value); setActiveIndex(-1); }} />
    {options.length > 0 && (
      <button type="button" className={`todo-customer-toggle${open ? " open" : ""}`}
        aria-label={open ? "收起下拉列表" : "展开下拉列表"} aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => { setOpen(!open); setActiveIndex(-1); input.current?.focus(); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </button>
    )}
    {open && options.length > 0 && <div id={listId} role="listbox" aria-label="常用名称" className="todo-customer-menu">
      {options.map((name, index) => <button key={name} id={`${listId}-${index}`} data-option-index={index}
        type="button" role="option" aria-selected={index === active} tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => { onChange(name); setOpen(false); input.current?.focus(); }}>{name}</button>)}
    </div>}
  </div>;
}

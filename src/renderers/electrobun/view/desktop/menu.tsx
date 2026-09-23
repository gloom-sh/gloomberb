/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HostMenuItem, HostMenuProps } from "../../../../ui/host";
import { CheckboxBox } from "./controls";

const MENU_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "j", "k"]);

function Check() {
  return (
    <svg viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2.2 5.3l1.9 1.9 3.8-4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function selectable(item: HostMenuItem): boolean {
  return item.kind !== "divider" && item.kind !== "heading" && !item.disabled;
}

/** Desktop Menu: the one list every popover menu in the app renders. */
export function WebMenu({ items, onSelect, selection = "none", title, label, onClose, highlightedId, onHighlight }: HostMenuProps) {
  const enabled = useMemo(() => items.filter(selectable), [items]);
  const controlled = highlightedId !== undefined;
  const [ownHighlighted, setOwnHighlighted] = useState<string | null>(
    () => items.find((item) => item.selected && selectable(item))?.id ?? enabled[0]?.id ?? null,
  );
  const highlighted = controlled ? highlightedId : ownHighlighted;
  const setHighlighted = useCallback((id: string | null) => {
    if (controlled) {
      if (id) onHighlight?.(id);
    } else {
      setOwnHighlighted(id);
    }
  }, [controlled, onHighlight]);
  const listRef = useRef<HTMLDivElement | null>(null);

  const choose = useCallback((id: string) => {
    onSelect(id);
  }, [onSelect]);

  // The popover takes focus when it opens, so its keys arrive at the document.
  // Stop them there or the pane behind the menu moves its cursor too.
  useEffect(() => {
    if (controlled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!MENU_KEYS.has(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const index = enabled.findIndex((item) => item.id === highlighted);
      if (event.key === "ArrowDown" || event.key === "j") setHighlighted(enabled[Math.min(enabled.length - 1, index + 1)]?.id ?? null);
      else if (event.key === "ArrowUp" || event.key === "k") setHighlighted(enabled[Math.max(0, index - 1)]?.id ?? null);
      else if (event.key === "Home") setHighlighted(enabled[0]?.id ?? null);
      else if (event.key === "End") setHighlighted(enabled[enabled.length - 1]?.id ?? null);
      else if (highlighted) choose(highlighted);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [choose, controlled, enabled, highlighted, setHighlighted]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-highlighted=true]")?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  return (
    <div
      ref={listRef}
      className="gloom-menu"
      role={selection === "none" ? "menu" : "listbox"}
      aria-label={label ?? title}
      aria-multiselectable={selection === "multi" || undefined}
      data-gloom-role="menu"
      onKeyDown={(event) => { if (event.key === "Escape") onClose?.(); }}
    >
      {title ? <div className="gloom-menu-title">{title}</div> : null}
      {items.map((item) => {
        if (item.kind === "divider") return <div key={item.id} className="gloom-menu-divider" role="separator" />;
        if (item.kind === "heading") return <div key={item.id} className="gloom-menu-title">{item.label}</div>;
        const role = selection === "none" ? "menuitem" : "option";
        return (
          <div
            key={item.id}
            role={role}
            aria-selected={selection === "none" ? undefined : selection === "multi" ? !!item.checked : !!item.selected}
            aria-disabled={item.disabled || undefined}
            className="gloom-menu-item"
            data-gloom-interactive={item.disabled ? undefined : "true"}
            data-highlighted={item.id === highlighted ? "true" : undefined}
            data-selected={item.selected ? "true" : undefined}
            onMouseEnter={() => { if (!item.disabled) setHighlighted(item.id); }}
            onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
            onClick={(event) => {
              event.stopPropagation();
              if (!item.disabled) choose(item.id);
            }}
          >
            {selection === "multi" && (
              <CheckboxBox checked={!!item.checked} />
            )}
            <span className="gloom-menu-label">
              <span className="gloom-menu-text">{item.label}</span>
              {item.description ? <span className="gloom-menu-description">{item.description}</span> : null}
            </span>
            {item.hint ? <span className="gloom-menu-hint">{item.hint}</span> : null}
            {selection === "single" && item.selected ? <span className="gloom-menu-check"><Check /></span> : null}
          </div>
        );
      })}
    </div>
  );
}

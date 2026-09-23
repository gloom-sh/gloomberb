/** @jsxImportSource react */
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { HostQueryBarItem, HostQueryBarProps } from "../../../../ui/host";
import { WebPopover } from "./popover";
import { WebMenu } from "./menu";
import { useHorizontalOverflow } from "../host/overflow-fade";
import { StackHeaderContext } from "./stack-header";
import { CheckboxBox } from "./controls";
import { WebIcon } from "./icons";

function Chevron() {
  return <span className="gloom-qb-chevron"><WebIcon name="chevron-down" size={9} /></span>;
}

function Cross() {
  return <WebIcon name="close" size={10} />;
}

function SearchIcon() {
  return <span className="gloom-qb-search-icon"><WebIcon name="search" size={11} /></span>;
}

function QueryMenu({ item, onClose }: { item: HostQueryBarItem; onClose: () => void }) {
  return (
    <WebMenu
      label={item.label}
      selection={item.kind === "multi" ? "multi" : "single"}
      items={item.options.map((option) => ({
        id: option.value,
        label: option.label,
        description: option.description,
        disabled: option.disabled,
        selected: item.kind === "select" ? option.selected : undefined,
        checked: item.kind === "multi" ? option.selected : undefined,
      }))}
      onSelect={(value) => {
        item.onSelect(value);
        if (item.kind === "select") onClose();
      }}
      onClose={onClose}
    />
  );
}

function TextField({ item }: { item: HostQueryBarItem }) {
  return (
    <div
      className="gloom-qb-search gloom-qb-textfield"
      data-active={item.active ? "true" : undefined}
      data-narrowing={item.narrowing ? "true" : undefined}
      style={item.width ? { width: `calc(${item.width} * var(--cell-w))` } : undefined}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (!item.active) item.onActivate?.();
      }}
    >
      <span className="gloom-qb-label">{item.label}</span>
      <div className="gloom-qb-search-input">{item.node}</div>
      {item.narrowing ? (
        <span
          className="gloom-qb-reset"
          role="button"
          aria-label={`Clear ${item.label}`}
          onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => { event.stopPropagation(); item.onReset(); }}
        >
          <Cross />
        </span>
      ) : null}
    </div>
  );
}

function FilterChip({ item, open, onOpenChange }: { item: HostQueryBarItem; open: boolean; onOpenChange: (open: boolean) => void }) {
  if (item.kind === "text") return <TextField item={item} />;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // A shortcut can open a filter that is scrolled out of a narrow bar.
  useEffect(() => {
    if (open) triggerRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [open]);
  if (item.kind === "select" && item.inline) {
    return (
      <div className="gloom-qb-inline" data-item-id={item.id} data-narrowing={item.narrowing ? "true" : undefined}>
        <span className="gloom-qb-label">{item.label}</span>
        <div className="gloom-qb-view gloom-qb-segments" role="radiogroup" aria-label={item.label}>
          {item.options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={option.selected}
              disabled={option.disabled}
              title={option.hint ? `${option.label} (${option.hint})` : undefined}
              data-active={option.selected ? "true" : undefined}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => item.onSelect(option.value)}
            >
              <span className="gloom-qb-text">{option.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (item.kind === "toggle") {
    return (
      <button
        type="button"
        className="gloom-qb-chip"
        data-kind="toggle"
        data-narrowing={item.checked ? "true" : undefined}
        aria-pressed={item.checked}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={item.onToggle}
      >
        <CheckboxBox checked={!!item.checked} />
        <span className="gloom-qb-value">{item.label}</span>
      </button>
    );
  }

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className="gloom-qb-chip"
      data-kind={item.kind}
      data-narrowing={item.narrowing ? "true" : undefined}
      data-open={open ? "true" : undefined}
      aria-haspopup="listbox"
      aria-expanded={open}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => onOpenChange(!open)}
    >
      <span className="gloom-qb-label">{item.label}</span>
      <span className="gloom-qb-value">{item.valueLabel}</span>
      {item.narrowing ? (
        <span
          className="gloom-qb-reset"
          role="button"
          aria-label={`Reset ${item.label}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenChange(false);
            item.onReset();
          }}
        >
          <Cross />
        </span>
      ) : <Chevron />}
    </button>
  );

  return (
    <WebPopover open={open} onOpenChange={onOpenChange} trigger={trigger} minWidth={170} label={item.label} density="menu">
      <QueryMenu item={item} onClose={() => onOpenChange(false)} />
    </WebPopover>
  );
}

export function WebQueryBar({ search, items, view, onClearAll, meta, openRequest }: HostQueryBarProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // At the top of an open stack detail, take its Back and title as leading
  // segments so the detail shows one toolbar, not two.
  const stack = useContext(StackHeaderContext);
  const [stackAttached, setStackAttached] = useState(false);
  useLayoutEffect(() => {
    const bar = rootRef.current;
    const container = stack?.containerRef.current;
    if (!stack || !bar || !container || !container.contains(bar)) return;
    if (Math.abs(bar.getBoundingClientRect().top - container.getBoundingClientRect().top) > 1.5) return;
    const release = stack.attach();
    setStackAttached(true);
    return () => {
      release();
      setStackAttached(false);
    };
  }, [stack]);
  const overflow = useHorizontalOverflow(scrollRef, [items.length, !!search, !!view, !!onClearAll, meta]);
  const searchRef = useRef<HTMLDivElement | null>(null);
  // When an inline choice or the view changes (a shortcut, the next expiry),
  // bring the new selection into a scrolled bar. Not on mount: a view at the
  // right edge must not scroll the search away when the pane opens.
  const selectionKey = [
    ...items.filter((item) => item.inline).map((item) => `${item.id}=${item.options.find((option) => option.selected)?.value ?? ""}`),
    `view=${view?.value ?? ""}`,
  ].join("|");
  const previousSelectionKey = useRef(selectionKey);
  useEffect(() => {
    const previous = previousSelectionKey.current;
    previousSelectionKey.current = selectionKey;
    if (previous === selectionKey) return;
    const before = new Map(previous.split("|").map((entry) => entry.split("=") as [string, string]));
    const bar = scrollRef.current;
    if (!bar) return;
    for (const entry of selectionKey.split("|")) {
      const [id, value] = entry.split("=") as [string, string];
      if (before.get(id) === value) continue;
      const group = id === "view"
        ? bar.querySelector(":scope > .gloom-qb-view")
        : bar.querySelector(`[data-item-id="${CSS.escape(id)}"]`);
      group?.querySelector<HTMLElement>("button[data-active=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [selectionKey]);
  useEffect(() => {
    if (search?.active) searchRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [search?.active]);

  useEffect(() => {
    if (openRequest) setOpenId(openRequest.id);
  }, [openRequest?.id, openRequest?.token]);

  const setOpen = useCallback((id: string, open: boolean) => {
    setOpenId((current) => open ? id : current === id ? null : current);
  }, []);

  let searchNode: ReactNode = null;
  if (search) {
    searchNode = (
      <div
        ref={searchRef}
        className="gloom-qb-search"
        data-active={search.active ? "true" : undefined}
        onMouseDown={(event) => {
          event.stopPropagation();
          if (!search.active) search.onActivate();
        }}
      >
        <SearchIcon />
        <div className="gloom-qb-search-input">{search.node}</div>
        {search.filled ? (
          <span
            className="gloom-qb-reset"
            role="button"
            aria-label="Clear search"
            onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
            onClick={(event) => { event.stopPropagation(); search.onClear(); }}
          >
            <Cross />
          </span>
        ) : !search.active ? <span className="gloom-qb-kbd">/</span> : null}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="gloom-qb" data-gloom-role="query-bar" data-gloom-top-surface="">
      <div ref={scrollRef} className="gloom-qb-scroll" style={overflow.maskStyle} onWheel={overflow.onWheel}>
      {stack && stackAttached && (
        <>
          <button
            type="button"
            className="gloom-stack-back"
            onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
            onClick={(event) => { event.stopPropagation(); stack.onBack(); }}
          >
            <WebIcon name="back" size={11} />
            <span className="gloom-qb-text">{stack.backLabel}</span>
          </button>
          {stack.title ? <span className="gloom-qb-title" title={stack.title}>{stack.title}</span> : null}
        </>
      )}
      {searchNode}
      {items.length > 0 && (
        <div className="gloom-qb-filters">
          {items.map((item) => (
            <FilterChip key={item.id} item={item} open={openId === item.id} onOpenChange={(open) => setOpen(item.id, open)} />
          ))}
          {onClearAll && (
            <button type="button" className="gloom-qb-clear" onMouseDown={(event) => event.stopPropagation()} onClick={onClearAll}>
              <span className="gloom-qb-text">Clear</span>
            </button>
          )}
        </div>
      )}
      {meta && <span className="gloom-qb-meta">{meta}</span>}
      {view && (
        <div className="gloom-qb-view" role="radiogroup">
          {view.options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={option.value === view.value}
              title={option.hint ? `${option.label} (${option.hint})` : undefined}
              disabled={option.disabled}
              data-active={option.value === view.value ? "true" : undefined}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => { if (option.value !== view.value) view.onChange(option.value); }}
            >
              <span className="gloom-qb-text">{option.label}</span>
            </button>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

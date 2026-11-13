/** @jsxImportSource react */
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { HostQueryBarItem, HostQueryBarProps } from "../../../ui/host";
import { withChoiceGroupHeadings } from "../../../components/ui/choice-groups";
import { WebPopover } from "./popover";
import { WebMenu } from "./menu";
import { useHorizontalOverflow } from "../host/overflow-fade";
import { FADE_PX } from "../host/overflow-fade-px";
import { isLiveResizing, onLiveResizeEnd } from "../../../ui/live-resize";
import { STACK_DETAIL_ROLE, StackHeaderContext } from "./stack-header";
import { CheckboxBox } from "./controls";
import { WebIcon } from "./icons";

/** Input width of a text filter that names none, in cells (the terminal's default). */
const DEFAULT_TEXT_FIELD_CELLS = 20;
/** Beyond this many choices a long inline list (`scrolls`) is a strip that scrolls by itself, as the terminal's does. */
const STRIP_OPTION_LIMIT = 6;

function isStrip(item: HostQueryBarItem): boolean {
  return item.kind === "select" && item.inline === true && item.scrolls === true && item.options.length > STRIP_OPTION_LIMIT;
}

/** The open-menu id of a folded view: no filter's id. */
const VIEW_MENU_ID = "\u0000view";

/** Inline choices drawn as segments: what folds into its menu when the bar runs short. */
function isFoldable(item: HostQueryBarItem): boolean {
  return item.kind === "select" && item.inline === true && !isStrip(item);
}

/**
 * What a bar short of room gives up. Each step keeps what the one before gave
 * up, except that folding the inline choices brings the view back while it fits.
 */
interface QueryBarFit {
  /** Inline choices drop their label ("Range"): their choices name themselves. A strip keeps its own. */
  bareInline: boolean;
  /** Toggles show their short label ("Ext hours"). */
  shortToggles: boolean;
  /** The view (an interval, a sort) is its menu. */
  foldView: boolean;
  /** Inline choices are their menus. */
  foldInline: boolean;
}

const FULL_FIT: QueryBarFit = { bareInline: false, shortToggles: false, foldView: false, foldInline: false };

/** The steps a bar goes down, in order, while its controls run past its width; only those that change something. */
function fitSteps(items: readonly HostQueryBarItem[], view: HostQueryBarProps["view"]): QueryBarFit[] {
  const steps = [FULL_FIT];
  const then = (change: Partial<QueryBarFit>) => steps.push({ ...steps[steps.length - 1]!, ...change });
  if (items.some((item) => isFoldable(item) && item.label)) then({ bareInline: true });
  if (items.some((item) => item.kind === "toggle" && item.short && item.short !== item.label)) then({ shortToggles: true });
  const viewFolds = !!view && !view.start && view.options.length > 1;
  if (viewFolds) then({ foldView: true });
  if (items.some(isFoldable)) {
    if (viewFolds) then({ foldInline: true, foldView: false });
    then({ foldInline: true, foldView: viewFolds });
  }
  return steps;
}

/**
 * Calls `update` whenever `element` or one of its children changes size, except
 * while the pointer is resizing a pane: then once, after the resize ends.
 */
function observeSizes(element: HTMLElement, update: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  let afterResize = false;
  let frame = 0;
  const observer = new ResizeObserver(() => {
    if (isLiveResizing()) afterResize = true;
    else update();
  });
  const stopListening = onLiveResizeEnd(() => {
    if (!afterResize) return;
    afterResize = false;
    frame = requestAnimationFrame(update);
  });
  observer.observe(element);
  for (const child of element.children) observer.observe(child);
  return () => {
    observer.disconnect();
    stopListening();
    cancelAnimationFrame(frame);
  };
}

/**
 * Which of `stepCount` fit steps the bar is drawn at: the first whose controls
 * fit its width. A step that ran past the width is remembered with the width it
 * needed, so the bar goes back up only once it is that wide again and does not
 * open for a pixel and fold on the next. A change to what the bar holds (`key`)
 * starts again from the top. Measured before paint, so no step is ever seen;
 * while a pane is being dragged to a new size, once the drag ends.
 */
function useFitStep(scrollRef: RefObject<HTMLDivElement | null>, stepCount: number, key: string): number {
  const [state, setState] = useState({ key, step: 0 });
  const step = state.key === key ? Math.min(state.step, stepCount - 1) : 0;
  const needed = useRef({ key, widths: [] as number[] });
  if (needed.current.key !== key) needed.current = { key, widths: [] };
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || stepCount <= 1) return;
    const update = () => {
      const room = element.clientWidth + 1;
      const widths = needed.current.widths;
      if (element.scrollWidth > room) {
        if (step + 1 >= stepCount) return;
        widths[step] = element.scrollWidth;
        setState({ key, step: step + 1 });
        return;
      }
      const back = widths.findIndex((width, index) => index < step && width <= room);
      if (back >= 0) setState({ key, step: back });
    };
    update();
    // The bar's width, and a control that grows after it was measured (a late font).
    return observeSizes(element, update);
  }, [key, scrollRef, step, stepCount]);
  return step;
}

/** The least room the context is drawn in, in ems of its text: about three letters and its ellipsis. */
const CONTEXT_MIN_EMS = 2.5;

/**
 * The context (`meta`) gives way first, down to nothing; cut shorter than
 * `CONTEXT_MIN_EMS` it is not drawn at all rather than left as a sliver
 * of a word. Its box keeps its place, so nothing beside it moves.
 */
function useContextGivesWay(metaRef: RefObject<HTMLSpanElement | null>, text: string | undefined): void {
  useLayoutEffect(() => {
    const element = metaRef.current;
    if (!element) return;
    const update = () => {
      const style = getComputedStyle(element);
      const room = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const cut = element.scrollWidth > element.clientWidth + 0.5;
      element.toggleAttribute("data-sliver", cut && room < CONTEXT_MIN_EMS * parseFloat(style.fontSize));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [metaRef, text]);
}

/**
 * A strip that scrolls by itself narrows no further than its widest choice and
 * the fades either side of it (`--qb-strip-floor`, styles.css), so a whole
 * choice always shows and takes a click: the rest of the bar gives way, and
 * then scrolls, first. The chosen choice is kept in the middle, clear of the
 * fades, as the strip narrows and as the choice moves.
 */
function useStripFloor(stripRef: RefObject<HTMLDivElement | null>, strip: boolean, key: string): void {
  useLayoutEffect(() => {
    const element = stripRef.current;
    const group = element?.parentElement;
    if (!strip || !element || !group) return;
    const update = () => {
      let widest = 0;
      for (const choice of element.children) widest = Math.max(widest, choice.getBoundingClientRect().width);
      group.style.setProperty("--qb-strip-floor", `${Math.ceil(widest) + 2 * FADE_PX}px`);
      const chosen = element.querySelector<HTMLElement>("button[data-active=true]");
      if (!chosen) return;
      const box = element.getBoundingClientRect();
      const choice = chosen.getBoundingClientRect();
      element.scrollLeft += choice.left - box.left - (box.width - choice.width) / 2;
    };
    update();
    return observeSizes(element, update);
  }, [key, strip, stripRef]);
}

/**
 * The choices of an inline filter. A long list that scrolls by itself
 * (expiries) keeps the label and the controls beside it in view while it
 * keeps the chosen one in view. A bar short of room drops the label of any
 * other.
 */
export function InlineChoices({ item, bare = false }: { item: HostQueryBarItem; bare?: boolean }) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const strip = isStrip(item);
  const overflow = useHorizontalOverflow(stripRef, [item.options.length, strip]);
  useStripFloor(stripRef, strip, JSON.stringify([item.options.map((option) => option.label), item.options.find((option) => option.selected)?.value]));
  return (
    <div className="gloom-qb-inline" data-item-id={item.id} data-narrowing={item.narrowing ? "true" : undefined}
      data-strip={strip ? "true" : undefined} data-bare={bare ? "true" : undefined}>
      {bare ? null : <span className="gloom-qb-label">{item.label}</span>}
      <div
        ref={stripRef}
        className="gloom-qb-view gloom-qb-segments"
        role="radiogroup"
        aria-label={item.label}
        style={strip ? overflow.maskStyle : undefined}
        onWheel={strip ? overflow.onWheel : undefined}
      >
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
      items={withChoiceGroupHeadings(item.options.map((option) => ({
        id: option.value,
        label: option.label,
        group: option.group,
        description: option.description,
        disabled: option.disabled,
        selected: item.kind === "select" ? option.selected : undefined,
        checked: item.kind === "multi" ? option.selected : undefined,
        color: option.color,
      })))}
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
      onMouseDown={(event) => {
        event.stopPropagation();
        if (!item.active) item.onActivate?.();
      }}
    >
      <span className="gloom-qb-label">{item.label}</span>
      {/* The width sizes the input, as in the terminal; the segment grows to
          fit the label beside it. */}
      <div
        className="gloom-qb-search-input"
        style={{ "--qb-input-w": `calc(${item.width ?? DEFAULT_TEXT_FIELD_CELLS} * var(--cell-w))` } as CSSProperties}
      >
        {item.node}
      </div>
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

function FilterChip({ item, open, onOpenChange, fit, quietLabel = false }: {
  item: HostQueryBarItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the bar gave up to fit its width. */
  fit: QueryBarFit;
  /** The label names the menu but is not drawn: its choice names itself (a folded view). */
  quietLabel?: boolean;
}) {
  if (item.kind === "text") return <TextField item={item} />;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // A shortcut can open a filter that is scrolled out of a narrow bar.
  useEffect(() => {
    if (open) triggerRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [open]);
  const inline = item.kind === "select" && item.inline === true;
  if (inline && !(fit.foldInline && isFoldable(item))) return <InlineChoices item={item} bare={fit.bareInline && !isStrip(item)} />;
  if (item.kind === "toggle") {
    const short = fit.shortToggles && item.short ? item.short : null;
    return (
      <button
        type="button"
        className="gloom-qb-chip"
        data-kind="toggle"
        data-narrowing={item.narrowing ? "true" : undefined}
        aria-pressed={item.checked}
        title={short ? item.label : undefined}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={item.onToggle}
      >
        <CheckboxBox checked={!!item.checked} />
        <span className="gloom-qb-value">{short ?? item.label}</span>
      </button>
    );
  }
  // An inline filter folded into its menu has already dropped its label, unless it names no choice (a chart
  // panned off its ranges); a folded view draws none. Its name still follows the choice it shows.
  const quiet = !!item.valueLabel && (quietLabel || (inline && fit.bareInline));
  const label = quiet ? "" : item.label;
  const ariaLabel = quiet && item.label ? `${item.valueLabel}, ${item.label}` : undefined;

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
      aria-label={ariaLabel}
      onClick={() => onOpenChange(!open)}
    >
      {label ? <span className="gloom-qb-label">{label}</span> : null}
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

export function WebQueryBar({ search, items, view, onClearAll, meta, asOf, leading, openRequest }: HostQueryBarProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // At the top of an open stack detail, take its Back and title as leading
  // segments so the detail shows one toolbar, not two.
  const stack = useContext(StackHeaderContext);
  const [stackAttached, setStackAttached] = useState(false);
  useLayoutEffect(() => {
    const bar = rootRef.current;
    // A bar that mounts with its detail runs this before React attaches the
    // detail's ref, so it finds the detail it sits in by itself.
    const container = stack?.containerRef.current
      ?? bar?.closest<HTMLElement>(`[data-gloom-role='${STACK_DETAIL_ROLE}']`);
    if (!stack || !bar || !container || !container.contains(bar)) return;
    if (Math.abs(bar.getBoundingClientRect().top - container.getBoundingClientRect().top) > 1.5) return;
    const release = stack.attach();
    setStackAttached(true);
    return () => {
      release();
      setStackAttached(false);
    };
  }, [stack]);
  // What sets the controls' width, so the bar is measured again when it changes and not on every render.
  // The context (`meta`) gives way by itself and does not count.
  const contentKey = JSON.stringify([
    // A text filter's field keeps its width while it is typed in.
    items.map((item) => [item.id, item.kind, item.label, item.short, item.kind === "text" ? null : item.valueLabel, item.narrowing, item.width,
      item.inline ? item.options.map((option) => option.label) : null]),
    view ? [view.start, view.value, view.label, view.options.map((option) => option.label)] : null,
    !!search, !!onClearAll, asOf ?? null, !!leading, stackAttached, stack?.title ?? null,
  ]);
  const steps = fitSteps(items, view);
  const fitStep = useFitStep(scrollRef, steps.length, contentKey);
  const fit = steps[fitStep] ?? FULL_FIT;
  const overflow = useHorizontalOverflow(scrollRef, [items.length, !!search, !!view, !!onClearAll, meta, asOf, fitStep]);
  const metaRef = useRef<HTMLSpanElement | null>(null);
  useContextGivesWay(metaRef, meta);
  const searchRef = useRef<HTMLDivElement | null>(null);
  // When an inline choice or the view changes (a shortcut, the next expiry),
  // bring the new selection into a scrolled bar. On mount only a strip that
  // scrolls by itself shows its choice: an expiry chosen far down the strip
  // is what the pane shows, but scrolling the whole bar to a view at the right
  // edge would hide the search when the pane opens.
  const selectionKey = [
    ...items.filter((item) => item.inline).map((item) => `${item.id}=${item.options.find((option) => option.selected)?.value ?? ""}`),
    `view=${view?.value ?? ""}`,
  ].join("|");
  const previousSelectionKey = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousSelectionKey.current;
    previousSelectionKey.current = selectionKey;
    if (previous === selectionKey) return;
    const before = previous == null ? null : new Map(previous.split("|").map((entry) => entry.split("=") as [string, string]));
    const bar = scrollRef.current;
    if (!bar) return;
    for (const entry of selectionKey.split("|")) {
      const [id, value] = entry.split("=") as [string, string];
      if (before?.get(id) === value) continue;
      const group = id === "view"
        ? bar.querySelector(":scope > .gloom-qb-view")
        : [...bar.querySelectorAll("[data-item-id]")].find((item) => item.getAttribute("data-item-id") === id);
      if (!before && group?.getAttribute("data-strip") !== "true") continue;
      group?.querySelector<HTMLElement>("button[data-active=true]")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
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

  // A nested tab strip's choices start the bar, as a tab row does; any other view sits at its right.
  const viewNode = view ? (
    <div className="gloom-qb-view" role="radiogroup" aria-label={view.label} data-placement={view.start ? "start" : undefined}>
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
          onClick={() => view.onChange(option.value)}
        >
          <span className="gloom-qb-text">{option.label}</span>
        </button>
      ))}
    </div>
  ) : null;
  // Folded, the view is a menu chip in its place, named by its choice.
  const viewMenu = view && fit.foldView ? (
    <div className="gloom-qb-fold">
      <FilterChip
        item={{
          id: VIEW_MENU_ID,
          kind: "select",
          label: view.label ?? "View",
          valueLabel: view.options.find((option) => option.value === view.value)?.label ?? view.value,
          narrowing: false,
          options: view.options.map((option) => ({
            value: option.value,
            label: option.label,
            disabled: option.disabled,
            hint: option.hint,
            selected: option.value === view.value,
          })),
          onSelect: view.onChange,
          onToggle: () => {},
          onReset: () => {},
        }}
        open={openId === VIEW_MENU_ID}
        onOpenChange={(open) => setOpen(VIEW_MENU_ID, open)}
        fit={fit}
        quietLabel
      />
    </div>
  ) : null;

  return (
    <div
      ref={rootRef}
      className="gloom-qb"
      data-gloom-role="query-bar"
      // The active title-bar tab above takes this band's colour (top-surface.ts).
      data-gloom-top-surface=""
      // A search with nothing beside it may take the room the filters would.
      data-search-only={search && items.length === 0 && !view ? "true" : undefined}
    >
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
      {view?.start ? viewNode : null}
      {leading ? <div className="gloom-qb-leading">{leading}</div> : null}
      {searchNode}
      {items.length > 0 && (
        <div className="gloom-qb-filters" data-strip={items.some(isStrip) ? "true" : undefined}>
          {items.map((item) => (
            <FilterChip key={item.id} item={item} open={openId === item.id} onOpenChange={(open) => setOpen(item.id, open)} fit={fit} />
          ))}
          {onClearAll && (
            <button type="button" className="gloom-qb-clear" onMouseDown={(event) => event.stopPropagation()} onClick={onClearAll}>
              <span className="gloom-qb-text">Clear</span>
            </button>
          )}
        </div>
      )}
      {/* The as-of keeps its width; the context after it gives way first. */}
      {asOf ? <span className="gloom-qb-meta gloom-qb-asof">{asOf}</span> : null}
      {meta ? <span ref={metaRef} className="gloom-qb-meta">{meta}</span> : null}
      {view && !view.start ? (fit.foldView ? viewMenu : viewNode) : null}
      </div>
    </div>
  );
}

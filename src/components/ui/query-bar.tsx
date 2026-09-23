import { useCallback, useMemo, useRef, useState, type ComponentType, type ReactNode, type Ref, type RefObject } from "react";
import { Box, Text, useUiHost, type InputRenderable } from "../../ui";
import type { HostQueryBarItem, HostQueryBarProps } from "../../ui/host";
import { useRemoteUiNode } from "../../remote/semantic-tree";
import { useThemeColors } from "../../theme/theme-context";
import { InputSearchBar } from "../input-search-bar";
import { Checkbox } from "./checkbox";
import { MultiSelectDialogButton } from "./multi-select/dialog";
import { summarizeMultiSelectValues, toggleMultiSelectValue, type MultiSelectOption } from "./multi-select";
import { SelectButton, type SelectButtonOption, type SelectControl } from "./select-button";
import { SegmentedControl } from "./toggle";
import { Tabs } from "./tabs";

export interface QueryBarSearch {
  value: string;
  onChange: (query: string) => void;
  placeholder: string;
  /** The pane is focused. */
  focused: boolean;
  /** The field owns the keyboard. */
  active: boolean;
  onActiveChange: (active: boolean) => void;
  /** Change to focus the field again, e.g. from a `/` shortcut. */
  focusToken?: number;
  inputRef?: RefObject<InputRenderable | null>;
  debounceMs?: number;
  onNavigateDown?: () => void;
  /** Compares drafts before committing, e.g. trim so a trailing space does not re-query. */
  normalizeValue?: (value: string) => string;
}

interface QueryBarFilterBase {
  id: string;
  /** Names the dimension on the control, e.g. "Side". */
  label: string;
}

export interface QueryBarSelectFilter<T extends string = string> extends QueryBarFilterBase {
  kind?: "select";
  value: T;
  /**
   * The value the pane starts with. Any other value marks the filter as changed
   * and gives it a reset. Omit for a choice that picks what is shown rather
   * than narrowing it (a trader class, a model).
   */
  defaultValue?: T;
  options: readonly SelectButtonOption<T>[];
  onChange: (value: T) => void;
  /** Lets a pane shortcut open this filter's menu. */
  controlRef?: Ref<SelectControl>;
  title?: string;
  /** Draw the options inline (one click) instead of a menu. For four or fewer short values. */
  inline?: boolean;
}

export interface QueryBarMultiFilter extends QueryBarFilterBase {
  kind: "multi";
  values: string[];
  options: readonly MultiSelectOption[];
  onChange: (values: string[]) => void;
  /** Shown when nothing is selected, which also means nothing is filtered. */
  emptyLabel?: string;
  title?: string;
  onOpenChange?: (open: boolean) => void;
}

export interface QueryBarToggleFilter extends QueryBarFilterBase {
  kind: "toggle";
  value: boolean;
  onChange: (value: boolean) => void;
  /**
   * The state the pane starts in; the other one narrows and gets a reset. True
   * for a toggle that shows something by default (a fit line), so turning it
   * on is not counted as a filter.
   */
  defaultValue?: boolean;
}

/** A second free-text field beside the search, e.g. a tickers filter. */
export interface QueryBarTextFilter extends QueryBarFilterBase {
  kind: "text";
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  focused: boolean;
  active: boolean;
  onActiveChange: (active: boolean) => void;
  focusToken?: number;
  inputRef?: RefObject<InputRenderable | null>;
  debounceMs?: number;
  /** Input width in cells; the label is drawn beside it. */
  width?: number;
  /**
   * Enter in the field. `onChange` still follows typing, so a pane that should
   * apply the value only when it is complete (a date) can keep a draft in
   * `onChange` and apply here.
   */
  onSubmit?: (value: string) => void;
}

export type QueryBarFilter = QueryBarSelectFilter<any> | QueryBarMultiFilter | QueryBarToggleFilter | QueryBarTextFilter;

export interface QueryBarView<T extends string = string> {
  value: T;
  options: readonly { value: T; label: string; hint?: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  /** Terminal: left/right cycle the view while this is true. */
  focused?: boolean;
  shortcutScope?: string;
}

export interface QueryBarProps {
  width: number;
  search?: QueryBarSearch;
  filters?: QueryBarFilter[];
  /** Presentation that does not narrow the list: sort, range, interval. Right aligned. */
  view?: QueryBarView<any>;
  /** Muted context at the right edge (the selected row's date). Not for status. */
  meta?: string;
}

/** Beyond this many options a terminal strip scrolls instead of segmenting. */
const TERMINAL_SEGMENT_LIMIT = 6;

/**
 * Terminal rendering of an inline filter or view: segments for a few short
 * options, a scrolling tab strip for many (expiries, chart ranges). Hints
 * prefix the label ("1:1D") because the terminal has no tooltip.
 */
function TerminalChoiceStrip({
  options,
  value,
  onChange,
  focused,
  shortcutScope,
}: {
  options: { value: string; label: string; hint?: string; disabled?: boolean }[];
  value: string;
  onChange: (value: string) => void;
  focused?: boolean;
  shortcutScope?: string;
}) {
  const labelled = options.map((option) => ({
    value: option.value,
    label: option.hint ? `${option.hint}:${option.label}` : option.label,
    disabled: option.disabled,
  }));
  if (options.length > TERMINAL_SEGMENT_LIMIT) {
    return (
      <Box flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden">
        <Tabs
          tabs={labelled}
          activeValue={value || null}
          onSelect={onChange}
          compact
          dense
          variant="bare"
          focused={focused}
          keyboardNavigation={false}
        />
      </Box>
    );
  }
  return (
    <SegmentedControl
      options={labelled}
      value={value}
      onChange={onChange}
      focused={focused}
      shortcutScope={shortcutScope}
    />
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else (ref as { current: T | null }).current = value;
}

function isNarrowing(filter: QueryBarFilter): boolean {
  if (filter.kind === "text") return filter.value.trim().length > 0;
  if (filter.kind === "toggle") return filter.value !== (filter.defaultValue ?? false);
  if (filter.kind === "multi") return filter.values.length > 0;
  return filter.defaultValue !== undefined && filter.value !== filter.defaultValue;
}

/**
 * The one row above a list that narrows or reorders it: search, filters, a view
 * switch. Every pane with query controls uses it, so they read and behave the
 * same everywhere. The desktop draws soft chips with menus; the terminal keeps
 * text controls and the choice dialogs.
 */
export function QueryBar({ width, search, filters = [], view, meta }: QueryBarProps) {
  const ui = useUiHost();
  const colors = useThemeColors();
  const HostQueryBar = ui.QueryBar as ComponentType<HostQueryBarProps> | undefined;
  const localInputRef = useRef<InputRenderable | null>(null);
  const fallbackTextRef = useRef<InputRenderable | null>(null);
  const inputRef = search?.inputRef ?? localInputRef;
  const [openRequest, setOpenRequest] = useState<{ id: string; token: number } | null>(null);
  const narrowingCount = filters.filter(isNarrowing).length;

  const resetAll = useCallback(() => {
    for (const filter of filters) {
      if (!isNarrowing(filter)) continue;
      if (filter.kind === "toggle") filter.onChange(filter.defaultValue ?? false);
      else if (filter.kind === "text") filter.onChange("");
      else if (filter.kind === "multi") filter.onChange([]);
      else if (filter.defaultValue !== undefined) filter.onChange(filter.defaultValue);
    }
  }, [filters]);

  // The active choice of each select filter and the view, like tabs expose
  // their active value, so automation can confirm what the pane shows.
  const selections = [
    ...filters.flatMap((filter) => {
      if (filter.kind === "text" || filter.kind === "toggle" || filter.kind === "multi") return [];
      const current = filter.options.find((option) => option.value === filter.value);
      return [{ id: filter.id, value: String(filter.value), label: current?.label ?? null }];
    }),
    ...(view ? [{
      id: "view",
      value: String(view.value),
      label: view.options.find((option) => option.value === view.value)?.label ?? null,
    }] : []),
  ];

  useRemoteUiNode({
    role: "query-bar",
    label: "Query bar",
    actions: { clear: resetAll },
    metadata: { narrowing: narrowingCount, search: search?.value ?? null, view: view?.value ?? null, selections },
  });

  const searchNode = search ? (
    <InputSearchBar
      value={search.value}
      focused={search.focused}
      active={search.active}
      width={HostQueryBar ? "100%" : Math.max(16, Math.min(36, Math.floor(width * 0.3)))}
      focusToken={search.focusToken ?? 0}
      inputRef={inputRef}
      placeholder={search.placeholder}
      debounceMs={search.debounceMs ?? 80}
      normalizeValue={search.normalizeValue}
      appearance={HostQueryBar ? "plain" : "strip"}
      onNavigateDown={search.onNavigateDown ?? (() => search.onActiveChange(false))}
      onFocus={() => search.onActiveChange(true)}
      onBlur={() => search.onActiveChange(false)}
      onQueryChange={search.onChange}
    />
  ) : null;

  const textNodes = new Map<string, ReactNode>();
  for (const filter of filters) {
    if (filter.kind !== "text") continue;
    textNodes.set(filter.id, (
      <InputSearchBar
        value={filter.value}
        focused={filter.focused}
        active={filter.active}
        width={HostQueryBar ? "100%" : (filter.width ?? 20) + filter.label.length + 1}
        focusToken={filter.focusToken ?? 0}
        inputRef={filter.inputRef ?? fallbackTextRef}
        placeholder={filter.placeholder}
        debounceMs={filter.debounceMs ?? 80}
        glyph={filter.label}
        appearance={HostQueryBar ? "plain" : "strip"}
        onNavigateDown={() => filter.onActiveChange(false)}
        onFocus={() => filter.onActiveChange(true)}
        onBlur={() => filter.onActiveChange(false)}
        onQueryChange={filter.onChange}
        onSubmit={filter.onSubmit}
      />
    ));
  }

  const items = useMemo<HostQueryBarItem[]>(() => filters.map((filter) => {
    if (filter.kind === "text") {
      return {
        id: filter.id,
        kind: "text",
        label: filter.label,
        valueLabel: filter.value,
        narrowing: isNarrowing(filter),
        options: [],
        node: textNodes.get(filter.id),
        active: filter.active,
        width: filter.width,
        onActivate: () => {
          filter.onActiveChange(true);
          filter.inputRef?.current?.focus?.();
        },
        onSelect: () => {},
        onToggle: () => {},
        onReset: () => filter.onChange(""),
      };
    }
    if (filter.kind === "toggle") {
      return {
        id: filter.id,
        kind: "toggle",
        label: filter.label,
        valueLabel: filter.label,
        narrowing: isNarrowing(filter),
        checked: filter.value,
        options: [],
        onSelect: () => {},
        onToggle: () => filter.onChange(!filter.value),
        onReset: () => filter.onChange(filter.defaultValue ?? false),
      };
    }
    if (filter.kind === "multi") {
      return {
        id: filter.id,
        kind: "multi",
        label: filter.label,
        valueLabel: summarizeMultiSelectValues({ options: filter.options, selectedValues: filter.values, emptyLabel: filter.emptyLabel ?? "All" }),
        narrowing: filter.values.length > 0,
        options: filter.options.map((option) => ({
          value: option.value,
          label: option.label,
          description: option.description,
          disabled: option.disabled,
          selected: filter.values.includes(option.value),
        })),
        onSelect: (value: string) => filter.onChange(toggleMultiSelectValue(filter.options, filter.values, value)),
        onToggle: () => {},
        onReset: () => filter.onChange([]),
      };
    }
    const current = filter.options.find((option) => option.value === filter.value);
    return {
      id: filter.id,
      kind: "select",
      label: filter.label,
      valueLabel: current?.short ?? current?.label ?? String(filter.value),
      narrowing: isNarrowing(filter),
      inline: filter.inline === true,
      options: filter.options.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
        disabled: option.disabled,
        selected: option.value === filter.value,
        hint: option.hint,
      })),
      onSelect: (value: string) => { if (value !== filter.value) filter.onChange(value); },
      onToggle: () => {},
      onReset: () => { if (filter.defaultValue !== undefined) filter.onChange(filter.defaultValue); },
    };
    // textNodes is rebuilt from `filters` each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [filters]);

  // Pane shortcuts open a filter through its SelectControl ref on every host.
  const tokenRef = useRef(0);
  const hostControls = useMemo(() => new Map(filters.map((filter) => [filter.id, {
    open: () => setOpenRequest({ id: filter.id, token: ++tokenRef.current }),
  }])), [filters]);
  if (HostQueryBar) {
    for (const filter of filters) {
      if (filter.kind !== "toggle" && filter.kind !== "multi" && filter.kind !== "text") assignRef(filter.controlRef, hostControls.get(filter.id) ?? null);
    }
    return (
      <HostQueryBar
        search={search ? {
          node: searchNode,
          filled: search.value.length > 0,
          active: search.active,
          onActivate: () => {
            search.onActiveChange(true);
            inputRef.current?.focus?.();
          },
          onClear: () => search.onChange(""),
        } : undefined}
        items={items}
        view={view ? {
          value: view.value,
          options: view.options.map((option) => ({ value: option.value, label: option.label, hint: option.hint, disabled: option.disabled })),
          onChange: view.onChange,
        } : undefined}
        onClearAll={narrowingCount >= 2 ? resetAll : undefined}
        meta={meta}
        openRequest={openRequest}
      />
    );
  }

  return (
    <Box height={1} width={width} flexDirection="row" gap={2} paddingX={1} overflow="hidden" flexShrink={0}>
      {searchNode}
      {filters.map((filter) => {
        if (filter.kind === "text") {
          return <Box key={filter.id} flexShrink={0}>{textNodes.get(filter.id)}</Box>;
        }
        if (filter.kind === "toggle") {
          return <Checkbox key={filter.id} label={filter.label} checked={filter.value} onChange={filter.onChange} />;
        }
        if (filter.kind === "multi") {
          return (
            <MultiSelectDialogButton
              key={filter.id}
              label={filter.label}
              title={filter.title ?? filter.label}
              options={[...filter.options]}
              selectedValues={filter.values}
              emptyLabel={filter.emptyLabel ?? "All"}
              onOpenChange={filter.onOpenChange}
              onChange={(values: string[]) => filter.onChange(values)}
            />
          );
        }
        if (filter.inline) {
          return (
            <Box key={filter.id} flexDirection="row" gap={1} flexShrink={filter.options.length > TERMINAL_SEGMENT_LIMIT ? 1 : 0} minWidth={0}>
              <Box flexShrink={0}><Text fg={colors.textMuted}>{filter.label}</Text></Box>
              <TerminalChoiceStrip
                options={filter.options.map((option) => ({ value: option.value, label: option.short ?? option.label, hint: option.hint, disabled: option.disabled }))}
                value={filter.value}
                onChange={filter.onChange}
              />
            </Box>
          );
        }
        return (
          <SelectButton
            key={filter.id}
            label={filter.label}
            title={filter.title}
            value={filter.value}
            options={filter.options}
            onChange={filter.onChange}
            controlRef={filter.controlRef}
            emphasized={isNarrowing(filter)}
          />
        );
      })}
      {narrowingCount >= 2 && (
        <Box onMouseDown={resetAll} cursor="pointer"><Text fg={colors.textDim}>clear</Text></Box>
      )}
      {(view || meta) && <Box flexGrow={1} />}
      {meta && <Text fg={colors.textMuted}>{meta}</Text>}
      {view && (
        <>
          <TerminalChoiceStrip
            options={view.options.map((option) => ({ value: option.value, label: option.label, hint: option.hint, disabled: option.disabled }))}
            value={view.value}
            onChange={view.onChange}
            focused={view.focused}
            shortcutScope={view.shortcutScope}
          />
        </>
      )}
    </Box>
  );
}

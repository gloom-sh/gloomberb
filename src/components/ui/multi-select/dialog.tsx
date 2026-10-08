import { Box, Text, useUiCapabilities, type InputRenderable } from "../../../ui";
import { TextAttributes } from "../../../ui";
import { useShortcut, useViewport } from "../../../react/input";
import { type AlertContext, useDialog, useDialogKeyboard } from "../../../ui/dialog";
import {
  forwardRef,
  type ForwardedRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { colors } from "../../../theme/colors";
import { isDetailBackNavigationKey } from "../../../utils/back-navigation";
import { isPlainKeyboardEvent } from "../../../utils/keyboard";
import { ToggleList } from "../../toggle-list";
import { Button } from "../button";
import { TextField } from "../fields";
import { listCursorMove } from "../list-view";
import { DialogFrame } from "../frame";
import { Popover } from "../popover";
import { Menu } from "../menu";
import {
  getMultiSelectDisplayValues,
  mergeMultiSelectDisplayValues,
  moveMultiSelectDisplayValue,
  moveMultiSelectValue,
  normalizeMultiSelectValues,
  normalizeOrderedMultiSelectValues,
  orderMultiSelectOptionsForDisplay,
  summarizeMultiSelectValues,
  toggleOrderedMultiSelectValue,
  toggleMultiSelectValue,
  type MultiSelectOption,
} from "./index";

/**
 * One action on the highlighted row, shown beside Done: editing a value the
 * option carries, such as an indicator's period.
 */
export interface MultiSelectRowAction {
  label: string;
  shortcut: string;
  /** Name and key for the highlighted row when they differ by row: Period, Bands, Anchors. */
  labelFor?(value: string): string;
  shortcutFor?(value: string): string;
  /** Whether the highlighted option offers it; `selected` is its checkbox. */
  appliesTo(value: string, selected: boolean): boolean;
  /**
   * A returned label replaces the row's label while the dialog stays open;
   * `{ close: true }` closes the dialog, for an action that continues outside it.
   */
  run(value: string): Promise<string | { close: true } | void> | string | { close: true } | void;
}

export interface MultiSelectDialogContentProps extends AlertContext {
  title: string;
  options: MultiSelectOption[];
  selectedValues: string[];
  onChange: (values: string[]) => Promise<void> | void;
  ordered?: boolean;
  emptyLabel?: string;
  idPrefix?: string;
  rowAction?: MultiSelectRowAction;
  /**
   * For a long list: a filter box over the rows (typing narrows them by label
   * and description), each description beside its label and, when ordered,
   * each selection's position at the row's end. The keyboard stays with the
   * box: arrows move, Space picks, [ and ] reorder, Enter is done.
   */
  searchable?: boolean;
}

export interface MultiSelectDialogButtonProps {
  label: string;
  title?: string;
  options: MultiSelectOption[];
  selectedValues: string[];
  onChange: (values: string[]) => Promise<void> | void;
  disabled?: boolean;
  emptyLabel?: string;
  ordered?: boolean;
  idPrefix?: string;
  renderTrigger?: (props: MultiSelectDialogTriggerProps) => ReactNode;
  shortcutKey?: string | string[];
  shortcutActive?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Opens the dialog on desktop too, since the popover menu has no row actions. */
  rowAction?: MultiSelectRowAction;
  /** A filter box over the rows; opens the dialog on desktop too, since the popover menu has none. */
  searchable?: boolean;
}

export interface MultiSelectPopoverAnchorPoint {
  x: number;
  y: number;
}

export interface MultiSelectDialogButtonHandle {
  open(anchorPoint?: MultiSelectPopoverAnchorPoint): void;
  close(): void;
}

type DialogTriggerEvent = { stopPropagation?: () => void; preventDefault?: () => void };

interface MultiSelectDialogTriggerProps {
  buttonLabel: string;
  buttonText: string;
  summary: string;
  disabled: boolean;
  openDialog: (event?: DialogTriggerEvent) => void;
  stopMouseEvent: (event?: DialogTriggerEvent) => void;
}

function isSpaceKey(event: { name?: string; sequence?: string }): boolean {
  return event.name === "space" || event.name === " " || event.sequence === " ";
}

function stopMouseEvent(event?: DialogTriggerEvent) {
  event?.stopPropagation?.();
  event?.preventDefault?.();
}

/** Desktop list rows are this many cells tall. */
const DESKTOP_ROW_HEIGHT = 1.35;
/** Terminal rows the dialog spends around its list: frame, title, buttons. */
const TERMINAL_DIALOG_CHROME_ROWS = 10;
/** Cells a searchable list shows on the desktop and web; the rest scrolls. */
const DESKTOP_SEARCHABLE_LIST_CELLS = 16;

/** A key that types a character: the filter box takes it. */
function isTextKey(event: { sequence?: string; ctrl?: boolean; meta?: boolean; alt?: boolean }): boolean {
  return event.sequence?.length === 1 && event.sequence >= " " && event.sequence !== "\u007f"
    && !event.ctrl && !event.meta && !event.alt;
}

function matchesFilter(option: MultiSelectOption, needle: string): boolean {
  return `${option.label} ${option.description ?? ""}`.toLowerCase().includes(needle);
}

/** The picks in their order, then every other option in the order given. */
function selectedFirstOptions(options: readonly MultiSelectOption[], selectedValues: readonly string[]): MultiSelectOption[] {
  const byValue = new Map(options.map((option) => [option.value, option]));
  const picked = selectedValues.flatMap((value) => byValue.get(value) ?? []);
  const chosen = new Set(picked.map((option) => option.value));
  return [...picked, ...options.filter((option) => !chosen.has(option.value))];
}

type FocusedNode = { blur?(): void; closest?(selector: string): unknown };

/**
 * The highlight moved from the keyboard, so Space, Enter and [ ] act on the
 * list again: a button a click or Tab left focused in the dialog lets go. A
 * focused row follows the highlight by itself.
 */
function releaseFocusOutsideList() {
  const doc = (globalThis as { document?: { activeElement: FocusedNode | null } }).document;
  const active = doc?.activeElement;
  if (active?.closest?.(".gloom-dialog") && !active.closest?.('[role="listbox"]')) active.blur?.();
}

function matchesShortcut(
  event: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean; super?: boolean; alt?: boolean; option?: boolean; shift?: boolean },
  shortcutKey: string | string[] | undefined,
): boolean {
  if (!shortcutKey || !isPlainKeyboardEvent(event)) return false;
  const keys = Array.isArray(shortcutKey) ? shortcutKey : [shortcutKey];
  const name = event.name?.toLowerCase() ?? "";
  const sequence = event.sequence?.toLowerCase() ?? "";
  return keys.some((key) => {
    const normalized = key.toLowerCase();
    return normalized === name || normalized === sequence;
  });
}

function DesktopMultiSelectMenu({
  title,
  options,
  selectedValues: selectedValuesProp,
  onChange,
  emptyLabel,
}: Pick<MultiSelectDialogContentProps, "title" | "options" | "selectedValues" | "onChange" | "emptyLabel">) {
  const [selectedValues, setSelectedValues] = useState(() => normalizeMultiSelectValues(options, selectedValuesProp));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedValues(normalizeMultiSelectValues(options, selectedValuesProp));
  }, [options, selectedValuesProp]);

  const toggleOption = async (option: MultiSelectOption) => {
    if (option.disabled) return;
    const previous = selectedValues;
    const next = toggleMultiSelectValue(options, selectedValues, option.value);
    setSelectedValues(next);
    setError(null);
    try {
      await onChange(next);
    } catch (nextError) {
      setSelectedValues(previous);
      setError(nextError instanceof Error ? nextError.message : "Could not update selection.");
    }
  };

  return (
    <Menu
      title={title}
      label={title}
      selection="multi"
      items={options.length === 0
        ? [{ id: "\u0000empty", label: emptyLabel ?? "None", disabled: true }]
        : [
          ...options.map((option) => ({
            id: option.value,
            label: option.label,
            description: option.description,
            disabled: option.disabled,
            checked: selectedValues.includes(option.value),
          })),
          ...(error ? [{ id: "\u0000error", kind: "heading" as const, label: error }] : []),
        ]}
      onSelect={(value) => {
        const option = options.find((entry) => entry.value === value);
        if (option) void toggleOption(option);
      }}
    />
  );
}

function normalizeDialogSelectedValues(
  options: readonly MultiSelectOption[],
  values: readonly string[],
  ordered: boolean,
): string[] {
  return ordered
    ? normalizeOrderedMultiSelectValues(options, values)
    : normalizeMultiSelectValues(options, values);
}

export function MultiSelectDialogContent({
  dismiss,
  dialogId,
  title,
  options,
  selectedValues: selectedValuesProp,
  onChange,
  ordered = false,
  idPrefix,
  rowAction,
  searchable = false,
}: MultiSelectDialogContentProps) {
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const optionByValue = useMemo(() => new Map(options.map((option) => [option.value, option])), [options]);
  const [selectedValues, setSelectedValues] = useState(() => normalizeDialogSelectedValues(options, selectedValuesProp, ordered));
  const [displayValues, setDisplayValues] = useState(() => getMultiSelectDisplayValues(options, selectedValuesProp, ordered));
  const knownSelectedValues = selectedValues.filter((value) => optionByValue.has(value));
  // A long ordered list reads as the list being built on top, the rest below;
  // a short one keeps every option in its row and swaps the picks among them.
  const selectedFirst = searchable && ordered;
  const displayOptions = useMemo(
    () => (selectedFirst
      ? selectedFirstOptions(options, selectedValues)
      : orderMultiSelectOptionsForDisplay(options, displayValues)),
    [displayValues, options, selectedFirst, selectedValues],
  );
  const [filter, setFilter] = useState("");
  const filterRef = useRef<InputRenderable | null>(null);
  const needle = searchable ? filter.trim().toLowerCase() : "";
  const visibleOptions = useMemo(
    () => (needle ? displayOptions.filter((option) => matchesFilter(option, needle)) : displayOptions),
    [displayOptions, needle],
  );
  const [selectedOptionId, setSelectedOptionId] = useState(options[0]?.value ?? "");
  const selectedIndex = Math.max(0, visibleOptions.findIndex((option) => option.value === selectedOptionId));
  const selectedOption = visibleOptions[selectedIndex];
  const selectedOptionValue = selectedOption?.value ?? "";
  const selectedValueOrder = knownSelectedValues.indexOf(selectedOptionValue);
  const canMoveUp = ordered && selectedValueOrder > 0;
  const canMoveDown = ordered
    && selectedValueOrder >= 0
    && selectedValueOrder < knownSelectedValues.length - 1;
  const [labelOverrides, setLabelOverrides] = useState<Record<string, string>>({});
  const canRunRowAction = !!rowAction
    && !!selectedOption
    && !selectedOption.disabled
    && rowAction.appliesTo(selectedOption.value, selectedValues.includes(selectedOption.value));
  const rowActionLabel = rowAction && selectedOption && rowAction.labelFor
    ? rowAction.labelFor(selectedOption.value) : rowAction?.label;
  const rowActionShortcut = rowAction && selectedOption && rowAction.shortcutFor
    ? rowAction.shortcutFor(selectedOption.value) : rowAction?.shortcut;

  useEffect(() => {
    setSelectedValues((values) => normalizeDialogSelectedValues(options, values, ordered));
    setDisplayValues((values) => mergeMultiSelectDisplayValues(options, values));
  }, [options, ordered]);

  useEffect(() => {
    if (displayOptions.some((option) => option.value === selectedOptionId)) return;
    setSelectedOptionId(displayOptions[0]?.value ?? "");
  }, [displayOptions, selectedOptionId]);

  // A touch screen would raise its keyboard over the list the moment it opens.
  useEffect(() => {
    if (!searchable || (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia?.("(pointer: coarse)").matches) return;
    const timer = setTimeout(() => filterRef.current?.focus?.(), 0);
    return () => clearTimeout(timer);
  }, [searchable]);

  const toggleItems = visibleOptions.map((option) => {
    const order = knownSelectedValues.indexOf(option.value);
    const orderDescription = ordered && order >= 0
      ? `Order ${order + 1} of ${knownSelectedValues.length}.`
      : null;

    return {
      id: option.value,
      label: labelOverrides[option.value] ?? option.label,
      disabled: option.disabled,
      enabled: selectedValues.includes(option.value),
      description: searchable
        ? option.description
        : [option.description, orderDescription].filter((entry): entry is string => !!entry).join(" "),
      detail: searchable && ordered && order >= 0 ? String(order + 1) : undefined,
    };
  });
  const viewport = useViewport();
  // A short terminal would clip rows under the dialog's edge: the list scrolls
  // in whatever height is left. The height follows the whole list, not the rows
  // the filter leaves, so typing does not make the dialog jump.
  const listHeight = isDesktopWeb
    ? Math.min(searchable ? DESKTOP_SEARCHABLE_LIST_CELLS : 12, Math.max(5, displayOptions.length * DESKTOP_ROW_HEIGHT))
    : Math.max(3, Math.min(12, Math.max(6, displayOptions.length), viewport.height - TERMINAL_DIALOG_CHROME_ROWS - (searchable ? 2 : 0)));
  const pageSize = Math.floor(listHeight / (isDesktopWeb ? DESKTOP_ROW_HEIGHT : 1)) - 1;

  const applySelectedValues = async (nextValues: string[], nextDisplayValues = displayValues) => {
    const previousValues = selectedValues;
    const previousDisplayValues = displayValues;
    setSelectedValues(nextValues);
    setDisplayValues(nextDisplayValues);
    try {
      await onChange(nextValues);
    } catch (error) {
      setSelectedValues(previousValues);
      setDisplayValues(previousDisplayValues);
      throw error;
    }
  };

  const toggleOption = async (option: MultiSelectOption | undefined) => {
    if (!option || option.disabled) return;
    const nextValues = ordered
      ? toggleOrderedMultiSelectValue(options, selectedValues, option.value)
      : toggleMultiSelectValue(options, selectedValues, option.value);
    const row = visibleOptions.findIndex((entry) => entry.value === option.value);
    await applySelectedValues(nextValues);
    if (!selectedFirst) return;
    // The row moved between the picks and the rest. The cursor stays on its
    // line, so Space picks or drops a row and moves on to the next.
    const next = selectedFirstOptions(options, nextValues).filter((entry) => !needle || matchesFilter(entry, needle));
    setSelectedOptionId(next[Math.min(Math.max(row, 0), next.length - 1)]?.value ?? option.value);
  };

  const moveOption = async (direction: "up" | "down") => {
    if (!ordered || !selectedOption) return;
    await applySelectedValues(
      moveMultiSelectValue(options, selectedValues, selectedOption.value, direction),
      selectedFirst ? displayValues : moveMultiSelectDisplayValue(displayValues, knownSelectedValues, selectedOption.value, direction),
    );
  };

  const runRowAction = async () => {
    if (!rowAction || !canRunRowAction || !selectedOption) return;
    const value = selectedOption.value;
    const result = await rowAction.run(value);
    if (typeof result === "string") setLabelOverrides((current) => ({ ...current, [value]: result }));
    else if (result?.close) dismiss();
  };

  useDialogKeyboard((event) => {
    if (searchable) {
      // The box owns every key that types or edits text; the list keeps the rest.
      const typing = event.targetEditable === true;
      const editsText = isTextKey(event) ? event.sequence !== " " && event.name !== "[" && event.name !== "]"
        : typing && ["backspace", "delete", "left", "right", "home", "end"].includes(event.name ?? "");
      const backsUp = !typing && filter !== "" && (event.name === "backspace" || event.name === "delete");
      if (editsText || backsUp) {
        // A click on a row or button took the focus; the first key typed brings it back.
        if (!typing) filterRef.current?.focus?.();
        return;
      }
      if (isSpaceKey(event)) event.preventDefault();
    }
    event.stopPropagation();
    const move = listCursorMove(event, pageSize);
    if (move) {
      if (isDesktopWeb && !searchable) releaseFocusOutsideList();
      setSelectedOptionId(visibleOptions[move(visibleOptions, selectedIndex)]?.value ?? selectedOptionId);
    } else if (isSpaceKey(event)) {
      void toggleOption(selectedOption).catch(() => {});
    } else if (event.name === "[" && ordered) {
      void moveOption("up").catch(() => {});
    } else if (event.name === "]" && ordered) {
      void moveOption("down").catch(() => {});
    } else if (rowAction && event.name === rowActionShortcut && !event.ctrl && !event.meta && !event.alt) {
      void runRowAction().catch(() => {});
    } else if (event.name === "enter" || event.name === "return" || event.name === "escape" || isDetailBackNavigationKey(event)) {
      dismiss();
    }
  }, searchable ? { scope: dialogId, allowEditable: true } : dialogId);

  return (
    <DialogFrame title={title} showTitleDivider={!isDesktopWeb}>
      <Box
        flexDirection="column"
        gap={1}
        style={isDesktopWeb ? { minWidth: "min(520px, calc(100vw - 96px))" } : undefined}
      >
        {searchable && (
          <TextField
            inputRef={filterRef}
            value={filter}
            placeholder="Filter"
            focused
            onChange={setFilter}
          />
        )}
        <ToggleList
          items={toggleItems}
          selectedIdx={selectedIndex}
          bgColor={isDesktopWeb ? "transparent" : colors.commandBg}
          height={listHeight}
          scrollable
          showSelectedDescription={false}
          showDescriptions={searchable}
          rowIdPrefix={idPrefix ? `${idPrefix}:option` : undefined}
          rowGap={isDesktopWeb ? 0 : undefined}
          rowHeight={isDesktopWeb ? DESKTOP_ROW_HEIGHT : undefined}
          surface={isDesktopWeb ? "plain" : undefined}
          onSelect={(index) => setSelectedOptionId(visibleOptions[index]?.value ?? selectedOptionId)}
          onToggle={(id) => {
            setSelectedOptionId(id);
            void toggleOption(optionByValue.get(id)).catch(() => {});
          }}
        />
        <Box
          flexDirection="row"
          gap={1}
          justifyContent={isDesktopWeb ? "flex-end" : undefined}
          style={isDesktopWeb ? { paddingTop: 6, flexWrap: "wrap" } : undefined}
        >
          {ordered && (
            <>
              <Button label="Move Up" shortcut="[" variant="ghost" disabled={!canMoveUp} onPress={() => { void moveOption("up").catch(() => {}); }} />
              <Button label="Move Down" shortcut="]" variant="ghost" disabled={!canMoveDown} onPress={() => { void moveOption("down").catch(() => {}); }} />
            </>
          )}
          {rowAction && (
            <Button
              label={rowActionLabel ?? rowAction.label}
              shortcut={rowActionShortcut ?? rowAction.shortcut}
              variant="ghost"
              disabled={!canRunRowAction}
              onPress={() => { void runRowAction().catch(() => {}); }}
            />
          )}
          <Button label="Done" shortcut="Enter" variant="primary" onPress={dismiss} />
        </Box>
      </Box>
    </DialogFrame>
  );
}

function MultiSelectDialogButtonInner({
  label,
  title,
  options,
  selectedValues,
  onChange,
  disabled = false,
  emptyLabel = "None",
  ordered = false,
  idPrefix,
  renderTrigger,
  shortcutKey,
  shortcutActive = false,
  onOpenChange,
  rowAction,
  searchable = false,
}: MultiSelectDialogButtonProps, ref: ForwardedRef<MultiSelectDialogButtonHandle>) {
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const dialog = useDialog();
  const triggerMouseDownRef = useRef(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverAnchorPoint, setPopoverAnchorPoint] = useState<MultiSelectPopoverAnchorPoint | null>(null);
  const summary = summarizeMultiSelectValues({ options, selectedValues, emptyLabel });
  const buttonLabel = `${label}: ${summary}`;
  const buttonText = ` ${buttonLabel} `;
  const openDialog = useCallback((event?: DialogTriggerEvent, anchorPoint?: MultiSelectPopoverAnchorPoint) => {
    stopMouseEvent(event);
    if (disabled) return;
    if (isDesktopWeb && !ordered && !rowAction && !searchable) {
      setPopoverAnchorPoint(anchorPoint ?? null);
      setPopoverOpen(true);
      onOpenChange?.(true);
      return;
    }
    onOpenChange?.(true);
    void dialog.alert({
      closeOnClickOutside: true,
      content: (ctx: AlertContext) => (
        <MultiSelectDialogContent
          {...ctx}
          title={title ?? label}
          options={options}
          selectedValues={selectedValues}
          onChange={onChange}
          ordered={ordered}
          emptyLabel={emptyLabel}
          idPrefix={idPrefix}
          rowAction={rowAction}
          searchable={searchable}
        />
      ),
    }).catch(() => {}).finally(() => onOpenChange?.(false));
  }, [dialog, disabled, emptyLabel, idPrefix, isDesktopWeb, label, onChange, onOpenChange, options, ordered, rowAction, searchable, selectedValues, title]);

  const closePopover = useCallback(() => {
    setPopoverOpen(false);
    setPopoverAnchorPoint(null);
    onOpenChange?.(false);
  }, [onOpenChange]);
  useImperativeHandle(ref, () => ({
    open: (anchorPoint) => openDialog(undefined, anchorPoint),
    close: closePopover,
  }), [closePopover, openDialog]);

  useEffect(() => {
    if (!disabled) return;
    setPopoverOpen(false);
    onOpenChange?.(false);
  }, [disabled, onOpenChange]);

  useShortcut((event) => {
    if (!shortcutActive || disabled || !matchesShortcut(event, shortcutKey)) return;
    openDialog(event);
  });

  let trigger: ReactNode;
  if (renderTrigger) {
    trigger = renderTrigger({
      buttonLabel,
      buttonText,
      summary,
      disabled,
      openDialog,
      stopMouseEvent,
    });
  } else if (isDesktopWeb) {
    trigger = (
      <Box
        id={idPrefix ? `${idPrefix}:button` : undefined}
        height={1}
        flexDirection="row"
        onMouseDown={stopMouseEvent}
        onMouseUp={stopMouseEvent}
      >
        <Button
          label={buttonLabel}
          variant="secondary"
          disabled={disabled}
          onPress={() => openDialog()}
        />
      </Box>
    );
  } else {
    const startTriggerPress = (event?: DialogTriggerEvent) => {
      triggerMouseDownRef.current = true;
      stopMouseEvent(event);
    };
    const finishTriggerPress = (event?: DialogTriggerEvent) => {
      const startedOnTrigger = triggerMouseDownRef.current;
      triggerMouseDownRef.current = false;
      if (startedOnTrigger) openDialog(event);
      else stopMouseEvent(event);
    };
    trigger = (
      <Box
        id={idPrefix ? `${idPrefix}:button` : undefined}
        height={1}
        width={buttonText.length}
        flexDirection="row"
        backgroundColor={disabled ? colors.panel : colors.selected}
        onMouseDown={startTriggerPress}
        onMouseUp={finishTriggerPress}
      >
        <Text
          fg={disabled ? colors.textMuted : colors.selectedText}
          attributes={TextAttributes.BOLD}
          onMouseDown={startTriggerPress}
          onMouseUp={finishTriggerPress}
        >
          {buttonText}
        </Text>
      </Box>
    );
  }

  if (isDesktopWeb && !ordered && !rowAction && !searchable) {
    return (
      <Popover
        open={popoverOpen}
        onOpenChange={(open) => {
          setPopoverOpen(open);
          if (!open) setPopoverAnchorPoint(null);
          onOpenChange?.(open);
        }}
        trigger={trigger}
        anchorPoint={popoverAnchorPoint}
        placement="bottom-start"
        minWidth={240}
        label={title ?? label}
        density="menu"
      >
        <DesktopMultiSelectMenu
          title={title ?? label}
          options={options}
          selectedValues={selectedValues}
          onChange={onChange}
          emptyLabel={emptyLabel}
        />
      </Popover>
    );
  }

  return trigger;
}

export const MultiSelectDialogButton = forwardRef(MultiSelectDialogButtonInner);
MultiSelectDialogButton.displayName = "MultiSelectDialogButton";

export type { MultiSelectOption };

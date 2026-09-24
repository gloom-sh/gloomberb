import { Box, Text, useUiHost } from "../../../ui";
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
import { listCursorMove } from "../list-view";
import { Checkbox } from "../checkbox";
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
  /** Whether the highlighted option offers it; `selected` is its checkbox. */
  appliesTo(value: string, selected: boolean): boolean;
  /** A returned label replaces the row's label while the dialog stays open. */
  run(value: string): Promise<string | void> | string | void;
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
}: MultiSelectDialogContentProps) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const optionByValue = useMemo(() => new Map(options.map((option) => [option.value, option])), [options]);
  const [selectedValues, setSelectedValues] = useState(() => normalizeDialogSelectedValues(options, selectedValuesProp, ordered));
  const [displayValues, setDisplayValues] = useState(() => getMultiSelectDisplayValues(options, selectedValuesProp, ordered));
  const knownSelectedValues = selectedValues.filter((value) => optionByValue.has(value));
  const displayOptions = useMemo(
    () => orderMultiSelectOptionsForDisplay(options, displayValues),
    [displayValues, options],
  );
  const [selectedOptionId, setSelectedOptionId] = useState(options[0]?.value ?? "");
  const selectedIndex = Math.max(0, displayOptions.findIndex((option) => option.value === selectedOptionId));
  const selectedOption = displayOptions[selectedIndex];
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

  useEffect(() => {
    setSelectedValues((values) => normalizeDialogSelectedValues(options, values, ordered));
    setDisplayValues((values) => mergeMultiSelectDisplayValues(options, values));
  }, [options, ordered]);

  useEffect(() => {
    if (displayOptions.some((option) => option.value === selectedOptionId)) return;
    setSelectedOptionId(displayOptions[0]?.value ?? "");
  }, [displayOptions, selectedOptionId]);

  const toggleItems = displayOptions.map((option) => {
    const order = knownSelectedValues.indexOf(option.value);
    const orderDescription = ordered && order >= 0
      ? `Order ${order + 1} of ${knownSelectedValues.length}.`
      : null;

    return {
      id: option.value,
      label: labelOverrides[option.value] ?? option.label,
      disabled: option.disabled,
      enabled: selectedValues.includes(option.value),
      description: [option.description, orderDescription].filter((entry): entry is string => !!entry).join(" "),
    };
  });
  const viewport = useViewport();
  // A short terminal would clip rows under the dialog's edge: the list scrolls
  // in whatever height is left.
  const listHeight = isDesktopWeb
    ? Math.min(12, Math.max(5, displayOptions.length * DESKTOP_ROW_HEIGHT))
    : Math.max(3, Math.min(12, Math.max(6, toggleItems.length), viewport.height - TERMINAL_DIALOG_CHROME_ROWS));
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
    await applySelectedValues(ordered
      ? toggleOrderedMultiSelectValue(options, selectedValues, option.value)
      : toggleMultiSelectValue(options, selectedValues, option.value));
  };

  const moveOption = async (direction: "up" | "down") => {
    if (!ordered || !selectedOption) return;
    await applySelectedValues(
      moveMultiSelectValue(options, selectedValues, selectedOption.value, direction),
      moveMultiSelectDisplayValue(displayValues, knownSelectedValues, selectedOption.value, direction),
    );
  };

  const runRowAction = async () => {
    if (!rowAction || !canRunRowAction || !selectedOption) return;
    const value = selectedOption.value;
    const label = await rowAction.run(value);
    if (typeof label === "string") setLabelOverrides((current) => ({ ...current, [value]: label }));
  };

  useDialogKeyboard((event) => {
    event.stopPropagation();
    const move = listCursorMove(event, pageSize);
    if (move) {
      if (isDesktopWeb) releaseFocusOutsideList();
      setSelectedOptionId(displayOptions[move(displayOptions, selectedIndex)]?.value ?? selectedOptionId);
    } else if (isSpaceKey(event)) {
      void toggleOption(selectedOption).catch(() => {});
    } else if (event.name === "[" && ordered) {
      void moveOption("up").catch(() => {});
    } else if (event.name === "]" && ordered) {
      void moveOption("down").catch(() => {});
    } else if (rowAction && event.name === rowAction.shortcut && !event.ctrl && !event.meta && !event.alt) {
      void runRowAction().catch(() => {});
    } else if (event.name === "enter" || event.name === "return" || event.name === "escape" || isDetailBackNavigationKey(event)) {
      dismiss();
    }
  }, dialogId);

  return (
    <DialogFrame title={title} showTitleDivider={!isDesktopWeb}>
      <Box
        flexDirection="column"
        gap={1}
        style={isDesktopWeb ? { minWidth: 520 } : undefined}
      >
        <ToggleList
          items={toggleItems}
          selectedIdx={selectedIndex}
          bgColor={isDesktopWeb ? "transparent" : colors.commandBg}
          height={listHeight}
          scrollable
          showSelectedDescription={false}
          rowIdPrefix={idPrefix ? `${idPrefix}:option` : undefined}
          rowGap={isDesktopWeb ? 0 : undefined}
          rowHeight={isDesktopWeb ? DESKTOP_ROW_HEIGHT : undefined}
          surface={isDesktopWeb ? "plain" : undefined}
          onSelect={(index) => setSelectedOptionId(displayOptions[index]?.value ?? selectedOptionId)}
          onToggle={(id) => {
            setSelectedOptionId(id);
            void toggleOption(optionByValue.get(id)).catch(() => {});
          }}
        />
        <Box
          flexDirection="row"
          gap={1}
          justifyContent={isDesktopWeb ? "flex-end" : undefined}
          style={isDesktopWeb ? { paddingTop: 6 } : undefined}
        >
          {ordered && (
            <>
              <Button label="Move Up" shortcut="[" variant="ghost" disabled={!canMoveUp} onPress={() => { void moveOption("up").catch(() => {}); }} />
              <Button label="Move Down" shortcut="]" variant="ghost" disabled={!canMoveDown} onPress={() => { void moveOption("down").catch(() => {}); }} />
            </>
          )}
          {rowAction && (
            <Button
              label={rowAction.label}
              shortcut={rowAction.shortcut}
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
}: MultiSelectDialogButtonProps, ref: ForwardedRef<MultiSelectDialogButtonHandle>) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
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
    if (isDesktopWeb && !ordered && !rowAction) {
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
        />
      ),
    }).catch(() => {}).finally(() => onOpenChange?.(false));
  }, [dialog, disabled, emptyLabel, idPrefix, isDesktopWeb, label, onChange, onOpenChange, options, ordered, rowAction, selectedValues, title]);

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

  if (isDesktopWeb && !ordered && !rowAction) {
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

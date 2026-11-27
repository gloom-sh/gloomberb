/** @jsxImportSource react */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import { editableTextContextMenuItems } from "../../../ui/context-menu";
import { useRendererHost, useUiCapabilities, type InputRenderable, type TextareaRenderable } from "../../../ui/host";
import { toKeyEventLike } from "../input-host";
import { isImeComposing } from "../key-event";
import { cellHeight, cellWidth, cleanDomProps, commonStyle } from "./style";
import { joinPastedLines } from "../../../utils/pasted-lines";

function textInputStyle(props: Record<string, unknown>, multiline: boolean): CSSProperties {
  const focused = props.focused === true;
  const textColor = focused && typeof props.focusedTextColor === "string"
    ? props.focusedTextColor
    : props.textColor;
  const backgroundColor = focused && typeof props.focusedBackgroundColor === "string"
    ? props.focusedBackgroundColor
    : props.backgroundColor;
  const base = commonStyle(props);
  const overrides = props.style as CSSProperties | undefined;

  return {
    ...base,
    // Flush unless the caller insets the text. Longhands, never the `padding`
    // shorthand: React writes style keys in order, and a shorthand here landed
    // after a caller's `paddingLeft` and wiped it, so every bordered field's
    // text sat on its border.
    ...(overrides?.padding === undefined ? {
      paddingTop: base.paddingTop ?? 0,
      paddingRight: base.paddingRight ?? 0,
      paddingBottom: base.paddingBottom ?? 0,
      paddingLeft: base.paddingLeft ?? 0,
    } : {}),
    display: "block",
    resize: "none",
    border: "none",
    outline: "none",
    color: typeof textColor === "string" ? textColor : "var(--gloom-text)",
    backgroundColor: typeof backgroundColor === "string" ? backgroundColor : "transparent",
    whiteSpace: multiline && props.wrapText ? "pre-wrap" : "pre",
    overflow: multiline ? "auto" : "hidden",
    width: cellWidth(props.width) ?? "100%",
    height: cellHeight(props.height) ?? (multiline ? "100%" : "var(--cell-h)"),
    margin: 0,
    caretColor: typeof props.cursorColor === "string" ? props.cursorColor : "auto",
    // The placeholder is drawn by styles.css from this variable: the role by
    // default, the same role lifted for a field on a surface of its own.
    ...(typeof props.placeholderColor === "string" ? { "--gloom-placeholder": props.placeholderColor } : {}),
    ...overrides,
  } as CSSProperties;
}

function getStringProp(props: Record<string, unknown>, key: string): string | undefined {
  const value = props[key];
  return typeof value === "string" ? value : undefined;
}

function callTextHandler(handler: unknown, value: string): void {
  if (typeof handler === "function") {
    (handler as (value: string) => void)(value);
  }
}

/**
 * A press on a field must focus it, even when the owner's controlled flag never
 * changed. Panes and charts consume their own mousedown, which suppresses the
 * default focus move, and a field that lost focus externally would otherwise
 * stay dead until its flag happened to toggle.
 */
function focusOnPress(element: HTMLInputElement | HTMLTextAreaElement | null): void {
  if (!element || document.activeElement === element) return;
  element.focus();
}

function applyDomCursorOffset(
  element: HTMLInputElement | HTMLTextAreaElement | null,
  offset: number,
) {
  // Placing a caret in a field nobody is typing in means nothing, and WebKit
  // hands the field the focus back when you try, which silently undoes a
  // release that happened a frame earlier.
  if (!element || document.activeElement !== element) return;
  const clampedOffset = Math.max(0, Math.min(offset, element.value.length));
  element.setSelectionRange(clampedOffset, clampedOffset);
}

function useEditableValue(props: Record<string, unknown>) {
  const controlledValue = getStringProp(props, "value");
  const [internalValue, setInternalValue] = useState(getStringProp(props, "initialValue") ?? "");
  const value = controlledValue ?? internalValue;
  const valueRef = useRef(value);
  valueRef.current = value;

  const controlled = controlledValue != null;
  const setValue = useCallback((nextValue: string) => {
    valueRef.current = nextValue;
    if (!controlled) setInternalValue(nextValue);
  }, [controlled]);

  return { value, valueRef, setValue };
}

function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

type WebVisualCursor = TextareaRenderable["visualCursor"];

/**
 * How many characters a line of the field holds before it wraps: its text
 * box over the advance of one character of its own font, as the browser lays
 * them out. A character is narrower than a terminal cell.
 */
function textareaColumnCount(props: Record<string, unknown>, element: HTMLTextAreaElement | null): number {
  if (typeof props.width === "number") return Math.max(1, Math.floor(props.width));
  if (!element) return 1;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const inset = (parseFloat(style?.paddingLeft ?? "") || 0) + (parseFloat(style?.paddingRight ?? "") || 0);
  return Math.max(1, Math.floor((element.clientWidth - inset) / characterAdvance(element, style)));
}

const ADVANCES = new Map<string, number>();
/** One character's advance in the element's font, measured once per font. */
function characterAdvance(element: HTMLElement, style: CSSStyleDeclaration | undefined): number {
  const font = style?.font ?? "";
  const known = ADVANCES.get(font);
  if (known) return known;
  const context = element.ownerDocument.createElement("canvas").getContext?.("2d");
  let advance = 0;
  if (context && font) {
    context.font = font;
    advance = context.measureText("0000000000").width / 10;
  }
  // No canvas (a test DOM): a monospace character is about 0.6 of its font size.
  if (!(advance > 0)) advance = (parseFloat(style?.fontSize ?? "") || 12) * 0.6;
  ADVANCES.set(font, advance);
  return advance;
}

function wrappedLineCount(line: string, columns: number, wrap: boolean): number {
  if (!wrap) return 1;
  return Math.max(1, Math.ceil(line.length / columns));
}

function textareaMetrics(
  text: string,
  offset: number,
  columns: number,
  wrap: boolean,
): { virtualLineCount: number; visualCursor: WebVisualCursor } {
  const lines = text.split("\n");
  const clampedOffset = Math.max(0, Math.min(offset, text.length));
  let consumed = 0;
  let virtualLineCount = 0;
  let visualCursor: WebVisualCursor = {
    visualRow: 0,
    visualCol: 0,
    logicalRow: 0,
    logicalCol: 0,
    offset: clampedOffset,
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineStart = consumed;
    const lineEnd = lineStart + line.length;
    const lineVirtualRows = wrappedLineCount(line, columns, wrap);
    const cursorIsOnLine = clampedOffset <= lineEnd || index === lines.length - 1;

    if (cursorIsOnLine) {
      const logicalCol = Math.max(0, Math.min(clampedOffset - lineStart, line.length));
      const visualRowInLine = wrap
        ? Math.min(Math.floor(logicalCol / columns), lineVirtualRows - 1)
        : 0;
      visualCursor = {
        visualRow: virtualLineCount + visualRowInLine,
        visualCol: wrap ? logicalCol % columns : logicalCol,
        logicalRow: index,
        logicalCol,
        offset: clampedOffset,
      };
    }

    virtualLineCount += lineVirtualRows;
    consumed = lineEnd + 1;
    if (cursorIsOnLine) {
      for (let remaining = index + 1; remaining < lines.length; remaining += 1) {
        virtualLineCount += wrappedLineCount(lines[remaining] ?? "", columns, wrap);
      }
      break;
    }
  }

  return {
    virtualLineCount: Math.max(1, virtualLineCount),
    visualCursor,
  };
}

/**
 * Everything the single-line and multi-line fields share: the value, the
 * caret, focus that follows the `focused` flag both ways, DOM polling while
 * focused, submit and the context menu. Returns the element's props and the
 * base imperative handle; the textarea adds its line metrics on top.
 */
function useWebEditable<T extends HTMLInputElement | HTMLTextAreaElement>(
  props: Record<string, unknown>,
  multiline: boolean,
) {
  const renderer = useRendererHost();
  const { nativeContextMenu } = useUiCapabilities();
  const elementRef = useRef<T | null>(null);
  const propsRef = useLatestRef(props);
  const { value, valueRef, setValue } = useEditableValue(props);
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const [domFocused, setDomFocused] = useState(false);
  // While an input method composes (pinyin, kana, hangul), the field holds
  // text the person has not chosen yet. Handing it to the owner re-renders the
  // field mid-composition, which commits each fragment as typed text, so the
  // field shows its own text until the composition ends.
  const composingRef = useRef(false);
  const [composingValue, setComposingValue] = useState<string | null>(null);
  const applyCursorOffset = (offset: number) => {
    setCursorOffset(offset);
    queueMicrotask(() => applyDomCursorOffset(elementRef.current, offset));
    globalThis.requestAnimationFrame?.(() => applyDomCursorOffset(elementRef.current, offset));
  };

  useEffect(() => {
    if (props.focused === true) {
      elementRef.current?.focus();
    } else if (props.focused === false && document.activeElement === elementRef.current) {
      elementRef.current?.blur();
    }
  }, [props.focused]);

  const handleValueChange = useCallback((nextValue: string) => {
    setValue(nextValue);
    setCursorOffset(elementRef.current?.selectionStart ?? nextValue.length);
    callTextHandler(propsRef.current.onInput, nextValue);
    callTextHandler(propsRef.current.onChange, nextValue);
    callTextHandler(propsRef.current.onCursorChange, nextValue);
  }, [propsRef, setValue]);
  const syncElementValue = useCallback(() => {
    if (composingRef.current) return valueRef.current;
    const nextValue = elementRef.current?.value ?? valueRef.current;
    if (nextValue !== valueRef.current) handleValueChange(nextValue);
    return nextValue;
  }, [handleValueChange, valueRef]);

  const finishComposition = useCallback(() => {
    if (!composingRef.current) return false;
    composingRef.current = false;
    setComposingValue(null);
    return true;
  }, []);

  const discardComposition = useCallback(() => {
    if (finishComposition() && elementRef.current) elementRef.current.value = valueRef.current;
  }, [finishComposition, valueRef]);

  useLayoutEffect(() => {
    discardComposition();
  }, [discardComposition, value]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const start = () => {
      composingRef.current = true;
      setComposingValue(element.value);
    };
    const end = () => {
      if (finishComposition()) syncElementValue();
    };
    element.addEventListener("compositionstart", start);
    element.addEventListener("compositionend", end);
    return () => {
      element.removeEventListener("compositionstart", start);
      element.removeEventListener("compositionend", end);
    };
  }, [finishComposition, syncElementValue]);

  const active = props.focused === true || domFocused;
  useEffect(() => {
    if (!active) return;
    let animationFrame: number | null = null;
    const syncDomValue = () => {
      const element = elementRef.current;
      if (element && element.ownerDocument.activeElement !== element) discardComposition();
      syncElementValue();
      animationFrame = globalThis.requestAnimationFrame?.(syncDomValue) ?? null;
    };
    animationFrame = globalThis.requestAnimationFrame?.(syncDomValue) ?? null;
    return () => {
      if (animationFrame !== null) globalThis.cancelAnimationFrame?.(animationFrame);
    };
  }, [active, discardComposition, syncElementValue]);

  const handleDomInput = (event: FormEvent<T>) => {
    if (composingRef.current) {
      const native = event.nativeEvent as InputEvent;
      if (native.type !== "input" || native.isComposing !== false || native.inputType === "insertCompositionText") {
        setComposingValue(event.currentTarget.value);
        return;
      }
      finishComposition();
    }
    syncElementValue();
  };

  const handleKeyDown = (event: KeyboardEvent<T>) => {
    if (isImeComposing(event.nativeEvent) || composingRef.current) return;
    const keyEvent = toKeyEventLike(event.nativeEvent);
    if (typeof propsRef.current.onKeyDown === "function") propsRef.current.onKeyDown(keyEvent);
    if (keyEvent.defaultPrevented) return;
    if (!multiline && (event.key === "Escape" || event.key === "Esc") && typeof propsRef.current.onEscape === "function") {
      event.preventDefault();
      event.stopPropagation();
      (propsRef.current.onEscape as () => void)();
      return;
    }
    // Shift+Enter types a new line in a textarea.
    if (event.key === "Enter" && !(multiline && event.shiftKey) && typeof propsRef.current.onSubmit === "function") {
      event.preventDefault();
      (propsRef.current.onSubmit as (value: string) => void)(syncElementValue());
    }
  };

  const handle: InputRenderable = {
    editBuffer: {
      getText: () => composingRef.current ? valueRef.current : elementRef.current?.value ?? valueRef.current,
      setText: (nextText: string) => setValue(nextText),
    },
    cursorOffset,
    setCursorOffset: applyCursorOffset,
    focus: () => elementRef.current?.focus(),
    blur: () => elementRef.current?.blur(),
    get focused() {
      const element = elementRef.current;
      return element != null && element.ownerDocument.activeElement === element;
    },
  };

  const elementProps = {
    ...cleanDomProps(props),
    ref: elementRef,
    value: composingValue ?? value,
    autoCorrect: "off",
    autoCapitalize: "off",
    autoComplete: getStringProp(props, "autoComplete") ?? "off",
    spellCheck: false,
    placeholder: getStringProp(props, "placeholder"),
    onInput: handleDomInput,
    onChange: handleDomInput,
    onMouseDown: () => focusOnPress(elementRef.current),
    onFocus: () => {
      setDomFocused(true);
      callTextHandler(propsRef.current.onFocus, elementRef.current?.value ?? valueRef.current);
    },
    onBlur: () => {
      setDomFocused(false);
      discardComposition();
      callTextHandler(propsRef.current.onBlur, syncElementValue());
    },
    onKeyDown: handleKeyDown,
    // A browser's one-line field already joins a paste's lines as words; a field that reads a list keeps each an entry.
    ...!multiline && props.joinPastedLines === "list" ? {
      onPaste: (event: ClipboardEvent<T>) => {
        const element = elementRef.current;
        const text = event.clipboardData?.getData("text/plain");
        if (!element || composingRef.current || !text || !/[\t\r\n]/.test(text)) return;
        event.preventDefault();
        element.setRangeText(joinPastedLines(text, "list"), element.selectionStart ?? element.value.length, element.selectionEnd ?? element.value.length, "end");
        handleValueChange(element.value);
      },
    } : {},
    onContextMenu: (event: MouseEvent<T>) => {
      if (!nativeContextMenu || !renderer.showContextMenu) return;
      elementRef.current?.focus();
      event.preventDefault();
      event.stopPropagation();
      void renderer.showContextMenu(editableTextContextMenuItems());
    },
    onSelect: () => {
      if (composingRef.current) return;
      setCursorOffset(elementRef.current?.selectionStart ?? valueRef.current.length);
      callTextHandler(propsRef.current.onCursorChange, valueRef.current);
    },
    style: textInputStyle(props, multiline),
  };

  return { elementRef, valueRef, setValue, cursorOffset, handle, elementProps };
}

export const WebInput = forwardRef<InputRenderable, Record<string, unknown>>(function WebInput(props, ref) {
  const field = useWebEditable<HTMLInputElement>(props, false);
  useImperativeHandle(ref, () => field.handle);
  return <input {...field.elementProps} />;
});

export const WebTextarea = forwardRef<TextareaRenderable, Record<string, unknown>>(function WebTextarea(props, ref) {
  const field = useWebEditable<HTMLTextAreaElement>(props, true);
  const { elementRef, valueRef, cursorOffset } = field;

  useImperativeHandle(ref, () => {
    const metrics = () => textareaMetrics(
      valueRef.current,
      elementRef.current?.selectionStart ?? cursorOffset,
      textareaColumnCount(props, elementRef.current),
      props.wrapText === true || props.wrapMode === "word" || props.wrapMode === "char",
    );
    return {
      ...field.handle,
      get virtualLineCount() {
        return metrics().virtualLineCount;
      },
      get visualCursor() {
        return metrics().visualCursor;
      },
      setText: field.setValue,
      hasSelection: () => {
        const element = elementRef.current;
        return !!element && element.selectionStart !== element.selectionEnd;
      },
      syntaxStyle: null,
      addHighlight: () => {},
      clearLineHighlights: () => {},
    };
  });

  return <textarea {...field.elementProps} />;
});

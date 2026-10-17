import { useCallback, useEffect, useState, type RefObject } from "react";
import { Box, Input, Text, useUiCapabilities, type InputRenderable } from "../ui";
import { colors } from "../theme/colors";
import { Icon } from "./ui/icon";
import { useAppInputCapture } from "../state/app/input-capture";
import { useShortcut } from "../react/input";
import { isPlainArrowDown, stopSearchFocusNavigation } from "../utils/search-focus-navigation";

export function InputSearchBar({
  value,
  focused,
  active,
  width,
  focusToken,
  inputRef,
  placeholder,
  debounceMs,
  glyph = "/",
  appearance = "strip",
  normalizeValue = identity,
  onNavigateDown,
  onFocus,
  onBlur,
  onQueryChange,
  onSubmit,
  onStep,
}: {
  value: string;
  focused: boolean;
  active: boolean;
  width: number | "100%";
  focusToken: number;
  inputRef: RefObject<InputRenderable | null>;
  placeholder: string;
  debounceMs: number;
  /** Leading marker; override when a pane shows more than one field. */
  glyph?: string;
  /** `plain` drops the strip background and glyph for a host that draws its own field (QueryBar). */
  appearance?: "strip" | "plain";
  normalizeValue?: (value: string) => string;
  onNavigateDown?: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onQueryChange: (query: string) => void;
  /** Enter: called after the value is committed through `onQueryChange`. */
  onSubmit?: (query: string) => void;
  /**
   * Enter and Shift+Enter step forward and back through what the query found,
   * as a find in a document does; the field keeps the keyboard. Replaces
   * `onSubmit`.
   */
  onStep?: (direction: 1 | -1) => void;
}) {
  const [draft, setDraft] = useState(value);
  const { nativePaneChrome } = useUiCapabilities();
  // Desktop and web: a field standing on its own (a plugin's table search) reads as the
  // query bar's search segment: the band, the pane's inset, the hairline under it.
  const band = nativePaneChrome === true && appearance === "strip";
  useAppInputCapture(focused && active);

  useShortcut((event) => {
    if (!onNavigateDown || !isPlainArrowDown(event)) return;
    stopSearchFocusNavigation(event);
    onNavigateDown();
  }, {
    allowEditable: true,
    enabled: focused && active && !!onNavigateDown,
    phase: "before",
  });

  // A focused input consumes every key, so Escape has to be intercepted before
  // it reaches the field. Without this there is no way back out of a search.
  useShortcut((event) => {
    if (event.name !== "escape") return;
    stopSearchFocusNavigation(event);
    setDraft("");
    onQueryChange("");
    onBlur();
  }, {
    allowEditable: true,
    enabled: focused && active,
    phase: "before",
  });

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (focused && active) inputRef.current?.focus?.();
  }, [active, focused, focusToken, inputRef]);

  useEffect(() => {
    if (normalizeValue(draft) === normalizeValue(value)) return;
    const timer = setTimeout(() => {
      onQueryChange(draft);
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [debounceMs, draft, normalizeValue, onQueryChange, value]);

  const commitNow = useCallback((nextValue: string) => {
    onQueryChange(nextValue);
    onSubmit?.(nextValue);
    onBlur();
  }, [onBlur, onQueryChange, onSubmit]);

  const step = useCallback((event: { name?: string; shift?: boolean; preventDefault?: () => void; stopPropagation?: () => void }) => {
    if (!onStep || event.name !== "return") return;
    event.preventDefault?.();
    event.stopPropagation?.();
    if (normalizeValue(draft) !== normalizeValue(value)) onQueryChange(draft);
    onStep(event.shift ? -1 : 1);
  }, [draft, normalizeValue, onQueryChange, onStep, value]);

  return (
    <Box
      height={1}
      width={width}
      flexDirection="row"
      backgroundColor={appearance === "plain" || band ? undefined : colors.panel}
      data-gloom-role={band ? "search-strip" : undefined}
      data-active={band && active ? "true" : undefined}
      style={band ? SEARCH_STRIP_STYLE : undefined}
      onMouseDown={(event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        onFocus();
        inputRef.current?.focus?.();
      }}
    >
      {/* The band's search is the query bar's: the search icon, the accent while typing; a labelled strip keeps its label. */}
      {band && glyph === "/"
        ? <Box alignItems="center" style={SEARCH_ICON_STYLE}><Icon name="search" size={11} color={active ? colors.borderFocused : colors.textMuted} /></Box>
        : appearance === "strip" && <Text fg={band ? colors.textMuted : active ? colors.textBright : colors.textDim}>{glyph}</Text>}
      {appearance === "strip" && !(band && glyph === "/") && <Box width={1} />}
      <Input
        ref={inputRef}
        value={draft}
        focused={focused && active}
        placeholder={placeholder}
        placeholderColor={colors.textDim}
        textColor={colors.text}
        focusedTextColor={colors.text}
        backgroundColor={appearance === "plain" || band ? "transparent" : colors.panel}
        focusedBackgroundColor={appearance === "plain" || band ? "transparent" : colors.panel}
        cursorColor={colors.textBright}
        flexGrow={1}
        onFocus={onFocus}
        onBlur={onBlur}
        onInput={setDraft}
        onChange={setDraft}
        onSubmit={commitNow}
        {...(onStep ? { onKeyDown: step } : {})}
      />
    </Box>
  );
}

const SEARCH_ICON_STYLE = { marginRight: "var(--gloom-space-xs)" } as const;

const SEARCH_STRIP_STYLE = {
  paddingInline: "var(--gloom-inset)",
  background: "var(--gloom-band)",
  boxShadow: "inset 0 -1px 0 var(--gloom-hairline)",
  boxSizing: "border-box",
  cursor: "text",
} as const;

function identity(value: string): string {
  return value;
}

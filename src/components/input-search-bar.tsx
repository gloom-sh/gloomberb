import { useCallback, useEffect, useState, type RefObject } from "react";
import { Box, Input, Text, type InputRenderable } from "../ui";
import { colors } from "../theme/colors";
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
  normalizeValue = identity,
  onNavigateDown,
  onFocus,
  onBlur,
  onQueryChange,
}: {
  value: string;
  focused: boolean;
  active: boolean;
  width: number;
  focusToken: number;
  inputRef: RefObject<InputRenderable | null>;
  placeholder: string;
  debounceMs: number;
  normalizeValue?: (value: string) => string;
  onNavigateDown?: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onQueryChange: (query: string) => void;
}) {
  const [draft, setDraft] = useState(value);
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
    onBlur();
  }, [onBlur, onQueryChange]);

  return (
    <Box
      height={1}
      width={width}
      flexDirection="row"
      backgroundColor={colors.panel}
      onMouseDown={(event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        onFocus();
        inputRef.current?.focus?.();
      }}
    >
      <Text fg={active ? colors.textBright : colors.textDim}>/</Text>
      <Box width={1} />
      <Input
        ref={inputRef}
        value={draft}
        focused={focused && active}
        placeholder={placeholder}
        placeholderColor={colors.textDim}
        textColor={colors.text}
        focusedTextColor={colors.text}
        backgroundColor={colors.panel}
        focusedBackgroundColor={colors.panel}
        cursorColor={colors.textBright}
        flexGrow={1}
        onFocus={onFocus}
        onBlur={onBlur}
        onInput={setDraft}
        onChange={setDraft}
        onSubmit={commitNow}
      />
    </Box>
  );
}

function identity(value: string): string {
  return value;
}

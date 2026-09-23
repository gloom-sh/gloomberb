import { useMemo, type ReactNode, type RefObject } from "react";
import { Box, Input, Text, useUiCapabilities, type InputRenderable } from "../../ui";
import { colors } from "../../theme/colors";
import { Icon } from "./icon";

export interface InlineQuickAddRowProps {
  value: string;
  active: boolean;
  paneFocused: boolean;
  width: number;
  rowWidth?: number | "100%";
  placeholder: string;
  inputRef: RefObject<InputRenderable | null>;
  preview?: ReactNode;
  minInputWidth?: number;
  maxInputWidth?: number;
  onFocusRequest: () => void;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onFocus?: () => void;
  onBlur: () => void;
  onCancel?: () => void;
}

/** Shared one-row composer used by pane-native inline add flows. */
export function InlineQuickAddRow({
  value,
  active,
  paneFocused,
  width,
  rowWidth = "100%",
  placeholder,
  inputRef,
  preview,
  minInputWidth,
  maxInputWidth = 18,
  onFocusRequest,
  onChange,
  onSubmit,
  onFocus,
  onBlur,
  onCancel,
}: InlineQuickAddRowProps) {
  const inputWidth = useMemo(() => {
    const queryWidth = [...value.trim()].length;
    if (queryWidth > 0) {
      // A typed query hugs its preview unless the caller asked for a wider field.
      return Math.max(minInputWidth ?? 4, Math.min(maxInputWidth, queryWidth + 1));
    }
    return Math.max(minInputWidth ?? 6, Math.min(10, Math.floor(width * 0.18)));
  }, [maxInputWidth, minInputWidth, value, width]);
  const hasPreview = preview !== undefined && preview !== null;
  const previewWidth = Math.max(4, width - inputWidth - 5);
  const { nativePaneChrome } = useUiCapabilities();
  const handleMouseDown = (event: {
    preventDefault?: () => void;
    target?: { tagName?: string };
  }) => {
    if (event.target?.tagName?.toUpperCase() !== "INPUT") {
      event.preventDefault?.();
    }
    onFocusRequest();
  };
  const input = (
    <Input
      ref={inputRef}
      value={value}
      focused={active && paneFocused}
      placeholder={placeholder}
      placeholderColor={colors.textMuted}
      textColor={colors.text}
      backgroundColor={nativePaneChrome ? "transparent" : colors.panel}
      onInput={onChange}
      onChange={onChange}
      onSubmit={onSubmit}
      onFocus={onFocus}
      onBlur={onBlur}
      onEscape={onCancel}
    />
  );

  if (nativePaneChrome) {
    // A row across the pane is a band like the query bar: chrome height, the
    // field as its leading segment. A fixed-width control (a chart's series
    // picker) keeps its one-cell row.
    const band = rowWidth === "100%";
    return (
      <Box
        width={rowWidth}
        flexDirection="row"
        flexShrink={0}
        overflow="hidden"
        {...(band ? {} : { height: 1, gap: 1, paddingX: 1, backgroundColor: colors.panel })}
        onMouseDown={handleMouseDown}
        data-gloom-role="inline-quick-add"
        data-gloom-interactive="true"
        data-band={band ? "true" : undefined}
        data-active={active ? "true" : undefined}
      >
        <Box data-gloom-role="inline-quick-add-field" flexDirection="row" alignItems="center" flexShrink={0} gap={band ? undefined : 1}>
          <Icon name="plus" size={11} color={active ? colors.text : colors.textMuted} />
          <Box width={inputWidth} flexShrink={0}>{input}</Box>
        </Box>
        {hasPreview ? (
          <Box data-gloom-role="inline-quick-add-preview" minWidth={0} flexGrow={1} flexDirection="row" alignItems="center" overflow="hidden">
            {preview}
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box
      height={1}
      width={rowWidth}
      flexDirection="row"
      flexShrink={0}
      paddingX={1}
      overflow="hidden"
      backgroundColor={colors.panel}
      onMouseDown={handleMouseDown}
      data-gloom-role="inline-quick-add"
      data-gloom-interactive="true"
    >
      <Text fg={active ? colors.text : colors.textDim}>+</Text>
      <Box width={1} />
      <Box width={inputWidth} flexShrink={0}>
        {input}
      </Box>
      {hasPreview ? (
        <>
          <Box width={1} flexShrink={0} />
          <Box width={previewWidth} minWidth={0} flexGrow={1} overflow="hidden">
            {preview}
          </Box>
        </>
      ) : null}
    </Box>
  );
}

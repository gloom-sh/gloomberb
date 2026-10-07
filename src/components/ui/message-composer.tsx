import { Box, Text, Textarea, useUiHost } from "../../ui";
import { type ComponentType, type ReactNode, type RefObject } from "react";
import { type TextareaRenderable } from "../../ui";
import { colors } from "../../theme/colors";
import { useRemoteUiNode } from "../../remote/semantic-tree";
import { remoteStringValue } from "../../remote/semantic-helpers";

export interface MessageComposerProps {
  inputRef?: RefObject<TextareaRenderable | null>;
  initialValue?: string;
  focused?: boolean;
  placeholder?: string;
  width?: number | string;
  height?: number | string;
  terminalPrefix?: string;
  terminalDivider?: boolean;
  terminalBottomInset?: number;
  onFocusRequest?: () => void;
  onInput?: (value: string) => void;
  onCursorChange?: () => void;
  onSubmit?: () => void;
  keyBindings?: Array<Record<string, unknown>>;
  wrapText?: boolean;
  /**
   * Desktop and web: a control at the end of the field, such as an attach
   * button. The terminal draws only the field.
   */
  accessory?: ReactNode;
}

export interface MessageComposerBlockHeightOptions {
  height?: MessageComposerProps["height"];
  nativePaneChrome?: boolean;
  terminalDivider?: boolean;
  terminalBottomInset?: number;
}

export function getMessageComposerBlockHeight({
  height = 1,
  nativePaneChrome = false,
  terminalDivider = true,
  terminalBottomInset = 0,
}: MessageComposerBlockHeightOptions = {}) {
  const inputHeight = typeof height === "number" ? height : 1;
  if (nativePaneChrome) return inputHeight;
  return inputHeight + (terminalDivider ? 1 : 0) + Math.max(0, Math.floor(terminalBottomInset));
}

export function MessageComposer({
  inputRef,
  initialValue = "",
  focused = false,
  placeholder = "",
  width,
  height = 1,
  terminalPrefix = " > ",
  terminalDivider = true,
  terminalBottomInset = 0,
  onFocusRequest,
  onInput,
  onCursorChange,
  onSubmit,
  keyBindings,
  wrapText = false,
  accessory,
}: MessageComposerProps) {
  useRemoteUiNode({
    role: "message-composer",
    label: placeholder || "Message composer",
    actions: {
      setValue: (input) => {
        const value = remoteStringValue(input);
        onFocusRequest?.();
        onInput?.(value);
      },
      submit: () => {
        onFocusRequest?.();
        onSubmit?.();
      },
      focus: () => {
        onFocusRequest?.();
        inputRef?.current?.focus?.();
      },
    },
    metadata: { focused, placeholder, height },
  });
  const HostMessageComposer = useUiHost().MessageComposer as ComponentType<MessageComposerProps> | undefined;
  if (HostMessageComposer) {
    return (
      <HostMessageComposer
        inputRef={inputRef}
        initialValue={initialValue}
        focused={focused}
        placeholder={placeholder}
        width={width}
        height={height}
        terminalPrefix={terminalPrefix}
        terminalDivider={terminalDivider}
        terminalBottomInset={terminalBottomInset}
        onFocusRequest={onFocusRequest}
        onInput={onInput}
        onCursorChange={onCursorChange}
        onSubmit={onSubmit}
        keyBindings={keyBindings}
        wrapText={wrapText}
        accessory={accessory}
      />
    );
  }

  const prefixWidth = terminalPrefix.length;
  const textWidth = typeof width === "number" ? Math.max(width - prefixWidth, 1) : undefined;
  const bottomInsetHeight = Math.max(0, Math.floor(terminalBottomInset));
  const totalHeight = typeof height === "number"
    ? getMessageComposerBlockHeight({ height, terminalDivider, terminalBottomInset })
    : height;
  const requestFocus = () => {
    onFocusRequest?.();
    inputRef?.current?.focus?.();
  };
  const handleInput = (value: string) => {
    if (!focused) onFocusRequest?.();
    onInput?.(value);
  };

  return (
    <Box
      flexDirection="column"
      width={width}
      height={totalHeight}
    >
      {terminalDivider && (
        <Box height={1} width={width} overflow="hidden">
          <Text fg={colors.border}>{"-".repeat(typeof width === "number" ? width : 0)}</Text>
        </Box>
      )}
      <Box
        flexDirection="row"
        width={width}
        height={height}
        onMouseDown={requestFocus}
      >
        {terminalPrefix.length > 0 && (
          <Box width={prefixWidth} height={height}>
            <Text fg={colors.textDim}>{terminalPrefix}</Text>
          </Box>
        )}
        <Box width={textWidth ?? "100%"} height={height}>
          <Textarea
            ref={inputRef}
            initialValue={initialValue}
            width={textWidth ?? "100%"}
            height={height}
            focused={focused}
            placeholder={placeholder}
            placeholderColor={colors.textMuted}
            textColor={colors.text}
            backgroundColor={colors.bg}
            focusedBackgroundColor={colors.bg}
            cursorColor={colors.textBright}
            onInput={handleInput}
            onCursorChange={onCursorChange}
            keyBindings={keyBindings}
            onSubmit={onSubmit}
            wrapText={wrapText}
          />
        </Box>
      </Box>
      {bottomInsetHeight > 0 && <Box height={bottomInsetHeight} width={width} />}
    </Box>
  );
}

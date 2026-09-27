import { Box, Input, Span, Text, TextAttributes, useUiCapabilities, useUiHost } from "../../ui";
import { useEffect, useRef, useState, type ComponentType, type RefObject } from "react";
import { type InputRenderable } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { useRemoteUiNode } from "../../remote/semantic-tree";
import { remoteStringValue } from "../../remote/semantic-helpers";
import { truncateWithEllipsis } from "../../utils/text-wrap";

export interface FieldLabelProps {
  label: string;
  /** The form's current field. */
  active?: boolean;
  /** A label column this wide: the label is cut to fit and the column keeps its width. */
  width?: number;
  /** Cuts the label to fit without reserving a column. */
  maxWidth?: number;
}

/**
 * A form field's label. The active field's label is bright and bold. The
 * terminal also marks it with "> " (and indents the others to match) because
 * its input shows only a cursor; the desktop control draws a focus ring.
 */
export function FieldLabel({ label, active = false, width, maxWidth }: FieldLabelProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const text = nativePaneChrome ? label : `${active ? "> " : "  "}${label}`;
  const fit = width ?? maxWidth;
  return (
    <Text width={width} fg={active ? colors.textBright : colors.textDim} attributes={active ? TextAttributes.BOLD : 0}>
      {fit === undefined ? text : truncateWithEllipsis(text, fit)}
    </Text>
  );
}

export interface TextFieldProps {
  label?: string;
  /**
   * The form's current field, in a form that walks its fields with the
   * keyboard. The terminal marks the label (see FieldLabel); the desktop
   * field's focus ring already shows it.
   */
  active?: boolean;
  /**
   * Puts the label in a column this wide beside the input rather than above
   * it, as a FieldLabel. `width` is then the whole row.
   */
  labelWidth?: number;
  value?: string;
  placeholder?: string;
  focused?: boolean;
  width?: number;
  inputRef?: RefObject<InputRenderable | null>;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  onBlur?: (value: string) => void;
  hint?: string;
  type?: "text" | "password" | "date" | "email";
  /** DOM autofill hint, e.g. "email" or "current-password"; terminal hosts ignore it. */
  autoComplete?: string;
  variant?: "default" | "plain";
  /**
   * `comfortable` is the form-page size on the DOM renderer: a taller field
   * with a tight label gap, for dialogs a user fills in rather than dense pane
   * chrome. Terminal hosts have one cell height and ignore it.
   */
  size?: "default" | "comfortable";
  backgroundColor?: string;
  textColor?: string;
  placeholderColor?: string;
  onMouseDown?: () => void;
  onKeyDown?: (event: {
    name?: string;
    shift?: boolean;
    defaultPrevented?: boolean;
    preventDefault(): void;
    stopPropagation(): void;
  }) => void;
}

const PASSWORD_MASK_CHAR = "*";

function maskPassword(value: string): string {
  return PASSWORD_MASK_CHAR.repeat(value.length);
}

export function TextField(props: TextFieldProps) {
  return props.labelWidth === undefined ? <TextFieldControl {...props} /> : <InlineTextField {...props} />;
}

function InlineTextField({ label = "", labelWidth = 0, active, width, hint, onMouseDown, ...props }: TextFieldProps) {
  const colors = useThemeColors();
  const inputWidth = width === undefined ? undefined : Math.max(8, width - labelWidth - 1);
  return (
    <Box flexDirection="column" width={width}>
      <Box height={1} flexDirection="row" alignItems="center" gap={1} onMouseDown={onMouseDown}>
        <FieldLabel label={label} active={active} width={labelWidth} />
        <TextFieldControl {...props} width={inputWidth} onMouseDown={onMouseDown} />
      </Box>
      {hint ? (
        <Box paddingLeft={labelWidth + 1}>
          <Text fg={colors.textMuted} wrapText width={inputWidth}>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function TextFieldControl({
  label,
  active,
  value,
  placeholder,
  focused,
  width,
  inputRef,
  onChange,
  onSubmit,
  onBlur,
  hint,
  type = "text",
  autoComplete,
  variant = "default",
  size = "default",
  backgroundColor,
  textColor,
  placeholderColor,
  onMouseDown,
  onKeyDown,
}: TextFieldProps) {
  const colors = useThemeColors();
  backgroundColor ??= colors.bg;
  textColor ??= colors.text;
  placeholderColor ??= colors.textDim;
  useRemoteUiNode({
    role: "text-field",
    label: label ?? placeholder,
    actions: {
      setValue: (input) => {
        const nextValue = remoteStringValue(input);
        onChange?.(nextValue);
      },
      submit: (input) => {
        const nextValue = remoteStringValue(input, value ?? "");
        onSubmit?.(nextValue);
      },
      blur: () => onBlur?.(value ?? ""),
    },
    metadata: { value, placeholder, focused, type, variant },
  });
  const HostTextField = useUiHost().TextField as ComponentType<TextFieldProps> | undefined;
  if (HostTextField) {
    return (
      <HostTextField
        label={label}
        value={value}
        placeholder={placeholder}
        focused={focused}
        width={width}
        inputRef={inputRef}
        onChange={onChange}
        onSubmit={onSubmit}
        onBlur={onBlur}
        hint={hint}
        type={type}
        autoComplete={autoComplete}
        variant={variant}
        size={size}
        backgroundColor={backgroundColor}
        textColor={textColor}
        placeholderColor={placeholderColor}
        onMouseDown={onMouseDown}
        onKeyDown={onKeyDown}
      />
    );
  }

  const localInputRef = useRef<InputRenderable>(null);
  const resolvedInputRef = inputRef ?? localInputRef;
  const currentValueRef = useRef(value ?? "");
  const [cursorOffset, setCursorOffset] = useState((value ?? "").length);
  const isPassword = type === "password";
  const currentValue = value ?? "";
  const maskedValue = maskPassword(currentValue);
  const maskedDisplay = maskedValue.length > 0 ? maskedValue : (placeholder ?? "");
  const maskedTextColor = maskedValue.length > 0 ? textColor : placeholderColor;

  useEffect(() => {
    currentValueRef.current = currentValue;
    setCursorOffset(resolvedInputRef.current?.cursorOffset ?? currentValue.length);
  }, [currentValue, resolvedInputRef]);

  const syncCursorOffset = (fallbackValue = currentValueRef.current) => {
    setCursorOffset(resolvedInputRef.current?.cursorOffset ?? fallbackValue.length);
  };

  const maskedCursorOffset = currentValue.length > 0
    ? Math.max(0, Math.min(cursorOffset, currentValue.length))
    : 0;
  const maskedBefore = maskedDisplay.slice(0, maskedCursorOffset);
  const maskedCursorChar = maskedDisplay[maskedCursorOffset] ?? " ";
  const maskedAfter = maskedDisplay.slice(maskedCursorOffset + (maskedCursorOffset < maskedDisplay.length ? 1 : 0));

  return (
    <Box flexDirection="column">
      {label && (
        <Box height={1}>
          <Text fg={placeholderColor}>{active === undefined ? label : `${active ? "> " : "  "}${label}`}</Text>
        </Box>
      )}
      <Box height={1} onMouseDown={() => {
        onMouseDown?.();
        resolvedInputRef.current?.focus?.();
      }}>
        <Input
          ref={resolvedInputRef}
          width={width}
          value={value}
          selectable={!isPassword}
          placeholder={isPassword ? "" : placeholder}
          focused={focused}
          textColor={isPassword ? backgroundColor : textColor}
          placeholderColor={placeholderColor}
          backgroundColor={backgroundColor}
          selectionBg={isPassword ? backgroundColor : undefined}
          selectionFg={isPassword ? backgroundColor : undefined}
          showCursor={!isPassword}
          onKeyDown={onKeyDown}
          onCursorChange={() => syncCursorOffset()}
          onInput={(nextValue: string) => {
            currentValueRef.current = nextValue;
            syncCursorOffset(nextValue);
            onChange?.(nextValue);
          }}
          onChange={(nextValue: string) => {
            currentValueRef.current = nextValue;
            syncCursorOffset(nextValue);
            onChange?.(nextValue);
          }}
          onSubmit={() => onSubmit?.(currentValueRef.current)}
          onBlur={() => onBlur?.(currentValueRef.current)}
        />
        {isPassword && (
          <Box
            position="absolute"
            left={0}
            top={0}
            height={1}
            width={width}
            onMouseDown={() => {
              onMouseDown?.();
              resolvedInputRef.current?.focus?.();
            }}
          >
            <Text fg={maskedTextColor} selectable={false}>
              {maskedBefore}
              {focused && (
                <Span bg={maskedTextColor} fg={backgroundColor}>{maskedCursorChar}</Span>
              )}
              {focused ? maskedAfter : maskedDisplay.slice(maskedBefore.length)}
            </Text>
          </Box>
        )}
      </Box>
      {hint && (
        <Box height={1}>
          <Text fg={colors.textMuted}>{hint}</Text>
        </Box>
      )}
    </Box>
  );
}

function sanitizeNumberInput(value: string, allowDecimal: boolean, allowNegative: boolean): string {
  const allowed = allowDecimal ? /[0-9.-]/g : /[0-9-]/g;
  let next = (value.match(allowed) ?? []).join("");

  if (!allowNegative) next = next.replace(/-/g, "");
  if (allowNegative) next = next.replace(/(?!^)-/g, "");

  if (allowDecimal) {
    const [whole, ...rest] = next.split(".");
    next = rest.length === 0 ? next : `${whole}.${rest.join("")}`;
  } else {
    next = next.replace(/\./g, "");
  }

  return next;
}

export interface NumberFieldProps extends Omit<TextFieldProps, "onChange" | "onSubmit" | "onBlur"> {
  allowDecimal?: boolean;
  allowNegative?: boolean;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  onBlur?: (value: string) => void;
}

export function NumberField({
  allowDecimal = true,
  allowNegative = false,
  onChange,
  onSubmit,
  onBlur,
  ...props
}: NumberFieldProps) {
  return (
    <TextField
      {...props}
      onChange={(nextValue) => onChange?.(sanitizeNumberInput(nextValue, allowDecimal, allowNegative))}
      onSubmit={(nextValue) => onSubmit?.(sanitizeNumberInput(nextValue, allowDecimal, allowNegative))}
      onBlur={(nextValue) => onBlur?.(sanitizeNumberInput(nextValue, allowDecimal, allowNegative))}
    />
  );
}

import { Box, Text, useUiHost } from "../../ui";
import { TextAttributes } from "../../ui";
import { type ComponentType, type ReactNode } from "react";
import type { ThemeTokens } from "../../theme/tokens";
import { useThemeColors, useThemeTokens } from "../../theme/theme-context";
import { t } from "../../i18n";
import { useRemoteUiNode } from "../../remote/semantic-tree";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps {
  label: string;
  /** Short text or an icon; `label` remains the accessible action name. */
  displayLabel?: string;
  children?: ReactNode;
  expanded?: boolean;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  active?: boolean;
  shortcut?: string;
  width?: number;
  height?: number | string;
  compact?: boolean;
  /** Keep an action inside a row from also activating that row. */
  stopPropagation?: boolean;
}

function resolveButtonColors(variant: ButtonVariant, active: boolean, disabled: boolean, tokens: ThemeTokens) {
  if (disabled) return tokens.button.disabled;
  if (active) return { bg: tokens.surface.selected, fg: tokens.surface.selectedText };
  return tokens.button[variant];
}

export function Button({
  label: rawLabel,
  displayLabel,
  children,
  expanded,
  onPress,
  variant = "secondary",
  disabled = false,
  active = false,
  shortcut,
  width,
  height,
  compact = false,
  stopPropagation = false,
}: ButtonProps) {
  const colors = useThemeColors();
  const tokens = useThemeTokens();
  const label = t(rawLabel);
  useRemoteUiNode({
    role: "button",
    label,
    disabled,
    actions: {
      press: () => {
        if (!disabled) onPress?.();
      },
    },
    metadata: { variant, active, shortcut, expanded },
  });
  const HostButton = useUiHost().Button as ComponentType<ButtonProps> | undefined;
  if (HostButton) {
    return (
      <HostButton
        label={label}
        displayLabel={displayLabel}
        expanded={expanded}
        onPress={onPress}
        variant={variant}
        disabled={disabled}
        active={active}
        shortcut={shortcut}
        width={width}
        height={height}
        compact={compact}
        stopPropagation={stopPropagation}
      >{children}</HostButton>
    );
  }

  const palette = resolveButtonColors(variant, active, disabled, tokens);

  return (
    <Box
      width={width}
      height={height ?? 1}
      flexDirection="row"
      backgroundColor={palette.bg}
      cursor={disabled ? "default" : "pointer"}
      onMouseDown={(event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
        if (stopPropagation) {
          event.preventDefault?.();
          event.stopPropagation?.();
        }
        if (!disabled) onPress?.();
      }}
    >
      {children ?? <Text fg={palette.fg} attributes={active ? TextAttributes.BOLD : 0}>
        {compact ? displayLabel ?? label : ` ${displayLabel ?? label} `}
      </Text>}
      {shortcut && (
        <Text fg={disabled ? colors.textMuted : colors.textDim}>
          {` ${shortcut}`}
        </Text>
      )}
    </Box>
  );
}

import { Box, Text, useUiHost } from "../../ui";
import { TextAttributes } from "../../ui";
import { type ComponentType, type ReactNode } from "react";
import type { ThemeColors } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { t } from "../../i18n";
import { useRemoteUiNode } from "../../remote/semantic-tree";
import { useScopedButtonAction } from "./action-scope";

/**
 * `ghost` is the quiet button in a row of buttons: it keeps the border so it
 * still reads as a control next to a primary one. `plain` is text that happens
 * to be clickable: no border, no fill. Anything shaped like a row, a table
 * cell, a status bar chip or a link is `plain` — a box drawn around it reads as
 * a control nested in the surface instead of part of it.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "plain";

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
  /** Tooltip, when it should say more than the label. */
  title?: string;
  width?: number;
  height?: number | string;
  compact?: boolean;
  /**
   * Drop the control inset so the label starts flush with the plain text
   * around it. For `plain` buttons that stand in for a row or a line of copy,
   * where a few pixels of button padding would break the column they sit in.
   */
  flush?: boolean;
  /** Keep an action inside a row from also activating that row. */
  stopPropagation?: boolean;
}

function resolveButtonColors(variant: ButtonVariant, active: boolean, disabled: boolean, colors: ThemeColors): { bg?: string; fg: string } {
  if (variant === "plain") {
    return { fg: disabled ? colors.textMuted : active ? colors.textBright : colors.textDim };
  }
  if (disabled) {
    return { bg: colors.panel, fg: colors.textMuted };
  }
  if (active) {
    return { bg: colors.selected, fg: colors.selectedText };
  }

  switch (variant) {
    case "primary":
      return { bg: colors.borderFocused, fg: colors.bg };
    case "danger":
      return { bg: colors.negative, fg: colors.bg };
    case "ghost":
      return { bg: colors.bg, fg: colors.textDim };
    case "secondary":
    default:
      return { bg: colors.panel, fg: colors.text };
  }
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
  flush = false,
  stopPropagation = false,
  title,
}: ButtonProps) {
  const colors = useThemeColors();
  const label = t(rawLabel);
  const scopedShortcut = useScopedButtonAction(label, onPress, disabled);
  shortcut = shortcut ?? scopedShortcut;
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
        title={title}
        width={width}
        height={height}
        compact={compact}
        flush={flush}
        stopPropagation={stopPropagation}
      >{children}</HostButton>
    );
  }

  const palette = resolveButtonColors(variant, active, disabled, colors);

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

import { type ComponentType } from "react";
import { Box, Text, useUiHost } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { useRemoteUiNode } from "../../remote/semantic-tree";
import { t } from "../../i18n";

export type IconName =
  | "more"
  | "close"
  | "zap"
  | "lock"
  | "warning"
  | "back"
  | "chevron-down"
  | "chevron-right"
  | "search"
  | "plus"
  | "check"
  | "minimize"
  | "maximize"
  | "restore";

/** Terminal glyph for each icon; the desktop host draws SVG. */
export const ICON_GLYPHS: Record<IconName, string> = {
  more: "...",
  close: "x",
  zap: "⚡",
  lock: "🔒",
  warning: "⚠",
  back: "←",
  "chevron-down": "▾",
  "chevron-right": "›",
  search: "/",
  plus: "+",
  check: "✓",
  minimize: "_",
  maximize: "□",
  restore: "❐",
};

export interface IconProps {
  name: IconName;
  /** Pixel size on the desktop; the terminal draws one glyph. */
  size?: number;
  color?: string;
}

/** One glyph from the app's icon set. */
export function Icon({ name, size = 12, color }: IconProps) {
  const colors = useThemeColors();
  const HostIcon = useUiHost().Icon as ComponentType<IconProps> | undefined;
  if (HostIcon) return <HostIcon name={name} size={size} color={color} />;
  return <Text fg={color ?? colors.textDim} selectable={false}>{ICON_GLYPHS[name]}</Text>;
}

export interface IconButtonProps {
  icon: IconName;
  /** Accessible name and tooltip. */
  label: string;
  onPress?: () => void;
  /** Toggle state for a pressed/unpressed icon (quick settings). */
  pressed?: boolean;
  color?: string;
  disabled?: boolean;
  size?: number;
  /** Keep the press from also reaching a row or header behind the button. */
  stopPropagation?: boolean;
}

/**
 * The one icon-only button: pane header actions, footer indicators, dialog
 * close, window controls. Desktop draws a hover-washed square with an SVG;
 * the terminal draws the glyph with a space either side.
 */
export function IconButton({
  icon,
  label: rawLabel,
  onPress,
  pressed,
  color,
  disabled = false,
  size = 12,
  stopPropagation = true,
}: IconButtonProps) {
  const colors = useThemeColors();
  const label = t(rawLabel);
  useRemoteUiNode({
    role: "button",
    label,
    disabled,
    actions: { press: () => { if (!disabled) onPress?.(); } },
    metadata: { icon, pressed },
  });
  const HostIconButton = useUiHost().IconButton as ComponentType<IconButtonProps> | undefined;
  if (HostIconButton) {
    return (
      <HostIconButton
        icon={icon}
        label={label}
        onPress={onPress}
        pressed={pressed}
        color={color}
        disabled={disabled}
        size={size}
        stopPropagation={stopPropagation}
      />
    );
  }
  return (
    <Box
      height={1}
      flexDirection="row"
      cursor={disabled || !onPress ? "default" : "pointer"}
      data-gloom-interactive={onPress && !disabled ? "true" : undefined}
      onMouseDown={(event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
        if (stopPropagation) {
          event.preventDefault?.();
          event.stopPropagation?.();
        }
        if (!disabled) onPress?.();
      }}
    >
      <Text fg={disabled ? colors.textMuted : color ?? colors.textDim} selectable={false}>{` ${ICON_GLYPHS[icon]} `}</Text>
    </Box>
  );
}

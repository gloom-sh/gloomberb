import { t } from "../../i18n";
import { Box, Text, useUiHost } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { Button, type ButtonProps } from "./button";

export type ActionRowProps = Pick<ButtonProps, "label" | "children" | "onPress" | "active" | "disabled" | "expanded" | "width" | "height">;

/** A summary row with one action. Put independent actions beside it, not inside it. */
export function ActionRow({ label, children, expanded, active, disabled, ...props }: ActionRowProps) {
  const colors = useThemeColors();
  const desktop = useUiHost().kind === "desktop-web";
  const foreground = disabled ? colors.textMuted : active ? colors.selectedText : colors.text;
  return (
    <Button {...props} label={label} active={active} disabled={disabled} expanded={expanded} variant="ghost" compact stopPropagation>
      <Box flexDirection="row" width="100%" alignItems="center" gap={1}>
        {expanded !== undefined && (desktop ? (
          <Box width={1} style={{ flexShrink: 0 }}>
            <Box style={{ width: 6, height: 6, borderRight: `1px solid ${foreground}`, borderBottom: `1px solid ${foreground}`, transform: `rotate(${expanded ? 45 : -45}deg)` }} />
          </Box>
        ) : <Text fg={foreground}>{expanded ? "▾" : "▸"}</Text>)}
        <Text fg={foreground}>{t(label)}</Text>
        {children}
      </Box>
    </Button>
  );
}

import { t } from "../../i18n";
import { Box, Text, TextAttributes, useUiHost } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { Button, type ButtonProps } from "./button";

export type ActionRowProps = Pick<ButtonProps, "label" | "children" | "onPress" | "active" | "disabled" | "expanded" | "width" | "height"> & {
  /** Text color when the row is neither disabled nor active; team headers use their accent. */
  fg?: string;
};

/**
 * A summary row with one action. Put independent actions beside it, not inside it.
 *
 * The row is the full width of the list it sits in, so it uses `plain`: a box
 * around it would read as a control nested inside the surface rather than as
 * the surface's own header. `active` says unread/changed, which the accent and
 * weight carry instead of a fill.
 */
export function ActionRow({ label, children, expanded, active, disabled, fg, ...props }: ActionRowProps) {
  const colors = useThemeColors();
  const desktop = useUiHost().kind === "desktop-web";
  const foreground = disabled ? colors.textMuted : fg ?? (active ? colors.textBright : colors.text);
  return (
    <Button {...props} label={label} active={active} disabled={disabled} expanded={expanded} variant="plain" compact flush stopPropagation>
      <Box flexDirection="row" width="100%" alignItems="center" gap={1}>
        {expanded !== undefined && (desktop ? (
          <Box width={1} style={{ flexShrink: 0 }}>
            <Box style={{ width: 6, height: 6, borderRight: `1px solid ${foreground}`, borderBottom: `1px solid ${foreground}`, transform: `rotate(${expanded ? 45 : -45}deg)` }} />
          </Box>
        ) : <Text fg={foreground}>{expanded ? "▾" : "▸"}</Text>)}
        <Text fg={foreground} attributes={active ? TextAttributes.BOLD : 0}>{t(label)}</Text>
        {children}
      </Box>
    </Button>
  );
}

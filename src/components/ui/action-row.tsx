import { t } from "../../i18n";
import { Box, Text, TextAttributes } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { Button, type ButtonProps } from "./button";
import { DisclosureMarker } from "./disclosure-marker";

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
  const foreground = disabled ? colors.textMuted : fg ?? (active ? colors.textBright : colors.text);
  return (
    <Button {...props} label={label} active={active} disabled={disabled} expanded={expanded} variant="plain" compact flush stopPropagation>
      <Box flexDirection="row" width="100%" alignItems="center" gap={1}>
        {expanded !== undefined && <DisclosureMarker expanded={expanded} color={foreground} width={2} />}
        <Text fg={foreground} attributes={active ? TextAttributes.BOLD : 0}>{t(label)}</Text>
        {children}
      </Box>
    </Button>
  );
}

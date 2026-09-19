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
          // The chevron is a drawn path, not a square spun 45°: a rotated
          // square does not keep its ink inside the box it spins in, so the
          // open one leant over whatever the row started against and the two
          // states never lined up with each other. One cell of chevron, held
          // in the whole two-cell run from the row's edge to its label (less
          // the gap that run would otherwise add), so it sits between the two
          // instead of hugging the edge with all the slack on the text side.
          <Box width={2} marginRight={-1} style={{ flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
            <Box width={1} style={{ flexShrink: 0 }}>
              <svg viewBox="0 0 12 12" width="100%" fill="none" aria-hidden="true" style={{ display: "block", aspectRatio: "1" }}>
                <path
                  d={expanded ? "M2 4 6 8 10 4" : "M4 2 8 6 4 10"}
                  stroke={foreground}
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Box>
          </Box>
        ) : <Text fg={foreground}>{expanded ? "▾" : "▸"}</Text>)}
        <Text fg={foreground} attributes={active ? TextAttributes.BOLD : 0}>{t(label)}</Text>
        {children}
      </Box>
    </Button>
  );
}

import { t } from "../../i18n";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { Button, type ButtonProps } from "./button";
import { DisclosureMarker } from "./disclosure-marker";
import { NATIVE_CLIP_STYLE } from "./clip-style";

/** The label gives way to what the row puts after it (a count, a mark), which keeps its room. */
const LABEL_CLIP_STYLE = { ...NATIVE_CLIP_STYLE, flex: "0 1 auto" } as const;
const LABEL_END_STYLE = { flex: "0 0 auto", whiteSpace: "pre" } as const;

export type ActionRowProps = Pick<ButtonProps, "label" | "children" | "onPress" | "active" | "disabled" | "expanded" | "width" | "height"> & {
  /** Text color when the row is neither disabled nor active; team headers use their accent. */
  fg?: string;
  /**
   * The end of the label the desktop and the web keep whole while CSS cuts
   * what comes before it, such as a count: "Your layo… (12)". The terminal
   * draws the label as its caller cut it.
   */
  keepEnd?: string;
};

/**
 * A summary row with one action. Put independent actions beside it, not inside it.
 *
 * The row is the full width of the list it sits in, so it uses `plain`: a box
 * around it would read as a control nested inside the surface rather than as
 * the surface's own header. `active` says unread/changed, which the accent and
 * weight carry instead of a fill.
 */
export function ActionRow({ label, children, expanded, active, disabled, fg, keepEnd, ...props }: ActionRowProps) {
  const colors = useThemeColors();
  const foreground = disabled ? colors.textMuted : fg ?? (active ? colors.textBright : colors.text);
  // Desktop: the label takes the room the button has rather than all of it, so a key cap
  // the button adds after it (Enter in an empty state) sits beside it instead of past its edge.
  const { nativePaneChrome } = useUiCapabilities();
  const text = t(label);
  const end = nativePaneChrome && keepEnd && text.endsWith(keepEnd) && text.length > keepEnd.length ? keepEnd : null;
  return (
    <Button {...props} label={label} active={active} disabled={disabled} expanded={expanded} variant="plain" compact flush stopPropagation>
      {/* A label of two lines reads from the left; a desktop button would centre the shorter one. */}
      <Box flexDirection="row" width={nativePaneChrome ? undefined : "100%"} flexGrow={nativePaneChrome ? 1 : undefined} minWidth={nativePaneChrome ? 0 : undefined} alignItems="center" gap={1} style={{ textAlign: "left" }}>
        {expanded !== undefined && <DisclosureMarker expanded={expanded} color={foreground} width={2} />}
        {/* The desktop cuts a long label where the row ends, in CSS; the terminal caller cuts it to its cells. */}
        {end ? (
          <Box flexDirection="row" minWidth={0} overflow="hidden" style={{ flex: "0 1 auto" }}>
            <Text fg={foreground} attributes={active ? TextAttributes.BOLD : 0} style={LABEL_CLIP_STYLE}>{text.slice(0, -end.length)}</Text>
            <Text fg={foreground} attributes={active ? TextAttributes.BOLD : 0} style={LABEL_END_STYLE}>{end}</Text>
          </Box>
        ) : (
          <Text fg={foreground} attributes={active ? TextAttributes.BOLD : 0} style={nativePaneChrome ? LABEL_CLIP_STYLE : undefined}>{text}</Text>
        )}
        {children}
      </Box>
    </Button>
  );
}

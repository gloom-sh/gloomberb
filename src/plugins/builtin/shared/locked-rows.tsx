import type { ReactNode } from "react";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { Icon, type DataTableCell } from "../../../components";
import { useThemeColors } from "../../../theme/theme-context";

/**
 * Placeholder rows a free account sees in place of data only Pro unlocks,
 * with the upgrade prompt on them. The desktop blurs sample text; the
 * terminal, which cannot blur, draws shade blocks.
 */

export function Blurred({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="row" data-gloom-report-ignore="true" aria-hidden="true" style={{ filter: "blur(5px)", userSelect: "none", WebkitUserSelect: "none" }}>
      {children}
    </Box>
  );
}

export function UpgradeLabel({ text, onPress, role }: { text: string; onPress: () => void; role?: string }) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  return (
    <Box flexDirection="row" gap={1} onMouseDown={onPress} data-gloom-role={role} data-gloom-ui="pro-lock">
      {/* The lock is the locked colour on the desktop; the label is the action. */}
      <Icon name="lock" size={11} color={nativePaneChrome ? "var(--gloom-locked)" : colors.textBright} />
      <Text fg={colors.textBright}>{text}</Text>
    </Box>
  );
}

/**
 * Desktop: the prompt floats centred over the blurred rows, like a paywall
 * over the real table. It sits in the table's after-body slot, which starts
 * where the rows end, so it reaches back up over the last `rows` rows.
 */
export function LockedOverlay({ rows, text, onPress, role }: { rows: number; text: string; onPress: () => void; role?: string }) {
  const { cellHeightPx = 18 } = useUiCapabilities();
  return (
    <Box
      style={{
        position: "absolute",
        top: -rows * cellHeightPx,
        left: 0,
        width: "100%",
        height: rows * cellHeightPx,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <Box style={{ pointerEvents: "auto", cursor: "pointer" }}>
        <UpgradeLabel text={text} onPress={onPress} role={role} />
      </Box>
    </Box>
  );
}

/** Shared locked placeholder cell for Pro-preview tables (desktop blurred sample, terminal UpgradeLabel / shade). */
export function lockedTableCell({
  desktop,
  isLabelCell,
  upgradeText,
  labelText = upgradeText,
  blurText = "Hidden",
  shadeText = "░░░░",
  onUpgrade,
  role,
  dimColor,
  onMouseDown,
}: {
  desktop: boolean;
  isLabelCell: boolean;
  upgradeText: string;
  labelText?: string;
  blurText?: string;
  shadeText?: string;
  onUpgrade: () => void;
  role?: string;
  dimColor: string;
  onMouseDown?: () => void;
}): DataTableCell {
  if (!desktop && isLabelCell) {
    return {
      text: labelText,
      content: <UpgradeLabel text={upgradeText} onPress={onUpgrade} role={role} />,
      ...(onMouseDown ? { onMouseDown } : {}),
    };
  }
  return desktop
    ? { text: "", content: <Blurred><Text fg={dimColor}>{blurText}</Text></Blurred> }
    : { text: shadeText, color: dimColor };
}

/** Convenience builder for `DataTableView` `bodyAfter` when a Pro preview has hidden rows on desktop. */
export function lockedTableOverlay(
  rows: number,
  desktop: boolean,
  text: string,
  onPress: () => void,
  role?: string,
): ReactNode {
  return rows > 0 && desktop ? <LockedOverlay rows={rows} text={text} onPress={onPress} role={role} /> : undefined;
}

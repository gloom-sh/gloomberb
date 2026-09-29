import type { ReactNode } from "react";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { Icon } from "../../../components";
import { useThemeColors } from "../../../theme/theme-context";

/**
 * Placeholder rows a free account sees in place of data only Pro unlocks,
 * with the upgrade prompt on them. The desktop blurs sample text; the
 * terminal, which cannot blur, draws shade blocks.
 */

export function Blurred({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="row" style={{ filter: "blur(5px)", userSelect: "none" }}>
      {children}
    </Box>
  );
}

export function UpgradeLabel({ text, onPress, role }: { text: string; onPress: () => void; role?: string }) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="row" gap={1} onMouseDown={onPress} data-gloom-role={role}>
      <Icon name="lock" size={11} color={colors.textBright} />
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

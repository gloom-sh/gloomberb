import { Box, Text, useUiCapabilities } from "../../ui";

/** One part of a whole drawn by `SplitBar`. */
export interface SplitBarPart {
  id: string;
  value: number;
  color: string;
}

/**
 * Terminal cells per part: proportional, at least one for every part above
 * zero so a small one still shows, trimmed from the largest when the floors
 * overshoot the width.
 */
export function splitBarCells(values: readonly number[], width: number): number[] {
  const sum = values.reduce((total, value) => total + (value > 0 ? value : 0), 0);
  if (sum <= 0 || width <= 0) return values.map(() => 0);
  const cells = values.map((value) => (value > 0 ? Math.max(1, Math.round((value / sum) * width)) : 0));
  let total = cells.reduce((a, b) => a + b, 0);
  while (total > width) {
    const largest = cells.indexOf(Math.max(...cells));
    if (cells[largest]! <= 1) break;
    cells[largest] = cells[largest]! - 1;
    total -= 1;
  }
  return cells;
}

/**
 * Parts of a whole as one bar: a pay mix, a Buy/Hold/Sell split. The terminal
 * draws block runs; the desktop draws real elements, so a part can be thinner
 * than a cell.
 */
export function SplitBar({ parts, width }: { parts: readonly SplitBarPart[]; width: number }) {
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const shown = parts.filter((part) => part.value > 0);
  const sum = shown.reduce((total, part) => total + part.value, 0);
  if (sum <= 0 || width <= 0) return null;
  if (isDesktopWeb) {
    return (
      <Box
        height={1}
        flexDirection="row"
        alignItems="center"
        flexShrink={1}
        width={width}
        data-gloom-role="split-bar"
        // It gives way to the text beside it in a narrow row, down to a stub.
        style={{ height: "9px", minWidth: "16px", borderRadius: "2px", overflow: "hidden" }}
      >
        {shown.map((part) => (
          <Box
            key={part.id}
            backgroundColor={part.color}
            style={{ width: `${((part.value / sum) * 100).toFixed(2)}%`, height: "100%", minWidth: "2px" }}
          />
        ))}
      </Box>
    );
  }
  const cells = splitBarCells(shown.map((part) => part.value), width);
  return (
    <Box height={1} flexDirection="row" flexShrink={0}>
      {shown.map((part, index) => (
        <Text key={part.id} fg={part.color}>{"█".repeat(cells[index]!)}</Text>
      ))}
    </Box>
  );
}

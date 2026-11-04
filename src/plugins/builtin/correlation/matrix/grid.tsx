import { useCallback, useEffect, useRef, useState } from "react";
import { Box, ScrollBox, Text, TextAttributes, type ScrollBoxRenderable } from "../../../../ui";
import { usePaneFooter } from "../../../../components";
import { usePaneArrowHold, usePaneHasTabStrip } from "../../../../components/layout/pane/footer/registration";
import { afterLayout } from "../../../../components/ui/reveal-in-scroll-box";
import { useShortcut } from "../../../../react/input";
import { isPlainKey } from "../../../../utils/keyboard";
import { colors } from "../../../../theme/colors";
import { resolveHeatCellColors } from "../../../../theme/heat-colors";
import { formatCorrelation } from "../compute";
import { displaySymbol, MATRIX_CELL_WIDTH, MIN_MATRIX_CELL_WIDTH, ROW_HEADER_WIDTH } from "./model";
import { clampMatrixCursor, matrixSelection, moveMatrixCursor, type MatrixCursor } from "./selection";
import { SymbolLabelCell } from "./symbol-cell";

export interface CorrelationMatrixLayout {
  rowHeaderWidth: number;
  cellWidth: number;
  /** The header column and every cell after the one-cell inset. */
  rowWidth: number;
}

/**
 * Column widths of a matrix of these symbols in a pane this wide: cells grow
 * with the pane up to MATRIX_CELL_WIDTH and keep room for the longest label
 * (a map series' SUEZ.TANKER), and past the pane's width the matrix scrolls.
 */
export function correlationMatrixLayout(symbols: readonly string[], width: number): CorrelationMatrixLayout {
  const labelWidth = Math.max(0, ...symbols.map((symbol) => displaySymbol(symbol).length));
  const rowHeaderWidth = Math.max(ROW_HEADER_WIDTH, Math.min(12, labelWidth + 2));
  const minCellWidth = Math.max(MIN_MATRIX_CELL_WIDTH, labelWidth + 2);
  const cellCount = Math.max(1, symbols.length);
  const availableCellWidth = Math.floor((Math.max(width - rowHeaderWidth - 4, cellCount * minCellWidth)) / cellCount);
  const cellWidth = Math.max(minCellWidth, Math.min(MATRIX_CELL_WIDTH, availableCellWidth));
  // Rows are exactly as wide as the matrix, so the zebra and hover bands stop at the last column.
  return { rowHeaderWidth, cellWidth, rowWidth: 1 + rowHeaderWidth + symbols.length * cellWidth };
}

/** Whether the whole matrix shows at once: every column in `width`, the header and every row in `height`. */
export function correlationMatrixFits(symbols: readonly string[], width: number, height: number): boolean {
  return symbols.length >= 2
    && correlationMatrixLayout(symbols, width).rowWidth <= width - 1
    && symbols.length + 1 <= height;
}

export interface CorrelationMatrixNavigation {
  cursor: MatrixCursor;
  hoveredSymbol: string | null;
  /** The cursor's pair, or one symbol from its row label; null without symbols. */
  selection: [string, string] | null;
  /** What the grid draws the cursor and hover from, and reports clicks and hovers to. */
  grid: Pick<CorrelationMatrixGridProps, "cursor" | "hoveredSymbol" | "onSelectCell" | "onHoverSymbol" | "onLeaveSymbol">;
}

/**
 * The matrix's cursor, hover and keys, the same in every pane that draws it
 * (CORR, and Correlation in portfolio analytics). The arrows and h, j, k and
 * l move the cell, starting from a hovered label's row when there is one;
 * Enter opens the hovered symbol, else the cell's pair, else the row label's
 * symbol. Under a tab strip the matrix sits one level down, as a chart does:
 * the strip keeps Left, Right, h and l until Down, Enter or a click moves
 * into it, and Esc, or Up from the top row, hands them back. Without a strip
 * the matrix has its keys throughout.
 */
export function useCorrelationMatrixNavigation({
  symbols,
  focused,
  scope,
  onOpenPair,
  onOpenSymbol,
}: {
  symbols: readonly string[];
  /** Whether the matrix takes the keys: its pane is focused and nothing else in it holds them. */
  focused: boolean;
  scope: string;
  onOpenPair: (pair: [string, string]) => void;
  onOpenSymbol: (symbol: string) => void;
}): CorrelationMatrixNavigation {
  const [state, setState] = useState<{ cursor: MatrixCursor; hoveredSymbol: string | null }>({
    cursor: { row: 0, column: 1 },
    hoveredSymbol: null,
  });
  const cursor = clampMatrixCursor(state.cursor, symbols.length);
  const selection = matrixSelection(symbols, cursor);
  const symbolsKey = symbols.join(",");
  // Kept inside a new list; a matrix with nothing in it yet (still loading) keeps the cell it starts on.
  useEffect(() => {
    if (symbols.length) setState((current) => ({ ...current, cursor: clampMatrixCursor(current.cursor, symbols.length) }));
  }, [symbolsKey]);
  const zoned = usePaneHasTabStrip();
  const [entered, setEntered] = useState(false);
  const inside = !zoned || entered;
  usePaneArrowHold(focused && zoned && entered);
  // The next visit to the pane or the view starts at the strip.
  useEffect(() => {
    if (!focused) setEntered(false);
  }, [focused]);
  /** A hovered label stays the keyboard's starting point: Left reaches its row label. */
  const moveCursor = (key: string) => {
    setState((current) => {
      const hoveredRow = current.hoveredSymbol ? symbols.indexOf(current.hoveredSymbol) : -1;
      const start = hoveredRow >= 0 ? { row: hoveredRow, column: -1 } : clampMatrixCursor(current.cursor, symbols.length);
      return { cursor: moveMatrixCursor(start, key, symbols.length), hoveredSymbol: null };
    });
  };
  useShortcut((event) => {
    if (event.defaultPrevented || event.targetEditable || event.ctrl || event.alt || event.meta) return;
    if (!inside) {
      if (!isPlainKey(event, "down", "return", "enter")) return;
      event.preventDefault();
      event.stopPropagation();
      setEntered(true);
      return;
    }
    if (zoned && (isPlainKey(event, "escape") || (cursor.row === 0 && !state.hoveredSymbol && isPlainKey(event, "up", "k")))) {
      event.preventDefault();
      event.stopPropagation();
      setEntered(false);
      return;
    }
    if (isPlainKey(event, "j", "down", "k", "up", "h", "left", "l", "right")) {
      event.preventDefault();
      event.stopPropagation();
      moveCursor(event.name ?? event.key ?? "");
    } else if (isPlainKey(event, "return", "enter") && selection) {
      event.preventDefault();
      event.stopPropagation();
      if (state.hoveredSymbol && symbols.includes(state.hoveredSymbol)) onOpenSymbol(state.hoveredSymbol);
      else if (selection[0] !== selection[1]) onOpenPair(selection);
      else onOpenSymbol(selection[0]);
    }
  }, { enabled: focused && symbols.length > 0, phase: "before", scope });
  // Inside, the footer names the way back first, as a chart under a strip does.
  const leaveHint = focused && zoned && entered;
  usePaneFooter(`${scope}:leave`, () => leaveHint
    ? { order: -2, hints: [{ id: "matrix-leave", key: "Esc", label: "tabs", title: "Back to Tabs", onPress: () => setEntered(false) }] }
    : null, [leaveHint]);
  const onHoverSymbol = useCallback((symbol: string) => {
    setState((current) => ({ ...current, hoveredSymbol: symbol }));
  }, []);
  const onLeaveSymbol = useCallback((symbol: string) => {
    setState((current) => (current.hoveredSymbol === symbol ? { ...current, hoveredSymbol: null } : current));
  }, []);
  const onSelectCell = useCallback((next: MatrixCursor) => {
    setState({ cursor: next, hoveredSymbol: null });
    setEntered(true);
  }, []);
  return {
    cursor,
    hoveredSymbol: state.hoveredSymbol,
    selection,
    grid: { cursor, hoveredSymbol: state.hoveredSymbol, onSelectCell, onHoverSymbol, onLeaveSymbol },
  };
}

export interface CorrelationMatrixGridProps {
  symbols: readonly string[];
  width: number;
  height: number;
  /** The correlation of a row's symbol with a column's, null where there is none. */
  correlation: (row: string, column: string) => number | null;
  cursor: MatrixCursor;
  hoveredSymbol: string | null;
  /** A row label's colour: how far its series loaded. Bright when left out. */
  rowColor?: (symbol: string) => string;
  onSelectCell: (cursor: MatrixCursor) => void;
  onHoverSymbol: (symbol: string) => void;
  onLeaveSymbol: (symbol: string) => void;
  onOpenSymbol: (symbol: string) => void;
}

/**
 * The heat-coloured correlation matrix: symbols down the side and across the
 * top, each cell a pair's correlation on the heat scale, the diagonal quiet.
 * A click picks a cell and a label opens its symbol; the owner moves the
 * cursor from the keyboard. It scrolls both ways once the symbols outgrow the
 * pane and keeps the cursor in view.
 */
export function CorrelationMatrixGrid({
  symbols,
  width,
  height,
  correlation,
  cursor,
  hoveredSymbol,
  rowColor = () => colors.textBright,
  onSelectCell,
  onHoverSymbol,
  onLeaveSymbol,
  onOpenSymbol,
}: CorrelationMatrixGridProps) {
  const matrixScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const horizontalScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const { rowHeaderWidth, cellWidth, rowWidth } = correlationMatrixLayout(symbols, width);
  const horizontalBarRows = rowWidth > width - 1 ? 1 : 0;
  const selection = matrixSelection(symbols, cursor);

  // Scroll after React commits a movement, including several keys in one input batch.
  useEffect(() => afterLayout(() => {
    const scroll = matrixScrollRef.current;
    if (scroll) {
      const viewportHeight = Math.max(1, scroll.viewport?.height ?? 1);
      if (cursor.row < scroll.scrollTop) scroll.scrollTo(cursor.row);
      else if (cursor.row + 1 > scroll.scrollTop + viewportHeight) scroll.scrollTo(cursor.row + 1 - viewportHeight);
    }
    const horizontal = horizontalScrollRef.current;
    if (!horizontal) return;
    const left = cursor.column < 0 ? 0 : 1 + rowHeaderWidth + cursor.column * cellWidth;
    const right = left + (cursor.column < 0 ? rowHeaderWidth : cellWidth);
    const scrollLeft = horizontal.scrollLeft ?? 0;
    const viewportWidth = horizontal.viewport?.width || width;
    if (left < scrollLeft) horizontal.scrollTo({ x: left, y: 0 });
    else if (right > scrollLeft + viewportWidth) horizontal.scrollTo({ x: right - viewportWidth, y: 0 });
  }), [cursor.row, cursor.column, height, rowHeaderWidth, cellWidth, width]);

  return (
    <ScrollBox ref={horizontalScrollRef} height={height} flexShrink={1} minHeight={Math.min(height, symbols.length + 1, 5)} scrollX scrollY={false} focusable={false}>
      <Box flexDirection="column" width={Math.max(width - 1, rowWidth)} height={height - horizontalBarRows}>
        {/* Column header row */}
        <Box flexDirection="row" paddingLeft={1} height={1} flexShrink={0} width={rowWidth} backgroundColor={colors.panel}>
          <Box width={rowHeaderWidth} flexShrink={0} />
          {symbols.map((symbol) => (
            <SymbolLabelCell
              key={symbol}
              symbol={symbol}
              width={cellWidth}
              align="flex-end"
              color={colors.textDim}
              hovered={hoveredSymbol === symbol || selection?.[1] === symbol}
              onHover={onHoverSymbol}
              onLeave={onLeaveSymbol}
              onOpen={onOpenSymbol}
            />
          ))}
        </Box>

        {/* Matrix rows */}
        <ScrollBox ref={matrixScrollRef} flexGrow={1} flexBasis={0} minHeight={0} scrollY scrollX={false} focusable={false}>
          <Box flexDirection="column">
            {symbols.map((rowSymbol, rowIndex) => (
              <Box key={rowSymbol} flexDirection="row" paddingLeft={1} width={rowWidth} backgroundColor={rowIndex % 2 === 0 ? colors.bg : undefined}>
                {/* Row header */}
                <Box width={rowHeaderWidth} flexShrink={0} overflow="hidden">
                  <SymbolLabelCell
                    symbol={rowSymbol}
                    width={rowHeaderWidth}
                    color={rowColor(rowSymbol)}
                    hovered={hoveredSymbol === rowSymbol || selection?.[0] === rowSymbol}
                    onHover={onHoverSymbol}
                    onLeave={onLeaveSymbol}
                    onOpen={onOpenSymbol}
                  />
                </Box>
                {/* Cells */}
                {symbols.map((columnSymbol, columnIndex) => {
                  const value = correlation(rowSymbol, columnSymbol);
                  const cellColors = resolveHeatCellColors(value, { quiet: rowSymbol === columnSymbol });
                  const selected = cursor.row === rowIndex && cursor.column === columnIndex;
                  return (
                    <Box
                      key={columnSymbol}
                      width={cellWidth}
                      flexShrink={0}
                      flexDirection="row"
                      justifyContent="flex-end"
                      paddingRight={1}
                      backgroundColor={cellColors.background}
                      style={{ cursor: "pointer" }}
                      onMouseDown={(event: any) => {
                        event.preventDefault?.();
                        event.stopPropagation?.();
                        onSelectCell({ row: rowIndex, column: columnIndex });
                      }}
                    >
                      <Text fg={cellColors.foreground} attributes={selected ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.NONE}>{formatCorrelation(value)}</Text>
                    </Box>
                  );
                })}
              </Box>
            ))}
          </Box>
        </ScrollBox>
      </Box>
    </ScrollBox>
  );
}

import type { ReactNode } from "react";
import { ColumnGrid, ColumnGridPair, RangeTrack, usePaneLinkMenuEntry, useTableLayoutWidth, type ColumnGridCell, type ColumnGridColumn } from "../../../../components";
import { t, tf } from "../../../../i18n";
import { formatMarketPriceWithCurrency, liveQuoteFormatOptions, type MarketFormatOptions } from "../../../../market-data/market/format";
import { colors, hoverBg, priceColor } from "../../../../theme/colors";
import type { Quote } from "../../../../types/financials";
import { Box, Text, useUiCapabilities } from "../../../../ui";
import { displayWidth, formatNumber, truncateToDisplayWidth } from "../../../../utils/format";
import type { OverviewFunctionLink, PositionTableRow, StatField } from "./types";
import { portfolioPnlLabel } from "../../../../portfolio/position-metrics";

const STAT_COLUMN_GAP = 2;
const STAT_LABEL_WIDTH = 12;
const FUNDAMENTALS_MAX_COLUMN_WIDTH = 40;
const BOOK_LABEL_WIDTH = 4;
const RANGE_ENDPOINT_WIDTH = 11;
/** Shortest track worth drawing; below it the label shortens. */
const RANGE_MIN_TRACK_WIDTH = 6;
const POSITION_COLUMN_GAP = 1;
/** The account column never gets narrower than this. */
const ACCOUNT_MIN_WIDTH = 8;

interface PositionColumn {
  key: keyof Omit<PositionTableRow, "pnlValue" | "pnlBasis" | "quantityUnit">;
  label: string;
  width: number;
  align?: "left" | "right";
  color?: (row: PositionTableRow) => string;
  /** Lowest pane width that still has room for this column. */
  minPaneWidth?: number;
}

/** Cells a range row needs around its track: label, endpoints and the gaps between them. */
export function rangeRowChrome(labelWidth: number, endpointWidth: number): number {
  return labelWidth + 1 + endpointWidth * 2 + 2;
}

/** The longest endpoint among ranges drawn together, so stacked tracks start and end in one column. */
export function rangeEndpointWidth(
  values: readonly number[],
  currency: string,
  priceOptions: MarketFormatOptions,
): number {
  const widths = values.map((value) => displayWidth(formatMarketPriceWithCurrency(value, currency, priceOptions)));
  return Math.min(RANGE_ENDPOINT_WIDTH, Math.max(1, ...widths));
}

/**
 * Where the price sits in a range, on one row: the label, the low, a track
 * with a neutral marker and the high. The marker is the position, so no
 * percentage repeats it.
 */
export function CompactRangeBar({
  current,
  low,
  high,
  label,
  shortLabel,
  labelWidth,
  endpointWidth,
  width,
  grow = false,
  currency,
  priceOptions,
}: {
  current: number;
  low: number;
  high: number;
  /** Translated, like `shortLabel`; `labelWidth` is measured from them. */
  label: string;
  /** Used when the full label would leave the track too short. */
  shortLabel?: string;
  /** Shared by ranges drawn together, so their values line up. */
  labelWidth: number;
  endpointWidth: number;
  /** Cells on the terminal, and what the label and track are chosen from. */
  width: number;
  /** The desktop, beside another bar in a row: take an equal share of it. Alone in a column the row fills it anyway. */
  grow?: boolean;
  currency: string;
  /** The quote's live price options, so the endpoints keep the price's decimals. */
  priceOptions: MarketFormatOptions;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const range = high - low;
  if (range <= 0) return null;
  const position = Math.max(0, Math.min(1, (current - low) / range));
  const useShortLabel = shortLabel != null && width - rangeRowChrome(labelWidth, endpointWidth) < RANGE_MIN_TRACK_WIDTH;
  const shownLabel = useShortLabel ? shortLabel : label;
  const shownLabelWidth = useShortLabel ? displayWidth(shortLabel) : labelWidth;
  const endpointOptions = { ...priceOptions, maxWidth: endpointWidth };
  const lowText = formatMarketPriceWithCurrency(low, currency, endpointOptions);
  const highText = formatMarketPriceWithCurrency(high, currency, endpointOptions);
  const barWidth = Math.max(1, width - rangeRowChrome(shownLabelWidth, endpointWidth));

  // The desktop and the web size the row and its track by CSS, so the high end keeps to the pane's edge on every frame of a
  // resize; the label, the endpoints and which of them show are still worked out from `width`, at each catch-up.
  return (
    <Box
      flexDirection="row"
      height={1}
      width={nativePaneChrome ? undefined : width}
      flexShrink={nativePaneChrome && grow ? 1 : 0}
      flexGrow={nativePaneChrome && grow ? 1 : undefined}
      flexBasis={nativePaneChrome && grow ? 0 : undefined}
      minWidth={nativePaneChrome ? 0 : undefined}
      overflow="hidden"
      data-gloom-role="range-row"
    >
      <Box width={shownLabelWidth + 1} flexShrink={0} overflow="hidden">
        <Text fg={colors.textDim}>{shownLabel}</Text>
      </Box>
      {/* The low sits against the track and the high starts after it, so stacked tracks align. */}
      <Box flexDirection="row" width={endpointWidth} flexShrink={0} justifyContent="flex-end" overflow="hidden">
        <Text fg={colors.text}>{lowText}</Text>
      </Box>
      <Box
        marginLeft={1}
        marginRight={1}
        flexShrink={nativePaneChrome ? 1 : 0}
        flexGrow={nativePaneChrome ? 1 : undefined}
        flexBasis={nativePaneChrome ? 0 : undefined}
        minWidth={nativePaneChrome ? 0 : undefined}
      >
        <RangeTrack width={barWidth} position={position} markerColor={colors.textBright} fill={nativePaneChrome} />
      </Box>
      <Box width={endpointWidth} flexShrink={0} overflow="hidden">
        <Text fg={colors.text}>{highText}</Text>
      </Box>
    </Box>
  );
}

/** The quote book's columns: its labels, then the value right-aligned in the rest. */
function bookColumns(width: number): ColumnGridColumn[] {
  return [
    { width: BOOK_LABEL_WIDTH },
    // Right-aligned, so a size changing length does not slide the price.
    { width: Math.max(0, width - BOOK_LABEL_WIDTH), growFrom: 0, align: "right" },
  ];
}

export function QuoteBook({ quote, assetCategory, width, desktopWidth }: {
  quote: Quote;
  assetCategory?: string;
  /** Cells on the terminal. */
  width: number;
  /** The desktop's width for the book, in CSS. */
  desktopWidth?: string;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  // Bid, ask and spread keep the instrument's decimals on every tick ($224.58 / $224.60 / $0.02).
  const priceOptions = liveQuoteFormatOptions(quote, quote.currency, assetCategory);
  const bidPrice = quote.bid != null ? formatMarketPriceWithCurrency(quote.bid, quote.currency, priceOptions) : "—";
  const askPrice = quote.ask != null ? formatMarketPriceWithCurrency(quote.ask, quote.currency, priceOptions) : "—";
  const bidText = quote.bidSize != null && quote.bidSize > 0 ? `${formatNumber(quote.bidSize, 0)} x ${bidPrice}` : bidPrice;
  const askText = quote.askSize != null && quote.askSize > 0 ? `${formatNumber(quote.askSize, 0)} x ${askPrice}` : askPrice;
  let spreadText = "—";
  if (quote.bid != null && quote.ask != null) {
    const spread = quote.ask - quote.bid;
    const mid = (quote.ask + quote.bid) / 2;
    const spreadPercent = mid > 0 ? ` (${((spread / mid) * 100).toFixed(2)}%)` : "";
    spreadText = `${formatMarketPriceWithCurrency(spread, quote.currency, priceOptions)}${spreadPercent}`;
  }

  const row = (label: string, value: string, color: string): ColumnGridCell[] => [{ text: label, color: colors.textDim }, { text: value, color }];
  return (
    <Box flexDirection="column" width={nativePaneChrome ? undefined : width} flexShrink={0} style={nativePaneChrome ? { width: desktopWidth } : undefined}>
      <ColumnGrid
        columns={bookColumns(width)}
        width={width}
        role="quote-book"
        rows={[
          // Neutral: a red ask would read as a loss.
          row(t("Bid"), bidText, colors.textBright),
          row(t("Ask"), askText, colors.textBright),
          row(t("Spr"), spreadText, colors.textDim),
        ]}
      />
    </Box>
  );
}

/**
 * The overview's fundamentals as label/value pairs in columns. Columns are
 * capped at FUNDAMENTALS_MAX_COLUMN_WIDTH so a wide pane gets more of them
 * instead of pushing each value half a pane away from its label.
 */
function fundamentalsGridColumns(width: number): number {
  if (width < 58) return 1;
  return Math.max(2, Math.min(4, Math.ceil((width + STAT_COLUMN_GAP) / (FUNDAMENTALS_MAX_COLUMN_WIDTH + STAT_COLUMN_GAP))));
}

function gridLabelWidth(colWidth: number): number {
  return Math.min(STAT_LABEL_WIDTH, Math.max(8, Math.floor(colWidth * 0.45)));
}

/**
 * Columns for words rather than figures (an industry, a website): the most
 * the grid allows at which every value reads whole. A title that may be cut
 * (a SIC description) does not count.
 */
export function textGridColumns(fields: StatField[], width: number): number {
  const widest = Math.max(0, ...fields.map((field) => displayWidth(field.value)));
  for (let columns = fundamentalsGridColumns(width); columns > 1; columns -= 1) {
    const colWidth = Math.floor((width - STAT_COLUMN_GAP * (columns - 1)) / columns);
    if (colWidth - gridLabelWidth(colWidth) >= widest) return columns;
  }
  return 1;
}

/** A figure that opens its research function: the whole cell is the target. */
function LinkedStatCell({
  link,
  width,
  onOpen,
  children,
}: {
  link: OverviewFunctionLink;
  width: number;
  onOpen: (link: OverviewFunctionLink) => void;
  children: ReactNode;
}) {
  // The pane menu lists each function once, so the keyboard reaches what a click opens.
  usePaneLinkMenuEntry(`function:${link.templateId}`, tf("Open {label}", { label: t(link.name) }), () => onOpen(link));
  const { nativePaneChrome } = useUiCapabilities();
  return (
    <Box
      width={nativePaneChrome ? undefined : width}
      flexGrow={nativePaneChrome ? 1 : undefined}
      style={nativePaneChrome ? { minWidth: 0 } : undefined}
      flexDirection="row"
      hoverBackgroundColor={hoverBg()}
      onMouseDown={(event?: { button?: number }) => {
        if ((event?.button ?? 0) === 0) onOpen(link);
      }}
      cursor="pointer"
      data-gloom-interactive="true"
      data-gloom-label={tf("Open {label}", { label: t(link.name) })}
      data-gloom-ui="key-value-row"
    >
      {children}
    </Box>
  );
}

export function FundamentalsGrid({
  fields,
  width,
  columns,
  onOpenLink,
}: {
  fields: StatField[];
  width: number;
  /** Fixed column count; by default as many as keep each value near its label. */
  columns?: number;
  /** Opens a figure's research function; without it figures are plain. */
  onOpenLink?: (link: OverviewFunctionLink) => void;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const columnCount = columns ?? fundamentalsGridColumns(width);
  const availableWidth = width - STAT_COLUMN_GAP * (columnCount - 1);
  const baseColWidth = Math.floor(availableWidth / columnCount);
  const extraWidth = availableWidth - baseColWidth * columnCount;
  const colWidths = Array.from({ length: columnCount }, (_, index) => baseColWidth + (index === columnCount - 1 ? extraWidth : 0));
  // Equal columns on the desktop too, sharing the pane's width there.
  // A column never gets narrower than its labels, so a label cannot reach the next column.
  const gridColumns: ColumnGridColumn[] = colWidths.map((colWidth, index) => ({
    width: colWidth,
    growFrom: gridLabelWidth(colWidth),
    gapBefore: index > 0 ? STAT_COLUMN_GAP : 0,
  }));
  const rows: ColumnGridCell[][] = [];
  for (let i = 0; i < fields.length; i += columnCount) {
    rows.push(Array.from({ length: columnCount }, (_, offset): ColumnGridCell => {
      const field = fields[i + offset];
      if (!field) return null;
      const colWidth = colWidths[offset] ?? baseColWidth;
      const labelWidth = gridLabelWidth(colWidth);
      const valueWidth = Math.max(1, colWidth - labelWidth);
      // A long value (an industry, a SIC title) is cut from the end, never from the label side.
      const value = truncateToDisplayWidth(field.value, valueWidth);
      const detailRoom = valueWidth - displayWidth(value) - 1;
      const details = typeof field.detail === "string" ? [field.detail] : field.detail ?? [];
      // A cut "in 4..." misleads; a title cut to "Semicond..." still names it.
      const detail = details.find((text) => displayWidth(text) <= detailRoom)
        ?? (field.clipDetail && details[0] && detailRoom >= 4 ? truncateToDisplayWidth(details[0], detailRoom) : "");
      const content = (
        <ColumnGridPair
          label={t(field.label)}
          labelWidth={labelWidth}
          width={colWidth}
          value={field.value}
          valueColor={field.valueColor}
          detail={detail || undefined}
          url={field.url}
        />
      );
      return {
        content: field.link && onOpenLink
          ? <LinkedStatCell link={field.link} width={colWidth} onOpen={onOpenLink}>{content}</LinkedStatCell>
          : (
            <Box
              width={nativePaneChrome ? undefined : colWidth}
              flexGrow={nativePaneChrome ? 1 : undefined}
              flexDirection="row"
              data-gloom-ui="key-value-row"
              style={nativePaneChrome ? { minWidth: 0 } : undefined}
            >
              {content}
            </Box>
          ),
      };
    }));
  }

  return <ColumnGrid columns={gridColumns} rows={rows} role="fundamentals-grid" />;
}

const POSITION_COLUMNS: readonly PositionColumn[] = [
  { key: "account", label: "Account", width: 0 },
  { key: "qty", label: "Qty", width: 8, align: "right" },
  { key: "avg", label: "Avg", width: 9, align: "right", minPaneWidth: 70 },
  { key: "mark", label: "Mark", width: 9, align: "right", minPaneWidth: 70 },
  { key: "cost", label: "Cost", width: 11, align: "right", minPaneWidth: 84 },
  { key: "value", label: "Value", width: 11, align: "right" },
  { key: "pnl", label: "P&L", width: 12, align: "right", color: (row) => priceColor(row.pnlValue ?? 0) },
  { key: "ret", label: "Ret", width: 7, align: "right", color: (row) => priceColor(row.pnlValue ?? 0), minPaneWidth: 84 },
];

function createPositionColumns(width: number, hasFaceQuantity: boolean): PositionColumn[] {
  const columns = POSITION_COLUMNS.filter((column) => width >= (column.minPaneWidth ?? 0)).map((column) => ({
    ...column, width: column.key === "qty" && hasFaceQuantity ? 11 : column.width,
  }));
  const fixedWidth = columns.reduce((sum, column) => sum + column.width, 0) + POSITION_COLUMN_GAP * (columns.length - 1);
  const accountColumn = columns[0]!;
  accountColumn.width = Math.max(ACCOUNT_MIN_WIDTH, width - fixedWidth);
  return columns;
}

export function PositionTable({ rows, width }: { rows: PositionTableRow[]; width: number }) {
  const tableLayoutWidth = useTableLayoutWidth(width);
  const columns = createPositionColumns(tableLayoutWidth, rows.some(row => row.quantityUnit === "face"));
  const pnlLabel = portfolioPnlLabel(rows.map((row) => row.pnlBasis));
  const gridColumns: ColumnGridColumn[] = columns.map((column, index) => ({
    width: column.width,
    align: column.align,
    gapBefore: index > 0 ? POSITION_COLUMN_GAP : 0,
    // The account takes what the figures leave, on the desktop too.
    ...(column.key === "account" ? { growFrom: ACCOUNT_MIN_WIDTH } : {}),
  }));
  const header: ColumnGridCell[] = columns.map((column) => ({
    text: t(column.key === "pnl" ? pnlLabel : column.label),
    color: colors.textDim,
  }));
  const body = rows.map((row): ColumnGridCell[] => columns.map((column) => ({
    text: row[column.key],
    color: column.color?.(row) ?? (column.key === "account" ? colors.textBright : colors.text),
  })));

  return <ColumnGrid columns={gridColumns} rows={[header, ...body]} width={width} role="position-table" />;
}

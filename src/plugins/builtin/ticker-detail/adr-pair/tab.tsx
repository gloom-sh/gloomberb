import { useState } from "react";
import {
  DataTableView, EmptyState, Notice, PaneStatusBody, StatGrid, statGridRows, usePaneTicker,
  type DataTableCell, type DataTableColumn, type StatItem,
} from "../../../../components";
import { useFxRateObservations, useQuoteEntry } from "../../../../market-data/hooks";
import { resolveEntryData } from "../../../../market-data/selectors";
import { spotFromUsdValue } from "../../../../market-data/depositary-pair";
import { heldCurrencyUnit } from "../../../../utils/currency-units";
import type { TickerResearchTabProps } from "../../../../types/plugin";
import { Box } from "../../../../ui";
import { useRemoteUiNode } from "../../../../remote/semantic-tree";
import { MISSING_VALUE } from "../../../../utils/format";
import { useOpenDescription } from "../../shared/open-description";
import { adrPairComparison, adrPairFigures, adrPairInputRows, adrPairLegs, adrPairQuotes, ahPairFigures, ahPairInputRows, type AdrPairInputRow } from "./model";
import { useAhPair } from "./ah";

// The price and its time first: a narrow pane keeps them and drops the role.
const COLUMNS: DataTableColumn[] = [
  { id: "listing", label: "Listing", width: 9, align: "left" },
  { id: "price", label: "Price", width: 13, align: "right" },
  { id: "asOf", label: "As of (UTC)", width: 16, align: "left" },
  { id: "session", label: "Session", width: 7, align: "left" },
  { id: "role", label: "Role", width: 24, align: "left" },
];

function renderCell(row: AdrPairInputRow, column: DataTableColumn): DataTableCell {
  return { text: String(row[column.id as keyof AdrPairInputRow] ?? "") };
}

/**
 * DES "ADR vs home": a receipt beside its home line, for a listing Gloom
 * Cloud pairs with one. The ratio, both prices, the dollar rate they imply
 * (home × ratio / ADR), spot, and the receipt's premium or discount at spot,
 * each price dated, and a note when the two were not set together. A line of
 * an A+H company adds its other line: the H price over the A price at spot,
 * the A price in Hong Kong dollars and the yuan's rate, each price in its own
 * currency and dated (`useAhPair`).
 */
export function AdrPairResearchTab({ width, height, focused }: TickerResearchTabProps) {
  const { symbol, ticker, financials } = usePaneTicker();
  const legs = adrPairLegs(financials, ticker, symbol);
  // Both legs through the quote path, so each is read alike whichever side the pane is on.
  const ownEntry = useQuoteEntry(ticker?.metadata.ticker ?? symbol, ticker);
  const otherEntry = useQuoteEntry(legs?.otherKey ?? null, null);
  const quotes = legs
    ? adrPairQuotes(legs, { own: resolveEntryData(ownEntry), other: resolveEntryData(otherEntry) }, financials?.quote)
    : { receipt: null, home: null };
  const receiptQuote = quotes.receipt;
  const homeQuote = quotes.home;
  const [receiptEntry, homeEntry] = legs?.receiptSide ? [ownEntry, otherEntry] : [otherEntry, ownEntry];
  // The home price's currency, a minor unit read as its own (GBp as GBP), as the comparison reads it.
  const homeCurrency = homeQuote?.currency ? heldCurrencyUnit(homeQuote.currency).currency : "";
  const observed = useFxRateObservations([homeCurrency]).get(homeCurrency);
  const spot = spotFromUsdValue(observed?.rate, observed?.asOf);
  const comparison = legs ? adrPairComparison(legs, { receipt: receiptQuote, home: homeQuote }, spot) : null;
  const ah = useAhPair(ticker?.metadata.ticker ?? symbol, ticker?.metadata.exchange || financials?.quote?.listingExchangeName,
    resolveEntryData(ownEntry) ?? financials?.quote);
  const ahComparison = ah?.comparison ?? null;
  const openDescription = useOpenDescription();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const adrRows = comparison ? adrPairInputRows(comparison, { receipt: receiptQuote, home: homeQuote }) : [];
  const stats: StatItem[] = [...comparison ? adrPairFigures(comparison) : [], ...ahComparison && ah ? ahPairFigures(ahComparison, ah.quotes.h) : []];
  const rows = [...adrRows, ...ahComparison && ah ? ahPairInputRows(ahComparison, ah.quotes, adrRows.map((row) => row.listing)) : []];

  if (!legs && !ah) return <EmptyState title="No ADR pair for this listing." />;
  const pending = (entry: typeof receiptEntry) => !entry || entry.phase === "loading" || entry.phase === "idle";
  // A leg with a quote is not waiting on its read.
  const loading = legs
    ? !comparison && ((!receiptQuote && pending(receiptEntry)) || (!homeQuote && pending(homeEntry)))
    : !ahComparison && !!ah?.loading;
  const error = rows.length === 0 && !loading
    ? `Prices unavailable for ${legs ? !receiptQuote ? legs.receiptKey : legs.homeKey : ah!.side === "h" ? ah!.pair.a : ah!.pair.h}.`
    : null;
  const notes = [comparison?.timingNote, ahComparison?.timingNote].filter((note): note is string => !!note);
  const figures = comparison ? adrPairFigures(comparison).filter((figure) => figure.value !== MISSING_VALUE) : [];
  useRemoteUiNode(comparison ? {
    role: "report-notice", label: "ADR comparison",
    getMetadata: () => ({
      text: [...figures.map(({ label, value, detail }) => `${label}: ${value}${detail ? ` (${detail})` : ""}`), ...notes].join(" · "),
      key: "adrComparison",
      value: { ratio: comparison.ratio, impliedFx: comparison.impliedFx, premiumPercent: comparison.premiumPercent },
    }),
  } : null);
  // Each note wraps to the pane's width, less its inset.
  const noteRows = notes.reduce((total, note) => total + Math.ceil(note.length / Math.max(1, width - 2)), 0);
  const tableHeight = Math.max(3, height - statGridRows(stats, width) - noteRows);

  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <PaneStatusBody subject={legs ? "ADR pair" : "A+H pair"} loading={loading} error={error} width={width} height={height}>
      {rows.length > 0 ? <>
        <StatGrid items={stats} width={width} />
        {notes.map((note) => <Box key={note} paddingX={1} flexShrink={0}><Notice>{note}</Notice></Box>)}
        <DataTableView<AdrPairInputRow>
          focused={focused}
          columns={COLUMNS}
          items={rows}
          rootWidth={width}
          rootHeight={tableHeight}
          getItemKey={(row) => row.id}
          emptyStateTitle="No prices."
          sortColumnId={null}
          sortDirection="asc"
          selection={{ kind: "index", selectedIndex, onChange: setSelectedIndex }}
          isNavigable={(row) => row.opens != null}
          onActivate={(row) => { if (row.opens) openDescription(row.opens); }}
          renderCell={renderCell}
        />
      </> : null}
    </PaneStatusBody>
  </Box>;
}

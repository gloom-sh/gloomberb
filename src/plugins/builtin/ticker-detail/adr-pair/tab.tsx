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
import { useOpenDescription } from "../../shared/open-description";
import { adrPairComparison, adrPairFigures, adrPairInputRows, adrPairLegs, type AdrPairInputRow } from "./model";

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
 * each price dated, and a note when the two were not set together.
 */
export function AdrPairResearchTab({ width, height, focused }: TickerResearchTabProps) {
  const { symbol, ticker, financials } = usePaneTicker();
  const legs = adrPairLegs(financials, ticker, symbol);
  // Both legs through the quote path, so each is read alike whichever side the pane is on.
  const ownEntry = useQuoteEntry(legs ? ticker?.metadata.ticker ?? symbol : null, ticker);
  const otherEntry = useQuoteEntry(legs?.otherKey ?? null, null);
  const [receiptEntry, homeEntry] = legs?.receiptSide ? [ownEntry, otherEntry] : [otherEntry, ownEntry];
  const receiptQuote = resolveEntryData(receiptEntry);
  const homeQuote = resolveEntryData(homeEntry);
  // The home price's currency, a minor unit read as its own (GBp as GBP), as the comparison reads it.
  const homeCurrency = homeQuote?.currency ? heldCurrencyUnit(homeQuote.currency).currency : "";
  const observed = useFxRateObservations([homeCurrency]).get(homeCurrency);
  const spot = spotFromUsdValue(observed?.rate, observed?.asOf);
  const comparison = legs ? adrPairComparison(legs, { receipt: receiptQuote, home: homeQuote }, spot) : null;
  const openDescription = useOpenDescription();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const stats: StatItem[] = comparison ? adrPairFigures(comparison) : [];
  const rows = comparison ? adrPairInputRows(comparison, { receipt: receiptQuote, home: homeQuote }) : [];

  if (!legs) return <EmptyState title="No ADR pair for this listing." />;
  const pending = (entry: typeof receiptEntry) => !entry || entry.phase === "loading" || entry.phase === "idle";
  const loading = !comparison && (pending(receiptEntry) || pending(homeEntry));
  const error = !comparison && !loading
    ? `Prices unavailable for ${!receiptQuote ? legs.receiptKey : legs.homeKey}.`
    : null;
  // The note wraps to the pane's width, less its inset.
  const noteRows = comparison?.timingNote ? Math.ceil(comparison.timingNote.length / Math.max(1, width - 2)) : 0;
  const tableHeight = Math.max(3, height - statGridRows(stats, width) - noteRows);

  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <PaneStatusBody subject="ADR pair" loading={loading} error={error} width={width} height={height}>
      {comparison ? <>
        <StatGrid items={stats} width={width} />
        {comparison.timingNote ? <Box paddingX={1} flexShrink={0}><Notice>{comparison.timingNote}</Notice></Box> : null}
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

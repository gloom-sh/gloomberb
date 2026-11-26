import { expect, test } from "bun:test";
import { createDataTableCsv } from "../../../components/data-table/export";
import { dataTableDisplayColumns } from "../../../components/ui/data-table/display-columns";
import type { QueryEntry } from "../../../market-data/result-types";
import { buildQuoteKey } from "../../../market-data/selectors";
import { sessionQuotes } from "../../../test-support/test-fixture-session-quotes";
import type { Quote } from "../../../types/financials";
import { createRows, overlayMarketMoverQuotes, screenerQuoteFromQuote, sortRows } from "./model";
import { buildMarketMoverColumns, renderMarketMoverCell } from "./table";

test("MOST keeps a same-listing quote cap, hides only an all-empty column, and exports its raw values", () => {
  const quotes = ["UNKNOWN", "QUOTED", "LISTED"].map((symbol) => sessionQuotes(symbol, { listingExchangeName: "NASDAQ" }));
  const listed = quotes.map(({ regular }, index) => ({ ...screenerQuoteFromQuote(regular.symbol, regular),
    exchange: "XNAS", marketCap: index === 2 ? 9_000_000 : undefined }));
  const entry = (quote: Quote): QueryEntry<Quote> => ({ phase: "ready", data: quote, lastGoodData: quote,
    source: null, fetchedAt: null, staleAt: null, error: null, attempts: [] });
  const overlay = (caps: Partial<Quote>[]) => createRows(overlayMarketMoverQuotes(listed, new Map(listed.map((row, index) => [
    buildQuoteKey(row), entry({ ...quotes[index]!.afterHours, ...caps[index] }),
  ]))));
  const mixed = overlay([{ listingExchangeName: "NYSE", marketCap: 100 }, { marketCap: 12_345_678 }, { marketCap: 100 }]);
  expect(mixed.map((row) => [row.rank, row.marketCap])).toEqual([[1, undefined], [2, 12_345_678], [3, 9_000_000]]);
  expect(sortRows(mixed, { columnId: "marketCap", direction: "desc" }).map((row) => row.symbol)).toEqual(["QUOTED", "LISTED", "UNKNOWN"]);

  const renderCell = (row: (typeof mixed)[number], column: ReturnType<typeof buildMarketMoverColumns>[number]) => renderMarketMoverCell(row, column);
  const columns = buildMarketMoverColumns(100, ["POST"]);
  const empty = { columns, items: [mixed[0]!], renderCell, isSelected: () => false };
  expect(dataTableDisplayColumns(empty).map(({ id }) => id)).not.toContain("marketCap");
  expect(dataTableDisplayColumns({ ...empty, items: mixed }).map(({ id }) => id)).toContain("marketCap");
  const narrow = dataTableDisplayColumns({ ...empty, items: mixed, columns: buildMarketMoverColumns(88, ["POST"]) }).map(({ id }) => id);
  expect(narrow).toContain("range");
  expect(narrow).toContain("afterHours");
  expect(narrow).not.toContain("marketCap");
  const [header, blank, covered] = createDataTableCsv({ ...empty, items: mixed }).trimEnd().split(/\r?\n/);
  expect(header).toEndWith(",MCAP");
  expect(blank).toEndWith(",");
  expect(covered).toEndWith(",12345678");
});

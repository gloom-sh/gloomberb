import { describe, expect, test } from "bun:test";
import { seriesCatalogEntry } from "../../../series/registry";
import type { SeriesCatalogEntry, SeriesDefinition } from "../../../series/types";
import {
  catalogExpressionForRow,
  catalogRowsForListedCrypto,
  catalogRowsForResolvedInstruments,
  catalogRowsFromEntries,
  catalogTabs,
  filterCatalogRows,
  looksLikeCatalogTickerQuery,
  mergeCatalogRows,
  normalizeCatalogFilter,
} from "./catalog-inventory";

function entry(definition: SeriesDefinition, pluginId = "invented"): SeriesCatalogEntry {
  return seriesCatalogEntry({ definition, pluginId });
}

const load = () => [];
const ENTRIES: SeriesCatalogEntry[] = [
  entry({ id: "field:market.close", name: "Close", unit: "currency", frequency: "daily", group: "Securities", input: "ticker", expression: "{ticker}:close" }),
  entry({ id: "field:market.ohlcv", name: "Price (OHLCV)", unit: "currency", frequency: "daily", group: "Securities", input: "ticker", expression: "{ticker}:price" }),
  entry({ id: "option:market.close", name: "Close", unit: "currency", frequency: "daily", group: "Options", input: "option", expression: "{ticker}:close" }),
  entry({ id: "crypto:BTC-USD", name: "Bitcoin", unit: "USD", frequency: "intraday", group: "Crypto", expression: "BTC-USD:price" }),
  entry({ id: "crypto:price", name: "Price", unit: "currency", frequency: "intraday", group: "Crypto", input: "crypto", expression: "{ticker}:price" }),
  entry({ id: "lending:fee", name: "Lending fee", unit: "%", frequency: "daily", group: "Positioning", input: "ticker", load }),
  entry({ id: "widgets:orders", name: "Widget orders", unit: "count", frequency: "weekly", group: "Economy", publisher: "Widget Board", load }),
  entry({ id: "sentiment:mood", name: "Mood index", unit: "score", frequency: "daily", group: "Sentiment", load }),
  entry({ id: "mine:garden", name: "Garden rainfall", unit: "number", frequency: "daily", group: "Rain gauges", load }),
];
const AAPL = { symbol: "AAPL", exchange: "NASDAQ", name: "Apple Inc." };

describe("data catalog rows", () => {
  test("a series that takes a ticker is listed once and filled in when charted", () => {
    const rows = catalogRowsFromEntries(ENTRIES);
    const close = rows.find((row) => row.id === "field:market.close")!;
    expect(close.expression).toBe("TICKER:close");
    expect(catalogExpressionForRow(close, "aapl")).toBe("AAPL:close");
    expect(catalogExpressionForRow(close, "")).toBeNull();

    const option = rows.find((row) => row.id === "option:market.close")!;
    expect(catalogExpressionForRow(option, "AAPL 260618C00200000")).toBe("AAPL260618C00200000:close");
    // A loaded series carries the symbol in its id, URL-encoded like the capability id.
    const fee = rows.find((row) => row.id === "lending:fee")!;
    expect(fee.expression).toBe("CAP:lending:fee/TICKER");
    expect(catalogExpressionForRow(fee, "^gspc")).toBe("CAP:lending:fee/%5EGSPC");
  });

  test("tabs follow the catalog's group order, then other groups by name; old tab ids still open", () => {
    const rows = catalogRowsFromEntries(ENTRIES);
    expect(catalogTabs(rows).map((tab) => tab.id)).toEqual([
      "all", "Securities", "Options", "Crypto", "Economy", "Sentiment", "Positioning", "Rain gauges",
    ]);
    expect(normalizeCatalogFilter("securities", rows)).toBe("Securities");
    expect(normalizeCatalogFilter("valuation", rows)).toBe("all");
    expect(filterCatalogRows(rows, "Sentiment", "").map((row) => row.id)).toEqual(["sentiment:mood"]);
    // Rows come in group order, so the default sort costs nothing.
    expect(rows.map((row) => row.group).slice(0, 3)).toEqual(["Securities", "Securities", "Options"]);
  });

  test("search matches every word across name, group, unit, publisher and expression", () => {
    const rows = catalogRowsFromEntries(ENTRIES);
    expect(filterCatalogRows(rows, "all", "widget board").map((row) => row.id)).toEqual(["widgets:orders"]);
    expect(filterCatalogRows(rows, "all", "weekly count").map((row) => row.id)).toEqual(["widgets:orders"]);
    expect(filterCatalogRows(rows, "all", "cap:sentiment").map((row) => row.id)).toEqual(["sentiment:mood"]);
    expect(filterCatalogRows(rows, "Economy", "mood")).toHaveLength(0);
  });

  test("a ticker search fills in each series that fits the instrument", () => {
    expect(looksLikeCatalogTickerQuery("AAPL")).toBe(true);
    expect(looksLikeCatalogTickerQuery("btc-usd")).toBe(true);
    expect(looksLikeCatalogTickerQuery("close")).toBe(false);
    const rows = catalogRowsFromEntries(ENTRIES);
    const resolved = catalogRowsForResolvedInstruments(rows, [AAPL]);
    expect(resolved.map((row) => row.template).sort()).toEqual(["AAPL:close", "AAPL:price", "CAP:lending:fee/AAPL"]);
    expect(resolved.every((row) => !row.input && row.label.startsWith("AAPL · "))).toBe(true);
    expect(filterCatalogRows(resolved, "all", "apple fee").map((row) => row.template)).toEqual(["CAP:lending:fee/AAPL"]);
  });

  test("crypto pairs on the user's lists are listed once, beside the registered pairs", () => {
    const rows = catalogRowsFromEntries(ENTRIES);
    const listed = catalogRowsForListedCrypto(rows, [
      AAPL,
      { symbol: "BTC-USD", exchange: "CCC", name: "Bitcoin USD" },
      { symbol: "PEPE-USD", exchange: "CCC", name: "Pepe USD" },
    ]);
    const crypto = filterCatalogRows(mergeCatalogRows(rows, listed), "Crypto", "");
    // The registered pair keeps its row and name; a pair only on the list slots in after the series it fills in.
    expect(crypto.map((row) => row.label)).toEqual(["Bitcoin", "Price", "PEPE-USD · Price"]);
  });

  test("a catalog of thousands of series filters per keystroke in well under a frame", () => {
    const groups = ["Rates", "Credit", "Economy", "Sentiment", "Positioning", "Your series", "Lab"];
    const large = Array.from({ length: 5_000 }, (_, index) => entry({
      id: `bulk:series-${index}`,
      name: `Invented series ${index} ${index % 3 === 0 ? "spread" : "level"}`,
      unit: index % 2 ? "%" : "bp",
      frequency: "daily",
      group: groups[index % groups.length]!,
      tags: [`tag-${index % 50}`],
      load,
    }));
    const built = performance.now();
    const rows = catalogRowsFromEntries(large);
    const buildMs = performance.now() - built;
    expect(catalogTabs(rows)).toHaveLength(groups.length + 1);

    const queries = ["s", "sp", "spr", "spre", "sprea", "spread", "spread 1", "spread 12", "credit spread"];
    const started = performance.now();
    for (const query of queries) filterCatalogRows(rows, "all", query);
    const perQueryMs = (performance.now() - started) / queries.length;
    expect(filterCatalogRows(rows, "Credit", "spread 12").length).toBeGreaterThan(0);
    // Generous bounds for a loaded CI runner; locally these are about 15 ms and 1 ms.
    expect(buildMs).toBeLessThan(400);
    expect(perQueryMs).toBeLessThan(16);
    // A second read of the same registry snapshot is the cached rows.
    expect(catalogRowsFromEntries(large)).toBe(rows);
  });
});

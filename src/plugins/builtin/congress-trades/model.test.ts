import { describe, expect, test } from "bun:test";
import { cloudCongressHousePath } from "../../../api-client/paths";
import type { CloudCongressHousePayload } from "../../../api-client";
import { getTableWidth } from "../../../components/ui/table-layout";
import {
  buildMemberColumns,
  buildMemberTradeColumns,
  buildTradeColumns,
  canLoadMoreCongress,
  congressScanNotice,
  mergeCongressPages,
  nextCongressPage,
  previousCongressYearPage,
  tradeAssetLabel,
} from "./model";

function payload(overrides: Partial<CloudCongressHousePayload> = {}): CloudCongressHousePayload {
  return {
    asOf: "2026-01-01T00:00:00.000Z",
    chamber: "house",
    source: "house-clerk",
    year: 2026,
    indexUpdatedAt: null,
    filingsScanned: 20,
    filingCount: 80,
    filingOffset: 0,
    hasMore: false,
    hasMoreFilings: true,
    nextOffset: 20,
    nextFilingOffset: 20,
    trades: [],
    members: [],
    ...overrides,
  };
}

describe("congress paging", () => {
  test("walks remaining trades, then more filings, then stops", () => {
    expect(nextCongressPage(payload({ hasMore: true, nextOffset: 40 }))).toEqual({
      year: 2026,
      offset: 40,
      filingOffset: 0,
    });
    expect(nextCongressPage(payload({ hasMore: false, hasMoreFilings: true, nextFilingOffset: 20 }))).toEqual({
      year: 2026,
      offset: 0,
      filingOffset: 20,
    });
    expect(nextCongressPage(payload({
      hasMore: false,
      hasMoreFilings: undefined,
      filingOffset: 0,
      filingsScanned: 20,
      filingCount: 80,
    }))).toEqual({
      year: 2026,
      offset: 0,
      filingOffset: 20,
    });
  });

  test("never crosses into an earlier year on its own", () => {
    // Each earlier year is a fresh set of source documents to read.
    expect(nextCongressPage(payload({ hasMore: false, hasMoreFilings: false }))).toBeNull();
    expect(canLoadMoreCongress(payload({ hasMore: false, hasMoreFilings: false }))).toBe(false);
    // A filtered filing window can be empty while a later window has matches.
    expect(nextCongressPage(mergeCongressPages(payload(), payload({
      filingOffset: 20, nextFilingOffset: 40, trades: [],
    })))).toEqual({ year: 2026, offset: 0, filingOffset: 40 });
  });

  test("offers the earlier year only when asked, and only back to 2008", () => {
    expect(previousCongressYearPage(payload({ year: 2026 }))).toEqual({
      year: 2025,
      offset: 0,
      filingOffset: 0,
    });
    expect(previousCongressYearPage(payload({ year: 2008 }))).toBeNull();
  });

  test("names the filings missing from an incomplete window", () => {
    expect(congressScanNotice(payload())).toBeNull();
    expect(congressScanNotice(payload({ filingsFailed: 2 }))).toBe("2 filings unavailable");
    expect(congressScanNotice(payload({ filingsFailed: 1, filingsPending: 3 }))).toBe(
      "4 filings not read yet, retrying later",
    );
    expect(congressScanNotice(payload({ filingsFailed: 1, filingsPaper: 2, senateUnavailable: true }))).toBe(
      "1 filings unavailable · 2 Senate paper filings not read · Senate filings unavailable, showing House only",
    );
    expect(congressScanNotice(payload({ filingsPaper: 1 }))).toBe("1 Senate paper filing not read");
  });

  test("pages keep the chamber they were asked for", () => {
    expect(cloudCongressHousePath({ year: 2026 })).toBe("/cloud/congress/house?year=2026");
    expect(cloudCongressHousePath({ chamber: "all", ...nextCongressPage(payload({ hasMore: true, nextOffset: 5 }))! }))
      .toStartWith("/cloud/congress/all?");
    expect(cloudCongressHousePath({ chamber: "senate", ticker: "NVDA" })).toBe("/cloud/congress/senate?ticker=NVDA");
  });

  test("appends unique trades and members from the next page", () => {
    const merged = mergeCongressPages(
      payload({
        trades: [{ id: "t1" } as CloudCongressHousePayload["trades"][number]],
        members: [{ id: "m1" } as CloudCongressHousePayload["members"][number]],
      }),
      payload({
        year: 2025,
        trades: [
          { id: "t1" } as CloudCongressHousePayload["trades"][number],
          { id: "t2" } as CloudCongressHousePayload["trades"][number],
        ],
        members: [{ id: "m2" } as CloudCongressHousePayload["members"][number]],
      }),
    );
    expect(merged.year).toBe(2025);
    expect(merged.trades.map((trade) => trade.id)).toEqual(["t1", "t2"]);
    expect(merged.members.map((member) => member.id)).toEqual(["m1", "m2"]);
  });
});

describe("congress trade asset label", () => {
  test("reads option terms from Senate and House descriptions", () => {
    const label = (assetName: string, description: string | null, assetType: string | null = "OP") => tradeAssetLabel({ assetName, assetType, description });
    expect(label("Williams Companies, Inc. (The) Common Stock", "Option Type: Call Strike price: $75.00 Expires: 2026-08-21 · All transactions notified to Filer on September 1, 2026"))
      .toBe("CALL $75 exp 2026-08-21 · Williams Companies, Inc. (The)");
    expect(label("Microsoft Corporation - Common Stock", "Call options; Strike price $340; Expires 10/16/2026"))
      .toBe("CALL $340 exp 2026-10-16 · Microsoft Corporation");
    expect(label("Bloom Energy Corporation Class A Common Stock", "Purchased 100 put options with a strike price of $1,100.50 and an expiration date of 6/7/27."))
      .toBe("PUT $1100.5 exp 2027-06-07 · Bloom Energy Corporation Class A");
    expect(label("Apple Inc. - Common Stock", null)).toBe("OPTION · Apple Inc.");
    expect(label("Apple Inc. - Common Stock", "Call options", "ST")).toBe("Apple Inc. - Common Stock");
  });
});

describe("congress return columns", () => {
  const ids = (columns: { id: string }[]) => columns.map((column) => column.id);
  const width = (columns: { id: string; width: number }[], id: string) => columns.find((column) => column.id === id)?.width;

  test("VS SPY sits beside FILE RET%, and TX RET% is the first to give way", () => {
    const wide = buildTradeColumns(160);
    expect(ids(wide).slice(-3)).toEqual(["returnSinceTx", "returnSinceFiling", "excessSinceFiling"]);
    expect(getTableWidth(wide)).toBe(160);
    // TX RET% stays while member names keep 18 cells beside it; a ticker's pane has no ticker column.
    expect(ids(buildTradeColumns(129))).toContain("returnSinceTx");
    expect(ids(buildTradeColumns(128))).toEqual(["filed", "tx", "lag", "member", "side", "ticker", "amount", "owner", "returnSinceFiling", "excessSinceFiling"]);
    expect(ids(buildTradeColumns(116, true))).toContain("returnSinceTx");
    expect(width(buildTradeColumns(115, true), "member")).toBe(28);
    // The default floating pane: the dates lose their year before anything else goes.
    expect(ids(buildTradeColumns(112))).toEqual(ids(buildTradeColumns(128)));
    expect(width(buildTradeColumns(112), "filed")).toBe(7);
  });

  test("a 720 px pane fits every column it keeps, and VS SPY outlasts the rest", () => {
    const all = buildTradeColumns(90);
    expect(ids(all)).toEqual(["filed", "member", "side", "ticker", "amount", "returnSinceFiling", "excessSinceFiling"]);
    expect(getTableWidth(all)).toBe(90);
    const ticker = buildTradeColumns(90, true);
    expect(ids(ticker)).toEqual(["filed", "tx", "member", "side", "amount", "returnSinceFiling", "excessSinceFiling"]);
    expect(getTableWidth(ticker)).toBe(90);
    expect(ids(buildTradeColumns(80)).slice(-2)).toEqual(["amount", "excessSinceFiling"]);
  });

  test("members put the median against SPY beside the median return, which gives way first", () => {
    const wide = buildMemberColumns(160);
    expect(ids(wide).slice(-3)).toEqual(["medianReturn", "medianExcessSinceFiling", "buyHitRate"]);
    expect(getTableWidth(wide)).toBe(160);
    expect(ids(buildMemberColumns(112))).not.toContain("medianReturn");
    expect(ids(buildMemberColumns(112)).slice(-2)).toEqual(["medianExcessSinceFiling", "buyHitRate"]);
    const narrow = buildMemberColumns(90);
    expect(ids(narrow)).toEqual(["member", "party", "trades", "buys", "sells", "range", "medianExcessSinceFiling"]);
    expect(getTableWidth(narrow)).toBe(90);
  });

  test("a member's trades end on VS SPY, and their own lag goes before it", () => {
    expect(ids(buildMemberTradeColumns(160)).slice(-2)).toEqual(["lag", "excessSinceFiling"]);
    const narrow = buildMemberTradeColumns(90);
    expect(ids(narrow)).toEqual(["filed", "tx", "side", "ticker", "amount", "asset", "excessSinceFiling"]);
    expect(getTableWidth(narrow)).toBe(90);
  });
});

import { describe, expect, test } from "bun:test";
import type { CloudCdsResponse } from "../../../api-client";
import type { InstrumentSearchResult } from "../../../types/instrument";
import { loadCdsActivity, loadCdsSpreadHistory, loadCdsSpreadLevels } from "./client";

function result(symbol: string, name: string): InstrumentSearchResult {
  return { providerId: "gloomberb-cloud", symbol, name, exchange: "NYSE", type: "STK" };
}

const EMPTY_CDS: CloudCdsResponse = { source: "DTCC PPD", asOf: null, trades: [] };

/** Records what the loader searched for and what it then asked the backend. */
function spy(searchResults: InstrumentSearchResult[] | Error = []) {
  const searched: string[] = [];
  const requested: Array<string | undefined> = [];
  return {
    searched,
    requested,
    fetchCds: async (params: { issuer?: string }) => {
      requested.push(params.issuer);
      return EMPTY_CDS;
    },
    searchInstruments: async (query: string) => {
      searched.push(query);
      if (searchResults instanceof Error) throw searchResults;
      return searchResults;
    },
  };
}

describe("loadCdsActivity", () => {
  test("expands a bare ticker through search before requesting CDS", async () => {
    // A near-miss is returned first, so first-result-wins would send the wrong name.
    const calls = spy([result("ORCL.MX", "Oracle de Mexico"), result("ORCL", "Oracle Corporation")]);

    const activity = await loadCdsActivity("ORCL", calls.fetchCds, calls.searchInstruments);

    expect(calls.searched).toEqual(["ORCL"]);
    expect(calls.requested).toEqual(["Oracle Corporation"]);
    // The pane body reads this back, so ORCL must not survive resolution.
    expect(activity.issuer).toBe("Oracle Corporation");
  });

  test("asks for the issuer a listing stands for, not its share class", async () => {
    // The tape names issuers: "alphabet class a common stock" matches no trade.
    for (const [symbol, listing, issuer] of [
      ["GOOGL", "Alphabet Inc. Class A Common Stock", "Alphabet Inc."],
      ["MSFT", "Microsoft Corporation Common Stock", "Microsoft Corporation"],
      ["TSM", "Taiwan Semiconductor Manufacturing Company Ltd. American Depositary Shares", "Taiwan Semiconductor Manufacturing Company Ltd."],
      ["BRK.B", "Berkshire Hathaway Inc. Class B", "Berkshire Hathaway Inc."],
    ] as const) {
      const calls = spy([result(symbol, listing)]);
      await loadCdsActivity(symbol, calls.fetchCds, calls.searchInstruments);
      expect(calls.requested).toEqual([issuer]);
    }
  });

  test("prefers the primary US common stock when exchanges reuse a ticker", async () => {
    const cedear = {
      ...result("ORCL", "Oracle Corp. - CEDEAR"),
      exchange: "BYMA",
      primaryExchange: "BYMA",
      type: "Depositary Receipt",
      currency: "ARS",
    };
    const primary = {
      ...result("ORCL", "Oracle Corporation"),
      currency: "USD",
      primaryExchange: "NYSE",
    };
    const calls = spy([cedear, primary]);

    await loadCdsActivity("ORCL", calls.fetchCds, calls.searchInstruments);

    expect(calls.requested).toEqual(["Oracle Corporation"]);
  });

  test("falls back to the first result when no symbol matches exactly", async () => {
    const calls = spy([result("AVGO", "Broadcom Inc."), result("AVGOP", "Broadcom Preferred")]);

    await loadCdsActivity("BRCM", calls.fetchCds, calls.searchInstruments);

    expect(calls.requested).toEqual(["Broadcom Inc."]);
  });

  test("sends a company name straight through without searching", async () => {
    const calls = spy([result("ORCL", "Oracle Corporation")]);

    const activity = await loadCdsActivity("Tencent Holdings Limited", calls.fetchCds, calls.searchInstruments);

    expect(calls.searched).toEqual([]);
    expect(calls.requested).toEqual(["Tencent Holdings Limited"]);
    expect(activity.issuer).toBe("Tencent Holdings Limited");
  });

  test("keeps the raw ticker when search is empty or fails", async () => {
    const empty = spy([]);
    await loadCdsActivity("ORCL", empty.fetchCds, empty.searchInstruments);
    expect(empty.requested).toEqual(["ORCL"]);

    // A search outage must not also take out the CDS request.
    const broken = spy(new Error("search unavailable"));
    const activity = await loadCdsActivity("ORCL", broken.fetchCds, broken.searchInstruments);
    expect(broken.requested).toEqual(["ORCL"]);
    expect(activity.issuer).toBe("ORCL");
  });

  test("market-wide load searches nothing and sends no issuer", async () => {
    const calls = spy([result("ORCL", "Oracle Corporation")]);

    const activity = await loadCdsActivity(null, calls.fetchCds, calls.searchInstruments);

    expect(calls.searched).toEqual([]);
    expect(calls.requested).toEqual([undefined]);
    expect(activity.issuer).toBeNull();
  });
});

describe("loadCdsSpreadHistory", () => {
  test("asks for two years and returns valid levels oldest first", async () => {
    const requested: unknown[] = [];
    const history = await loadCdsSpreadHistory("Oracle Corporation", async (params) => {
      requested.push(params);
      return {
        source: "DTCC PPD",
        issuer: "Oracle Corporation",
        tenor: "5Y",
        currency: "USD",
        asOf: null,
        points: [
          { date: "2026-09-25", spreadBp: 235, prints: 10, reported: 6, maturity: "2031-12-20" },
          { date: "2026-09-24", spreadBp: 228, prints: 21, reported: 3, maturity: "2031-12-20" },
          { date: "bad", spreadBp: 1, prints: 1, reported: 0, maturity: "2031-12-20" },
          { date: "2026-09-23", spreadBp: Number.NaN, prints: 1, reported: 0, maturity: "2031-12-20" },
        ],
        change1W: 7.5,
        change1M: 75.4,
      };
    });
    expect(requested).toEqual([{ issuer: "Oracle Corporation", days: 730 }]);
    expect(history.issuer).toBe("Oracle Corporation");
    expect(history.points.map((point) => point.date)).toEqual(["2026-09-24", "2026-09-25"]);
    expect([history.change1W, history.change1M, history.noLevelReason]).toEqual([7.5, 75.4, null]);
  });

  test("reads moves a server before them leaves out as none, and only a reason the view can word", async () => {
    const response = { source: "DTCC PPD", issuer: "Barclays PLC", tenor: "5Y", currency: "EUR", asOf: null, points: [] };
    const older = await loadCdsSpreadHistory("Barclays PLC", async () => response);
    expect([older.change1W, older.change1M, older.noLevelReason]).toEqual([null, null, null]);
    const unknown = await loadCdsSpreadHistory("Barclays PLC", async () => ({ ...response, noLevelReason: "something-new" }));
    expect(unknown.noLevelReason).toBeNull();
    const sideless = await loadCdsSpreadHistory("Barclays PLC", async () => ({ ...response, noLevelReason: "upfront-side-unknown" }));
    expect(sideless.noLevelReason).toBe("upfront-side-unknown");
  });
});

describe("loadCdsSpreadLevels", () => {
  test("reads every issuer's level in one request and keys it as the list keys issuers", async () => {
    let requests = 0;
    const levels = await loadCdsSpreadLevels(async () => {
      requests += 1;
      return {
        source: "DTCC PPD",
        tenor: "5Y",
        asOf: null,
        levels: [
          { issuer: "Amazon.com;Inc.", spreadBp: 73, date: "2026-10-09", change1W: 3, change1M: 5.8 },
          // A server before the moves sends none.
          { issuer: "Ford Motor Company", spreadBp: 157, date: "2026-10-09" },
          // Two names the backend keeps apart fold into one row; the list's spelling keeps it.
          { issuer: "ORACLE COP", spreadBp: 240, date: "2026-10-02" },
          { issuer: "Oracle Corporation", spreadBp: 205, date: "2026-10-08", change1W: null, change1M: 75.4 },
          { issuer: "Broken Ltd", spreadBp: Number.NaN, date: "2026-10-09" },
        ],
      };
    });
    expect(requests).toBe(1);
    expect(Object.fromEntries(levels)).toEqual({
      "amazon com": { spreadBp: 73, date: "2026-10-09", change1wBp: 3, change1mBp: 5.8 },
      "ford motor": { spreadBp: 157, date: "2026-10-09", change1wBp: null, change1mBp: null },
      oracle: { spreadBp: 205, date: "2026-10-08", change1wBp: null, change1mBp: 75.4 },
    });
  });
});

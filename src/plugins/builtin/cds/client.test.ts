import { describe, expect, test } from "bun:test";
import type { CloudCdsResponse } from "../../../api-client";
import type { InstrumentSearchResult } from "../../../types/instrument";
import { loadCdsActivity, loadCdsSpreadHistory } from "./client";

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
      };
    });
    expect(requested).toEqual([{ issuer: "Oracle Corporation", days: 730 }]);
    expect(history.issuer).toBe("Oracle Corporation");
    expect(history.points.map((point) => point.date)).toEqual(["2026-09-24", "2026-09-25"]);
  });
});

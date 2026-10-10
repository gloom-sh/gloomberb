import { expect, test } from "bun:test";
import { companyDisclosurePath } from "./company-kpis";
import {
  cloudEarningsCallsPath, cloudSecFilingsPath, normalizeIssuerResearchTicker,
  cloudFilingEventsPath, cloudProxyStatementPath, cloudProxyStatementsPath,
  cloudRiskReportPath, cloudRiskReportsPath, cloudDebtMaturitiesPath, cloudRevenueBreakdownPath,
  cloudSecBeneficialOwnersPath,
} from "./paths";

test("issuer research paths accept explicit US listing aliases without changing issuer symbol content", () => {
  for (const [key, issuer] of [
    [" aapl:XNAS ", "AAPL"], ["MSFT:NASDAQ", "MSFT"], ["BRK.B:XNYS", "BRK.B"],
    ["SPY:PCX", "SPY"], ["SPY:ARCX", "SPY"], ["IWM:AMEX", "IWM"], ["TEST:BATS", "TEST"],
    ["AAPL:NASDAQ:XNAS", "AAPL"], ["BABA:XNYS", "BABA"], ["VOD.L:XNAS", "VOD.L"],
  ]) {
    const encoded = encodeURIComponent(issuer!);
    // A US listing sends nothing about its venue or company, even when the caller knows them.
    const listing = { exchange: "NASDAQ", name: "Ignored Inc." };
    expect(cloudProxyStatementsPath(key!, listing)).toBe(`/cloud/proxies/${encoded}`);
    expect(cloudProxyStatementPath(key!, 2026, listing)).toBe(`/cloud/proxies/${encoded}/2026`);
    expect(cloudRiskReportsPath(key!, listing)).toBe(`/cloud/risks/${encoded}`);
    expect(cloudRiskReportPath(key!, 2025, listing)).toBe(`/cloud/risks/${encoded}/2025`);
    expect(cloudFilingEventsPath(key!, 7, listing)).toBe(`/cloud/events/${encoded}?limit=7`);
    expect(cloudSecBeneficialOwnersPath({ ticker: key!, ...listing })).toBe(`/cloud/sec/beneficial-owners?ticker=${encoded}`);
    expect(cloudEarningsCallsPath({ ticker: key!, limit: 3, offset: 2 })).toBe(`/cloud/transcripts?ticker=${encoded}&limit=3&offset=2`);
    expect(cloudSecFilingsPath({ ticker: key!, limit: 5 })).toBe(`/cloud/sec/filings?ticker=${encoded}&limit=5`);
  }
});

test("issuer research never infers a US issuer from foreign, unknown or routing venues", () => {
  for (const key of ["SHOP:XTSE", "ASML:XAMS", "7203:JPX", "BABA:XHKG", "VOD.L", "VOD.L:XLON", "SAP.DE", "AAPL:SMART", "AAPL:UNKNOWN", "AAPL:US", "AAPL", "BRK.B"]) {
    expect(normalizeIssuerResearchTicker(key)).toBe(key);
  }
  // No venue, or a routing destination, keeps the key whole.
  for (const key of ["VOD.L", "SAP.DE", "AAPL:SMART", "AAPL", "BRK.B"]) {
    expect(cloudProxyStatementsPath(key)).toBe(`/cloud/proxies/${encodeURIComponent(key)}`);
  }
});

test("issuer reads of a listing outside the US send its bare symbol with its venue and company", () => {
  const sanofi = { exchange: "EPA", name: "Sanofi" };
  expect(cloudRiskReportsPath("SAN", sanofi)).toBe("/cloud/risks/SAN?exchange=EPA&name=Sanofi");
  expect(cloudRiskReportPath("SAN", 2026, sanofi)).toBe("/cloud/risks/SAN/2026?exchange=EPA&name=Sanofi");
  expect(cloudProxyStatementsPath("SAN", sanofi)).toBe("/cloud/proxies/SAN?exchange=EPA&name=Sanofi");
  expect(cloudProxyStatementPath("SAN", 2026, sanofi)).toBe("/cloud/proxies/SAN/2026?exchange=EPA&name=Sanofi");
  expect(cloudFilingEventsPath("SAN", 50, sanofi)).toBe("/cloud/events/SAN?exchange=EPA&name=Sanofi&limit=50");
  expect(cloudDebtMaturitiesPath("SAN", sanofi)).toBe("/cloud/debt-maturities?symbol=SAN&exchange=EPA&name=Sanofi");
  expect(cloudRevenueBreakdownPath("SAN", undefined, sanofi)).toBe("/cloud/revenue-breakdown?symbol=SAN&exchange=EPA&name=Sanofi");
  expect(cloudSecBeneficialOwnersPath({ ticker: "SAN", ...sanofi })).toBe("/cloud/sec/beneficial-owners?ticker=SAN&exchange=EPA&name=Sanofi");

  // The key's own venue counts the same, in any spelling, and wins over a saved one.
  expect(cloudRiskReportsPath("SAN:XPAR", { exchange: "NYSE", name: " Sanofi " })).toBe("/cloud/risks/SAN?exchange=EPA&name=Sanofi");
  expect(cloudRevenueBreakdownPath("san:epa", "segment", { name: "Sanofi" }))
    .toBe("/cloud/revenue-breakdown?symbol=SAN&exchange=EPA&name=Sanofi&view=segment");
  expect(cloudSecBeneficialOwnersPath({ ticker: "SAN:EPA", name: "Sanofi", form: "13G", limit: 100, offset: 0 }))
    .toBe("/cloud/sec/beneficial-owners?ticker=SAN&exchange=EPA&name=Sanofi&form=13G&limit=100&offset=0");

  // Without a name only the venue goes; the server then reads the name of a quote it holds.
  expect(cloudRiskReportsPath("SAN:EPA")).toBe("/cloud/risks/SAN?exchange=EPA");
  expect(cloudFilingEventsPath("AI", 50, { exchange: "XPAR", name: "  " })).toBe("/cloud/events/AI?exchange=EPA&limit=50");
  expect(cloudDebtMaturitiesPath("SAN", { exchange: "EPA" })).toBe("/cloud/debt-maturities?symbol=SAN&exchange=EPA");
  expect(cloudSecBeneficialOwnersPath({ ticker: "7203:JPX" })).toBe("/cloud/sec/beneficial-owners?ticker=7203&exchange=JPX");

  // A name is a query value: spaces, dots, apostrophes and ampersands survive the trip.
  const names = ["L'Air Liquide S.A.", "Procter & Gamble", "Banco Bilbao Vizcaya Argentaria, S.A."];
  for (const name of names) {
    const path = cloudProxyStatementPath("AI", 2025, { exchange: "EPA", name });
    expect(path.startsWith("/cloud/proxies/AI/2025?exchange=EPA&name=")).toBe(true);
    expect(new URL(path, "https://example.test").searchParams.get("name")).toBe(name);
  }
  expect(cloudRiskReportsPath("AI", { exchange: "EPA", name: "L'Air Liquide S.A." }))
    .toBe("/cloud/risks/AI?exchange=EPA&name=L%27Air+Liquide+S.A.");
});

test("debt maturities and the revenue breakdown keep a US request exactly as it was", () => {
  for (const [symbol, exchange, encoded] of [
    ["AAPL", undefined, "AAPL"], ["AAPL", "NASDAQ", "AAPL"], ["AAPL:XNAS", undefined, "AAPL%3AXNAS"],
    ["SAN", "NYSE", "SAN"], ["BRK.B", "SMART", "BRK.B"],
  ]) {
    const listing = { exchange, name: "Ignored Inc." };
    expect(cloudDebtMaturitiesPath(symbol!, listing)).toBe(`/cloud/debt-maturities?symbol=${encoded}`);
    expect(cloudRevenueBreakdownPath(symbol!, "product", listing)).toBe(`/cloud/revenue-breakdown?symbol=${encoded}&view=product`);
    expect(cloudRevenueBreakdownPath(symbol!)).toBe(`/cloud/revenue-breakdown?symbol=${encoded}`);
  }
});

test("SEC filings send a non-US listing's bare symbol with its venue and name, and keep the US lookup as it was", () => {
  const params = (path: string) => Object.fromEntries(new URL(path, "https://example.test").searchParams);
  // Old backends ignore the venue and answer with the US registrant; the name lets the new one resolve it.
  expect(params(cloudSecFilingsPath({ ticker: "SAN:EPA", name: " Sanofi ", limit: 5 })))
    .toEqual({ ticker: "SAN", limit: "5", exchange: "EPA", name: "Sanofi" });
  expect(params(cloudSecFilingsPath({ ticker: "SAN", exchange: "XPAR", name: "Sanofi" })))
    .toEqual({ ticker: "SAN", exchange: "EPA", name: "Sanofi" });
  for (const [key, symbol, venue] of [
    ["SHOP:XTSE", "SHOP", "TSX"], ["7203:JPX", "7203", "JPX"], ["VOD.L:XLON", "VOD.L", "LSE"], ["AAPL:UNKNOWN", "AAPL", "UNKNOWN"],
  ]) {
    expect(params(cloudSecFilingsPath({ ticker: key! }))).toEqual({ ticker: symbol!, exchange: venue! });
  }
  // US venues, routing destinations and unqualified symbols keep the exact URL old clients cached.
  for (const [ticker, exchange, path] of [
    ["AAPL", "NASDAQ", "/cloud/sec/filings?ticker=AAPL&limit=5"], ["AAPL:XNAS", undefined, "/cloud/sec/filings?ticker=AAPL&limit=5"],
    ["SAN", "NYQ", "/cloud/sec/filings?ticker=SAN&limit=5"], ["AAPL", "SMART", "/cloud/sec/filings?ticker=AAPL&limit=5"],
    ["AAPL:SMART", undefined, "/cloud/sec/filings?ticker=AAPL%3ASMART&limit=5"], ["VOD.L", undefined, "/cloud/sec/filings?ticker=VOD.L&limit=5"],
  ]) {
    expect(cloudSecFilingsPath({ ticker: ticker!, exchange, name: "Ignored Inc.", limit: 5 })).toBe(path!);
  }
});

type IssuerLookup = (ticker: string, exchange?: string, name?: string) => string;
const ISSUER_LOOKUPS: Record<string, IssuerLookup> = {
  calls: (ticker, exchange, name) => cloudEarningsCallsPath({ ticker, exchange, name, limit: 5 }),
  kpis: (ticker, exchange, name) => companyDisclosurePath("kpis", ticker, {}, { exchange, name }),
  guidance: (ticker, exchange, name) => companyDisclosurePath("guidance", ticker, { metric: "revenue" }, { exchange, name }),
};

/** The symbol a lookup asks about, from its path or its `ticker` query, with the rest of the query. */
function sentListing(path: string) {
  const url = new URL(path, "https://example.test");
  const { limit: _limit, metric: _metric, ticker, ...rest } = Object.fromEntries(url.searchParams);
  return { symbol: ticker ?? decodeURIComponent(url.pathname.split("/").at(-1)!), ...rest };
}

test("calls, KPIs and guidance ask for a listing abroad by its bare symbol, venue and company", () => {
  for (const [kind, lookup] of Object.entries(ISSUER_LOOKUPS)) {
    // AI in Paris is Air Liquide; AI in New York is C3.ai.
    for (const [ticker, exchange] of [["AI", "EPA"], ["AI:EPA", undefined], ["AI:XPAR", "NYSE"], ["AI", "XPAR"]]) {
      expect({ kind, ...sentListing(lookup(ticker!, exchange, " Air Liquide S.A. ")) })
        .toEqual({ kind, symbol: "AI", exchange: "EPA", name: "Air Liquide S.A." });
    }
    expect({ kind, ...sentListing(lookup("BP", "XLON", "BP p.l.c.")) }).toEqual({ kind, symbol: "BP", exchange: "LSE", name: "BP p.l.c." });
    // Without its company the venue still keeps the listing apart from the US symbol.
    expect({ kind, ...sentListing(lookup("BP:LSE")) }).toEqual({ kind, symbol: "BP", exchange: "LSE" });
  }
  expect(cloudEarningsCallsPath({ ticker: "AI", exchange: "EPA", name: "Air Liquide S.A.", limit: 50 }))
    .toBe("/cloud/transcripts?ticker=AI&exchange=EPA&name=Air+Liquide+S.A.&limit=50");
  expect(companyDisclosurePath("kpis", "AI:EPA", { asOf: "2026-06-30" }, { name: "Air Liquide S.A." }))
    .toBe("/cloud/company-kpis/AI?asOf=2026-06-30&exchange=EPA&name=Air+Liquide+S.A.");
});

test("calls, KPIs and guidance keep the exact lookup old clients sent for a US listing or a bare symbol", () => {
  for (const [ticker, exchange, calls, disclosures] of [
    ["AI", undefined, "ticker=AI", "AI"], ["AI", "NYSE", "ticker=AI", "AI"], ["AI:XNYS", undefined, "ticker=AI", "AI%3AXNYS"],
    ["AAPL", "SMART", "ticker=AAPL", "AAPL"], ["AAPL:SMART", undefined, "ticker=AAPL%3ASMART", "AAPL%3ASMART"], ["VOD.L", undefined, "ticker=VOD.L", "VOD.L"],
  ]) {
    expect(ISSUER_LOOKUPS.calls!(ticker!, exchange, "Ignored Inc.")).toBe(`/cloud/transcripts?${calls}&limit=5`);
    expect(ISSUER_LOOKUPS.kpis!(ticker!, exchange, "Ignored Inc.")).toBe(`/cloud/company-kpis/${disclosures}?`);
    expect(ISSUER_LOOKUPS.guidance!(ticker!, exchange, "Ignored Inc.")).toBe(`/cloud/company-guidance/${disclosures}?metric=revenue`);
  }
  expect(cloudEarningsCallsPath({ limit: 50, includePending: true })).toBe("/cloud/transcripts?limit=50&includePending=true");
});

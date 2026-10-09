import { expect, test } from "bun:test";
import {
  cloudEarningsCallsPath, cloudSecFilingsPath, normalizeIssuerResearchTicker,
  cloudFilingEventsPath, cloudProxyStatementPath, cloudProxyStatementsPath,
  cloudRiskReportPath, cloudRiskReportsPath,
} from "./paths";

test("issuer research paths accept explicit US listing aliases without changing issuer symbol content", () => {
  for (const [key, issuer] of [
    [" aapl:XNAS ", "AAPL"], ["MSFT:NASDAQ", "MSFT"], ["BRK.B:XNYS", "BRK.B"],
    ["SPY:PCX", "SPY"], ["SPY:ARCX", "SPY"], ["IWM:AMEX", "IWM"], ["TEST:BATS", "TEST"],
    ["AAPL:NASDAQ:XNAS", "AAPL"], ["BABA:XNYS", "BABA"], ["VOD.L:XNAS", "VOD.L"],
  ]) {
    const encoded = encodeURIComponent(issuer!);
    expect(cloudProxyStatementsPath(key!)).toBe(`/cloud/proxies/${encoded}`);
    expect(cloudProxyStatementPath(key!, 2026)).toBe(`/cloud/proxies/${encoded}/2026`);
    expect(cloudRiskReportsPath(key!)).toBe(`/cloud/risks/${encoded}`);
    expect(cloudRiskReportPath(key!, 2025)).toBe(`/cloud/risks/${encoded}/2025`);
    expect(cloudFilingEventsPath(key!, 7)).toBe(`/cloud/events/${encoded}?limit=7`);
    expect(cloudEarningsCallsPath({ ticker: key!, limit: 3, offset: 2 })).toBe(`/cloud/transcripts?ticker=${encoded}&limit=3&offset=2`);
    expect(cloudSecFilingsPath({ ticker: key!, limit: 5 })).toBe(`/cloud/sec/filings?ticker=${encoded}&limit=5`);
  }
});

test("issuer research never infers a US issuer from foreign, unknown or routing venues", () => {
  for (const key of ["SHOP:XTSE", "ASML:XAMS", "7203:JPX", "BABA:XHKG", "VOD.L", "VOD.L:XLON", "SAP.DE", "AAPL:SMART", "AAPL:UNKNOWN", "AAPL:US", "AAPL", "BRK.B"]) {
    expect(normalizeIssuerResearchTicker(key)).toBe(key);
    expect(cloudProxyStatementsPath(key)).toBe(`/cloud/proxies/${encodeURIComponent(key)}`);
    expect(new URL(cloudEarningsCallsPath({ ticker: key }), "https://example.test").searchParams.get("ticker")).toBe(key);
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

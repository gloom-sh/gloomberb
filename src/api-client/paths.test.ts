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
    expect(new URL(cloudSecFilingsPath({ ticker: key }), "https://example.test").searchParams.get("ticker")).toBe(key);
    expect(new URL(cloudEarningsCallsPath({ ticker: key }), "https://example.test").searchParams.get("ticker")).toBe(key);
  }
});

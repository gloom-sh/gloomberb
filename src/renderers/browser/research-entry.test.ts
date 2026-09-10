import { expect, test } from "bun:test";
import { researchEntryFromSearch } from "./research-entry";

test("normalizes ticker links while rejecting commands and invalid tab paths", () => {
  expect(researchEntryFromSearch("?ticker=brk.b&tab=earnings-calls")).toEqual({ symbol: "BRK.B", tab: "earnings-calls" });
  expect(researchEntryFromSearch("?ticker=NVDA&tab=../../bad")).toEqual({ symbol: "NVDA", tab: "overview" });
  for (const search of ["", "?ticker=", "?ticker=NVDA%20%3B%20rm", "?ticker=%3Cscript%3E"]) expect(researchEntryFromSearch(search)).toBeNull();
});

test("venue-qualified browser entries preserve listing identity and explicit symbol precedence", () => {
  expect(researchEntryFromSearch("?ticker=vod&exchange=lse&tab=financials"))
    .toEqual({ symbol: "VOD:XLON", tab: "financials" });
  expect(researchEntryFromSearch("?ticker=BRK.B&exchange=NYSE"))
    .toEqual({ symbol: "BRK.B:XNYS", tab: "overview" });
  expect(researchEntryFromSearch("?ticker=ASML.AS&exchange=NASDAQ"))
    .toEqual({ symbol: "ASML.AS", tab: "overview" });
  expect(researchEntryFromSearch("?ticker=VOD%3AXLON&exchange=JSE"))
    .toEqual({ symbol: "VOD:XLON", tab: "overview" });
  expect(researchEntryFromSearch("?ticker=VOD&exchange=LSE%3Bbad")).toBeNull();
});

test("crypto pair links survive the URL writer's slash and spaced venue round trip", () => {
  for (const ticker of ["SHIB/USD", "SHIB/USD:COINBASE PRO"]) {
    const params = new URLSearchParams({ ticker, exchange: "COINBASE PRO", tab: "chart" });
    expect(researchEntryFromSearch(params.toString())).toEqual({ symbol: "SHIB/USD:COINBASE PRO", tab: "chart" });
  }
  expect(researchEntryFromSearch("?ticker=SHIB-USD&exchange=CCC"))
    .toEqual({ symbol: "SHIB-USD:CCC", tab: "overview" });
  for (const ticker of ["SHIB/USD/OTHER", "../USD", "SHIB/USD:COINBASE;BAD", "SHIB/USD:COINBASE\nPRO"]) {
    expect(researchEntryFromSearch(new URLSearchParams({ ticker }).toString())).toBeNull();
  }
});

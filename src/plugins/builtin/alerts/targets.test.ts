import { expect, test } from "bun:test";
import { createEventAlert } from "./events";
import { createResearchAlert } from "./research-builder";
import { alertTarget, deliveredAlertSubject, eventRuleSubject, priceRuleSubject, type AlertTarget } from "./targets";

const des = (symbol: string, exchange?: string): AlertTarget => ({ kind: "description", symbol, ...(exchange ? { exchange } : {}) });
const pane = (templateId: string, options?: object): AlertTarget => ({ kind: "pane", templateId, ...(options ? { options } : {}) });
const research = (kind: string, fields: Record<string, string>) =>
  alertTarget(eventRuleSubject(createResearchAlert(kind, Object.fromEntries(Object.entries(fields).map(([key, value]) => [`${kind}:${key}`, value])))));

test("every rule kind opens what it follows", () => {
  const event = (templateId: string, value = "") => alertTarget(eventRuleSubject(createEventAlert(templateId, value)));
  expect([
    alertTarget(priceRuleSubject({ id: "p", symbol: "NET", exchange: "LSE", condition: "above", targetPrice: 1, createdAt: 1, status: "active" })),
    event("catalyst-watched"), event("catalyst-ticker", "pfe"), event("catalyst-type", "clinical"), event("catalyst-agency", "FDA"), event("catalyst-country", "us"),
    event("congress-watched"), event("congress-member", "Nancy Pelosi"), event("thirteenf-fund", "1067983"),
  ]).toEqual([
    des("NET", "LSE"),
    pane("catalysts-pane"), pane("catalysts-pane", { symbol: "PFE" }), pane("catalysts-pane"), pane("catalysts-pane"), pane("catalysts-pane"),
    pane("congress-trades-pane"), pane("congress-trades-pane"), pane("thirteenf-funds-pane", { arg: "0001067983" }),
  ]);
  // Research rules name a US venue, or `US` for any of them, which names no listing.
  expect([
    research("perps_threshold", { marketId: "hyperliquid:xyz:AAPL", metric: "premium", threshold: "1" }),
    research("earnings_date", { symbol: "CRWV", exchange: "US" }),
    research("macro_event", { event: "cpi" }), research("macro_event", { event: "fomc" }),
    research("calendar_event", { event: "NBS Manufacturing PMI", country: "CN" }),
    research("filing_type", { symbol: "AAPL", exchange: "NASDAQ" }),
    research("news_keyword", { symbol: "AAPL", keyword: "buyback" }), research("news_keyword", { keyword: "buyback" }),
    research("analyst_change", { symbol: "AAPL" }), research("fifty_two_week", { symbol: "AAPL" }), research("unusual_volume", { symbol: "AAPL" }),
    research("short_interest_change", { symbol: "AAPL" }), research("insider_trade", { symbol: "AAPL" }),
    research("iv_spike", { contract: "AAPL261016C00300000" }),
    research("options_flow", { symbol: "NVDA" }), research("options_flow", {}),
  ]).toEqual([
    pane("perps-pane", { arg: "hyperliquid:xyz:AAPL" }),
    pane("earnings-calendar-pane", { arg: "CRWV" }),
    pane("cpi-pane"), pane("rate-path-pane"),
    pane("econ-calendar-pane", { arg: "CN" }),
    des("AAPL", "NASDAQ"),
    des("AAPL"), pane("research-search-pane", { arg: "buyback" }),
    des("AAPL"), des("AAPL"), des("AAPL"), des("AAPL"), des("AAPL"),
    des("AAPL"),
    des("NVDA"), pane("scanner-flow-pane"),
  ]);
});

test("a delivered alert opens what its notification is about", () => {
  const delivered = (kind: string, data?: Record<string, unknown>) =>
    alertTarget(deliveredAlertSubject({ id: kind, kind, title: "", body: "", deliveredAt: "2026-10-11T00:00:00Z", data }));
  expect([
    delivered("price", { symbol: "AAPL", exchange: "NASDAQ" }), delivered("earnings", { symbol: "CRWV" }),
    delivered("breaking_news", { symbol: "TSLA", storyId: "s" }), delivered("breaking_news", { storyId: "s" }),
    delivered("thirteenf_filing", { cik: "0001067983" }), delivered("congress_trade", { symbol: "NVDA" }),
    delivered("perps_threshold", { marketId: "binance:default:BTC" }), delivered("unusual_volume", { symbol: "AMD" }),
    // Pushes that carry nothing to open, and an older server that sent no payload.
    delivered("thesis", { thesisId: "t" }), delivered("unusual_volume"),
  ]).toEqual([
    des("AAPL", "NASDAQ"), pane("earnings-calendar-pane", { arg: "CRWV" }),
    des("TSLA"), pane("news-breaking-pane"),
    pane("thirteenf-funds-pane", { arg: "0001067983" }), pane("congress-trades-pane"),
    pane("perps-pane", { arg: "binance:default:BTC" }), des("AMD"),
    null, null,
  ]);
});

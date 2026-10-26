import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, useCallback, useState } from "react";
import { apiClient } from "../../../api-client";
import type { FuturesContract, FuturesCurveAsOfPayload, FuturesCurvePayload } from "../../../api-client/futures-curve";
import type { DataProvider } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import { colors } from "../../../theme/colors";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { futuresCurveCache } from "./client";
import { FuturesCurvePane } from "./pane";

const first: FuturesContract = { symbol: "ESZ26.CME", label: "Dec 2026", expiration: "2026-12-18",
  price: 6600, asOf: "2026-09-22T15:00:00Z", currency: "USD", quoteUnit: "index points", volume: 1000, openInterest: 5000, delayMinutes: 10,
  stale: false, percentile: 50, samples: 200, historyStart: "2025-09-22", historyEnd: "2026-09-21" };
const CONTRACTS = ["ESZ26", "ESH27", "ESM27", "ESU27", "ESZ27", "ESH28", "ESM28", "ESU28"].map((code, index) => ({ ...first,
  symbol: `${code}.CME`, expiration: new Date(Date.UTC(2026, 11 + index * 3, 18)).toISOString().slice(0, 10), price: 6600 + index * 40 }));
// Listed, but past any chart horizon: the Contracts tab shows it, the Curve tab does not.
const FAR: FuturesContract = { ...first, symbol: "ESZ40.CME", expiration: "2040-12-21", price: 9000 };
function payload(contracts: FuturesContract[] = CONTRACTS): FuturesCurvePayload {
  return { root: "ES", name: "E-mini S&P 500", source: "gloom", currency: "USD", quoteUnit: "index points", asOf: first.asOf,
    fetchedAt: "2026-09-22T15:05:00Z", status: "available", stale: false,
    catalogue: { method: "bounded-search", complete: true, horizonEnd: "2029-09-01" }, contracts,
    ghosts: [{ label: "1W", requestedDate: "2026-09-15", asOf: "2026-09-15", points: contracts.map((row) => ({
      symbol: row.symbol, expiration: row.expiration, price: row.price! - 50, asOf: "2026-09-15" })) },
    { label: "1M", requestedDate: "2026-08-22", asOf: "2026-08-22", points: contracts.map((row) => ({
      symbol: row.symbol, expiration: row.expiration, price: row.price! + 25, asOf: "2026-08-22" })) }],
    slope: { frontSymbol: "ESZ26.CME", nextSymbol: "ESH27.CME", value: 40, annualizedRollYield: 2.4, percentile: 60, rollPercentile: 55,
      samples: 200, historyStart: "2025-09-22", historyEnd: "2026-09-21", asOf: first.asOf, state: "contango" },
    gaps: [],
  };
}

const tui = createOpenTuiTestHarness();
let spy: { mockRestore(): void } | undefined;
afterEach(() => {
  spy?.mockRestore(); spy = undefined;
  // Each test serves its own curve rather than the last one's cached copy.
  futuresCurveCache.reset();
});

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await tui.setup().renderOnce(); });
}

interface RenderOptions {
  root?: string;
  asOfDate?: string;
  /** Answers the terminal's quote path, which names the crypto basis's spot in the footer. */
  quote?: (symbol: string) => Promise<Quote>;
  /** Answers the history path, whose one-minute bars price each crypto trade's own minute. */
  bars?: DataProvider["getPriceHistoryForResolutionWithMetadata"];
}

async function render(width: number, height: number, tab = "curve", options: RenderOptions = {}): Promise<string[]> {
  await tui.destroy();
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-futures-curve-test", { instanceId: "ctm", paneId: "futures-curve", binding: { kind: "none" },
    ...options.root ? { params: { root: options.root } } : {}, ...options.asOfDate ? { settings: { asOfDate: options.asOfDate } } : {} }));
  initial.focusedPaneId = "ctm";
  initial.paneState = { ctm: { pluginState: { "futures-curve": { tab } } } };
  // One provider for the whole render: a new one each render would reload the quotes forever.
  const provider = options.quote || options.bars ? createTestDataProvider({ ...options.quote ? { getQuote: options.quote } : {},
    ...options.bars ? { getPriceHistoryForResolutionWithMetadata: options.bars } : {} }) : null;
  const runtime = createTestPluginRuntime({ getMarketData: () => provider as never });
  function Harness() {
    // The selected contract is pane state, so moving it needs a reducer.
    const [state, setState] = useState<AppState>(initial);
    const dispatch = useCallback((action: AppAction) => setState((current) => appReducer(current, action)), []);
    return <TestPaneFrame state={state} dispatch={dispatch} paneId="ctm" pluginId="futures-curve" runtime={runtime} width={width} height={height}>
      {(body) => <FuturesCurvePane paneId="ctm" paneType="futures-curve" focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height }); });
  await settle();
  return tui.frame().split("\n");
}

test("a short curve tab lists the contracts once, and a tall one ends on the last contract", async () => {
  spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => payload());
  const short = (await render(40, 10)).join("\n");
  expect(short).not.toContain("TENOR");
  expect(short).toContain("CONTRACT");
  expect(short).toContain("ESU27.CME");
  const lines = await render(96, 29);
  expect(lines.join("\n")).toContain("Latest");
  expect(lines[27]).toContain("ESU28.CME");
  // The delay is the footer's clock: its glyph and the delay, the detail on the desktop's hover.
  expect(lines[28]).toContain("◷10m");
  expect(lines[28]).not.toContain("delayed");
});

test("the curve names what it plots, and its rows add the moves the chart only shows as ghosts", async () => {
  spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => payload([...CONTRACTS, FAR]));
  const lines = await render(98, 30);
  const frame = lines.join("\n");
  const header = lines.findIndex((line) => line.includes("CONTRACT"));
  // The caption carries the unit; the legend names each curve.
  expect(lines.slice(0, header).some((line) => line.includes("Index points by contract month") && line.includes("● Latest")
    && line.includes("● 1W ago"))).toBe(true);
  // The readout names the selected contract by month, with its moves in the table's units.
  expect(frame).toContain("Dec 2026 6600.00  1W ago +50.00  1M ago -25.00");
  // Change columns replace the quote time every row repeated.
  expect(lines[header]).toContain("VS 1W");
  expect(lines[header]).toContain("VS 1M");
  expect(lines[header]).not.toContain("AS OF");
  expect(lines.find((line) => line.includes("ESH27.CME"))).toMatch(/6640\.00\s+\+50\.00\s+-25\.00/);
  // Only the contracts the chart plots.
  expect(frame).not.toContain("ESZ40.CME");
  expect(frame).toContain("ESU28.CME");

  const contracts = (await render(98, 30, "contracts")).join("\n");
  expect(contracts).toContain("ESZ40.CME");
  expect(contracts).toContain("AS OF UTC");
  expect(contracts).not.toContain("VS 1W");
  expect(contracts).not.toContain("by contract month");
});

test("the selected contract is the curve's point", async () => {
  spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => payload());
  await render(98, 30);
  expect(tui.frame()).toContain("Dec 2026 6600.00");
  await act(async () => { tui.setup().mockInput.pressArrow("down"); await tui.setup().renderOnce(); });
  await settle();
  const frame = tui.frame();
  expect(frame).toContain("Mar 2027 6640.00  1W ago +50.00");
  expect(frame).not.toContain("Dec 2026 6600.00");
});

test("a short pane keeps the contracts and shrinks the curve to a strip, then drops it", async () => {
  spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => payload());
  // Sixteen rows: tabs, figures, a curve that still reads, then the header and four contracts.
  let lines = await render(60, 17);
  let header = lines.findIndex((line) => line.includes("CONTRACT"));
  // Too narrow for the caption and all three names, so the caption gives way:
  // every line drawn keeps its name.
  expect(lines.slice(0, header).some((line) => /● Latest +● 1W ago +● 1M ago/.test(line))).toBe(true);
  expect(lines.slice(header + 1).filter((line) => /ES[HMUZ]\d\d\.CME/.test(line)).length).toBeGreaterThanOrEqual(4);
  // Ten rows: the curve becomes one strip line and the table keeps its rows.
  lines = await render(40, 11);
  header = lines.findIndex((line) => line.includes("CONTRACT"));
  expect(lines[header - 1]).toContain("● Price");
  expect(lines[header - 1]).toContain("Dec 2026 6600.00");
  expect(lines.slice(header + 1).filter((line) => /ES[HMUZ]\d\d\.CME/.test(line)).length).toBeGreaterThanOrEqual(4);
  // Too narrow for a chart: no band at all.
  lines = await render(22, 11);
  expect(lines.join("\n")).not.toContain("●");
  expect(lines.join("\n")).toContain("ESZ26");
});

test("Dutch TTF gas reads in euros per MWh on the chart caption, the footer and the contract rows, with no dollar sign", async () => {
  const months = ["X26", "Z26", "F27", "K27"];
  const contracts = CONTRACTS.slice(0, months.length).map((row, index) => ({ ...row, symbol: `TTF${months[index]}.NYM`, currency: "EUR", quoteUnit: "EUR",
    price: 81.434 - index * 0.088, settlement: 78.849 - index * 0.088 }));
  spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => ({ ...payload(contracts), root: "TTF", name: "Dutch TTF Natural Gas",
    currency: "EUR", quoteUnit: "EUR", spec: null, settlementDate: "2026-09-21" }));
  const curve = (await render(120, 30, "curve", { root: "TTF" })).join("\n");
  expect(curve).toContain("EUR / MWh by contract month");
  expect(curve).toContain("◷10m EUR / MWh");
  expect(curve).toContain("TTFX26.NYM");
  expect(curve).toMatch(/78\.849\s+81\.434/);
  expect(curve).not.toMatch(/USD|\$/);
  const table = (await render(120, 30, "contracts", { root: "TTF" })).join("\n");
  expect(table).toMatch(/TTFZ26\.NYM.*78\.761\s+81\.346\s+\+2\.585/);
  expect(table).not.toMatch(/USD|\$/);
});

describe("crypto basis against spot", () => {
  // Expiries sit a fixed number of days from the trades' UTC date, so the cells never depend on the date the suite runs.
  const NOW = Date.now();
  const MINUTE = 60_000;
  // Every contract last traded 20 seconds into the minute three minutes ago, when BTC-USD's bar closed at 80,000.
  const PRINT_MINUTE = Math.floor(NOW / MINUTE) * MINUTE - 3 * MINUTE;
  const PRINT = new Date(PRINT_MINUTE + 20_000).toISOString();
  const SPOT_DAY = Date.parse(`${PRINT.slice(0, 10)}T00:00:00Z`);
  const expiry = (days: number) => new Date(SPOT_DAY + days * 86_400_000).toISOString().slice(0, 10);
  const btc = (code: string, days: number, price: number | null, extra: Partial<FuturesContract> = {}): FuturesContract =>
    ({ ...first, symbol: `${code}.CME`, label: code, expiration: expiry(days), price, asOf: PRINT, ...extra });
  const BTC_CONTRACTS = [
    btc("BTCV26", 21, 80_200), btc("BTCX26", 49, 79_000), btc("BTCZ26", 77, 80_400, { stale: true }), btc("BTCF27", 112, 81_000), btc("BTCH27", 140, null),
  ];
  const btcPayload = (contracts = BTC_CONTRACTS): FuturesCurvePayload => ({ ...payload(contracts), root: "BTC", name: "Bitcoin", quoteUnit: "USD",
    slope: { ...payload().slope, frontSymbol: "BTCV26.CME", nextSymbol: "BTCX26.CME" } });
  // The last hour of one-minute bars, the newest a minute old, the spot moving $25 a minute except in the trades' own minute.
  const reads: string[] = [];
  const bars: NonNullable<RenderOptions["bars"]> = async (symbol, _exchange, range, resolution) => {
    reads.push(`${symbol} ${range} ${resolution}`);
    return { resolution: "1m", points: Array.from({ length: 60 }, (_, index) => {
      const minute = Math.floor(NOW / MINUTE) * MINUTE - (60 - index) * MINUTE;
      return { date: new Date(minute), close: minute === PRINT_MINUTE ? 80_000 : 80_000 + (minute - PRINT_MINUTE) / MINUTE * 25 };
    }) };
  };
  // The quote path reports the pair's listing and whether the feed is real-time; the footer names both, the listing in plain words.
  const spot = (minutesOld: number, price = 80_150) => async (symbol: string) =>
    createTestQuote({ symbol, price, lastUpdated: NOW - minutesOld * MINUTE, marketState: "REGULAR", listingExchangeName: "CCC", dataSource: "live" });
  const row = (lines: string[], code: string) => lines.find((line) => line.includes(code)) ?? "";
  const ann = (price: number, days: number) => {
    const rate = (price / 80_000 - 1) * 365 / ((Date.parse(`${expiry(days)}T16:00:00Z`) - Date.parse(PRINT)) / 86_400_000) * 100;
    // London's 16:00 is 15:00 UTC in summer; either way the rate reads the same at one decimal this far out.
    return `${rate > 0 ? "\\+" : "-"}${Math.abs(rate).toFixed(1).replace(".", "\\.")}%`;
  };
  const fg = (text: string) => tui.setup().captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes(text))?.fg.toInts().join(",");
  const rgba = (hex: string) => [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((part) => parseInt(part, 16)).concat(255).join(",");
  /** The `!` popup's text, read inside its frame and joined into one line. */
  async function popup() {
    await act(async () => tui.setup().mockInput.pressKey("!"));
    await settle();
    const lines = tui.frame().split("\n");
    const top = lines.findIndex((line) => line.includes("┌"));
    const left = lines[top]!.indexOf("┌");
    const right = lines[top]!.indexOf("┐");
    const bottom = lines.findIndex((line, index) => index > top && line.charAt(left) === "└");
    const text = lines.slice(top + 1, bottom).map((line) => line.slice(left + 1, right)).join(" ").replace(/\s+/g, " ").trim();
    await tui.emitKeypress({ name: "escape" });
    await settle();
    return text;
  }

  test("each trade reads against the spot bar of its own minute, whatever the quote says now, and the footer names the spot in plain words", async () => {
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload());
    reads.length = 0;
    // The quote has moved on to 80,150 since the trades; the cells still read the 80,000 of their minute.
    const lines = await render(130, 30, "curve", { root: "BTC", quote: spot(1), bars });
    expect(reads[0]).toBe("BTC-USD 1D 1m");
    const header = lines.find((line) => line.includes("CONTRACT"))!;
    expect(header).toContain("VS SPOT");
    expect(header).toContain("ANN BASIS");
    expect(row(lines, "BTCV26.CME")).toMatch(new RegExp(`80200\\.00\\s+\\+0\\.25%\\s+${ann(80_200, 21)}`));
    expect(row(lines, "BTCX26.CME")).toMatch(new RegExp(`79000\\.00\\s+-1\\.25%\\s+${ann(79_000, 49)}`));
    expect(row(lines, "BTCF27.CME")).toMatch(new RegExp(`81000\\.00\\s+\\+1\\.25%\\s+${ann(81_000, 112)}`));
    // A stale print and a missing price would mislead: blank.
    expect(row(lines, "BTCZ26.CME")).toMatch(/80400\.00\s+--\s+--/);
    expect(row(lines, "BTCH27.CME")).toMatch(/--\s+--\s+--/);
    expect(lines.join("\n")).toMatch(/spot BTC-USD 80,150\.00 · (\d{4}-\d{2}-\d{2} )?\d{2}:\d{2} UTC \(crypto composite price, real-time\)/);
    expect(lines.join("\n")).not.toContain("CCC");
    // Beyond a week of expiry the annualised rate is the figure to read: it takes the text colour and Vs Spot is greyed.
    expect(fg("+0.25%")).toBe(rgba(colors.textMuted));
    expect(fg(ann(80_200, 21).replace(/\\/g, ""))).not.toBe(rgba(colors.textMuted));
  });

  test("the ! popup carries the report's convention and blank reasons, and a narrow footer gives the spot's source up first", async () => {
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload());
    const lines = await render(130, 30, "curve", { root: "BTC", quote: spot(1), bars });
    expect(lines.join("\n")).toContain("⚠");
    // The same footnotes `fn CTM` prints under its table, in the popup every pane's data warnings open in.
    expect(await popup()).toBe("Data warnings Ann Basis = (Last / spot - 1) × 365 / days to expiry: simple actual/365, each last trade against spot "
      + "in the same minute, with days counted to final settlement at 16:00 London on the last trading day. "
      + "Basis blank for BTCZ26 (price over two sessions old); BTCH27 (no price). Close");
    spy.mockRestore(); futuresCurveCache.reset();
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload(BTC_CONTRACTS.slice(0, 2)));
    const narrow = await render(90, 30, "curve", { root: "BTC", quote: spot(1), bars });
    expect(narrow.join("\n")).toMatch(/spot BTC-USD 80,150\.00 · \d{2}:\d{2} UTC/);
    expect(narrow.join("\n")).not.toContain("crypto composite");
  });

  test("inside a week of expiry Vs Spot leads, the rate is greyed, and the popup says how noisy it is", async () => {
    const near = [btc("BTCU26", 3, 80_100), ...BTC_CONTRACTS.slice(0, 2)];
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload(near));
    await render(130, 30, "curve", { root: "BTC", quote: spot(1), bars });
    expect(fg("+0.13%")).not.toBe(rgba(colors.textMuted));
    expect(fg(ann(80_100, 3).replace(/\\/g, ""))).toBe(rgba(colors.textMuted));
    expect(await popup()).toMatch(/Ann Basis is noisy under 7 days to expiry, so read Vs Spot there: 10 bp of spot noise moves BTCU26 \(\d\.\d days\) by ±\d+\.\d points\./);
    // A pane too narrow for both basis columns keeps Vs Spot while a contract is inside a week.
    const narrow = await render(64, 30, "curve", { root: "BTC", quote: spot(1), bars });
    expect(narrow.find((line) => line.includes("CONTRACT"))).toContain("VS SPOT");
  });

  test("a trade after the newest spot bar is blank, and the popup gives both times", async () => {
    const late = new Date(Math.floor(NOW / MINUTE) * MINUTE + 5_000).toISOString();
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload([...BTC_CONTRACTS.slice(0, 2), btc("BTCJ27", 154, 81_500, { asOf: late })]));
    const lines = await render(130, 30, "curve", { root: "BTC", quote: spot(1), bars });
    expect(row(lines, "BTCJ27.CME")).toMatch(/81500\.00\s+--\s+--/);
    const newest = new Date(Math.floor(NOW / MINUTE) * MINUTE - MINUTE).toISOString().slice(11, 16);
    expect(await popup()).toContain(`Basis blank for BTCJ27 (spot and print 1 min apart: print ${late.slice(11, 16)}, nearest spot ${newest} UTC).`);
  });

  test("without spot bars every cell is blank and the popup says why; a stale quote only warns", async () => {
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload());
    let lines = await render(120, 30, "curve", { root: "BTC", quote: spot(1), bars: async () => { throw new Error("no history"); } });
    expect(row(lines, "BTCV26.CME")).toMatch(/80200\.00\s+--\s+--/);
    expect(await popup()).toContain("BTCV26, BTCX26, BTCF27 (no one-minute spot prices)");
    lines = await render(120, 30, "curve", { root: "BTC", quote: spot(125), bars });
    expect(row(lines, "BTCV26.CME")).toMatch(/\+0\.25%/);
    expect(lines.join("\n")).toContain("BTC-USD quote is 2h old");
    expect(lines.join("\n")).not.toContain("Basis blank:");
  });

  test("a narrow pane drops the least useful columns before it would clip a number", async () => {
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload());
    for (const width of [100, 80]) {
      const lines = await render(width, 30, "curve", { root: "BTC", quote: spot(1), bars });
      const header = lines.find((line) => line.includes("CONTRACT"))!;
      expect(header).toContain("ANN BASIS");
      expect(header).not.toContain("PCTL");
      expect(row(lines, "BTCV26.CME")).toMatch(new RegExp(`\\+0\\.25%\\s+${ann(80_200, 21)}`));
      // The table: the footer's status may end in an ellipsis where it meets the key hints.
      expect(lines.filter((line) => !line.startsWith("└")).join("\n")).not.toContain("…");
    }
  });

  test("other roots, the Contracts tab and a past date have no basis columns and never read a spot", async () => {
    const quotes: string[] = [];
    const quote = async (symbol: string) => { quotes.push(symbol); return spot(1)(symbol); };
    reads.length = 0;
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => payload());
    expect((await render(120, 30, "curve", { quote, bars })).join("\n")).not.toContain("VS SPOT");
    spy.mockRestore();
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload());
    expect((await render(120, 30, "contracts", { root: "BTC", quote, bars })).join("\n")).not.toContain("VS SPOT");
    spy.mockRestore();
    const archived: FuturesCurveAsOfPayload = { root: "BTC", name: "Bitcoin", date: "2026-10-01", asOf: "2026-10-01", currency: "USD", quoteUnit: "USD", archiveStart: "2026-09-01", gaps: [],
      contracts: BTC_CONTRACTS.filter((contract) => contract.price != null).map((contract) => ({ contract: contract.symbol, symbol: contract.symbol, label: contract.label,
        deliveryMonth: contract.expiration.slice(0, 7), expiration: contract.expiration, tradeDate: "2026-10-01", price: contract.price!, volume: 1, openInterest: 1,
        asOf: "2026-10-01T00:00:00.000Z", stale: false })) };
    spy = spyOn(apiClient, "getCloudFuturesCurveAsOf").mockImplementation(async () => archived);
    const past = (await render(120, 30, "curve", { root: "BTC", asOfDate: "2026-10-01", quote, bars })).join("\n");
    expect(past).toContain("BTCV26.CME");
    expect(past).not.toContain("VS SPOT");
    expect(past).not.toContain("Basis blank");
    expect(quotes).toEqual([]);
    expect(reads).toEqual([]);
  });
});

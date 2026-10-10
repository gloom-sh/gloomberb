import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, useCallback, useState } from "react";
import { apiClient } from "../../../api-client";
import type { FuturesContract, FuturesCurveAsOfPayload, FuturesCurvePayload } from "../../../api-client/futures-curve";
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
  /** Answers the terminal's quote path, which the crypto basis reads its spot from. */
  quote?: (symbol: string) => Promise<Quote>;
}

async function render(width: number, height: number, tab = "curve", options: RenderOptions = {}): Promise<string[]> {
  await tui.destroy();
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-futures-curve-test", { instanceId: "ctm", paneId: "futures-curve", binding: { kind: "none" },
    ...options.root ? { params: { root: options.root } } : {}, ...options.asOfDate ? { settings: { asOfDate: options.asOfDate } } : {} }));
  initial.focusedPaneId = "ctm";
  initial.paneState = { ctm: { pluginState: { "futures-curve": { tab } } } };
  // One provider for the whole render: a new one each render would reload the quotes forever.
  const provider = options.quote ? createTestDataProvider({ getQuote: options.quote }) : null;
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
  expect(lines[28]).toContain("10m delayed");
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
  expect(frame).toContain("Dec 26 6600.00  1W ago +50.00  1M ago -25.00");
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
  expect(tui.frame()).toContain("Dec 26 6600.00");
  await act(async () => { tui.setup().mockInput.pressArrow("down"); await tui.setup().renderOnce(); });
  await settle();
  const frame = tui.frame();
  expect(frame).toContain("Mar 27 6640.00  1W ago +50.00");
  expect(frame).not.toContain("Dec 26 6600.00");
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
  expect(lines[header - 1]).toContain("Dec 26 6600.00");
  expect(lines.slice(header + 1).filter((line) => /ES[HMUZ]\d\d\.CME/.test(line)).length).toBeGreaterThanOrEqual(4);
  // Too narrow for a chart: no band at all.
  lines = await render(22, 11);
  expect(lines.join("\n")).not.toContain("●");
  expect(lines.join("\n")).toContain("ESZ26");
});

describe("crypto basis against spot", () => {
  // Expiries sit a fixed number of days from the spot's UTC date, so the cells never depend on the date the suite runs.
  const NOW = Date.now();
  const SPOT_DAY = Date.parse(`${new Date(NOW - 2 * 60_000).toISOString().slice(0, 10)}T00:00:00Z`);
  const expiry = (days: number) => new Date(SPOT_DAY + days * 86_400_000).toISOString().slice(0, 10);
  const btc = (code: string, days: number, price: number | null, extra: Partial<FuturesContract> = {}): FuturesContract =>
    ({ ...first, symbol: `${code}.CME`, label: code, expiration: expiry(days), price, asOf: new Date(NOW).toISOString(), ...extra });
  const BTC_CONTRACTS = [
    btc("BTCV26", 21, 80_200), btc("BTCX26", 49, 79_000), btc("BTCZ26", 77, 80_400, { stale: true }), btc("BTCF27", 112, 81_000), btc("BTCH27", 140, null),
  ];
  // Priced and not flagged stale, but printed long before the spot quote: thin months.
  const THIN_CONTRACTS = [
    btc("BTCJ27", 154, 81_500, { asOf: new Date(NOW - 3 * 3_600_000).toISOString() }), btc("BTCK27", 168, 82_000, { asOf: expiry(-1) }),
  ];
  const btcPayload = (contracts = BTC_CONTRACTS): FuturesCurvePayload => ({ ...payload(contracts), root: "BTC", name: "Bitcoin", quoteUnit: "USD",
    slope: { ...payload().slope, frontSymbol: "BTCV26.CME", nextSymbol: "BTCX26.CME" } });
  const spot = (minutesOld: number) => async (symbol: string) =>
    createTestQuote({ symbol, price: 80_000, lastUpdated: NOW - minutesOld * 60_000, marketState: "REGULAR" });
  const row = (lines: string[], code: string) => lines.find((line) => line.includes(code)) ?? "";

  test("each contract shows its premium and annualised basis, and the footer names the spot it used", async () => {
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload());
    // 2 minutes old: the same UTC day as `SPOT_DAY` unless the suite straddles midnight.
    const lines = await render(120, 30, "curve", { root: "BTC", quote: spot(2) });
    const header = lines.find((line) => line.includes("CONTRACT"))!;
    expect(header).toContain("VS SPOT");
    expect(header).toContain("ANN BASIS");
    // 80,200 over 80,000 for 21 days, 79,000 for 49 and 81,000 for 112 days: contango, backwardation, contango.
    expect(row(lines, "BTCV26.CME")).toMatch(/80200\.00\s+\+0\.25%\s+\+4\.3%/);
    expect(row(lines, "BTCX26.CME")).toMatch(/79000\.00\s+-1\.25%\s+-9\.3%/);
    expect(row(lines, "BTCF27.CME")).toMatch(/81000\.00\s+\+1\.25%\s+\+4\.1%/);
    // A stale print and a missing price against a live spot would mislead: blank.
    expect(row(lines, "BTCZ26.CME")).toMatch(/80400\.00\s+--\s+--/);
    expect(row(lines, "BTCH27.CME")).toMatch(/--\s+--\s+--/);
    expect(lines.join("\n")).toMatch(/spot BTC-USD 80,000\.00 · (\d{4}-\d{2}-\d{2} )?\d{2}:\d{2} UTC/);
    expect(lines.join("\n")).not.toContain("Basis blank:");
  });

  test("a print over an hour before the spot is blank, and a data warning counts those thin contracts", async () => {
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload([...BTC_CONTRACTS, ...THIN_CONTRACTS]));
    let lines = await render(98, 30, "curve", { root: "BTC", quote: spot(2) });
    expect(row(lines, "BTCJ27.CME")).toMatch(/81500\.00\s+--\s+--/);
    expect(row(lines, "BTCK27.CME")).toMatch(/82000\.00\s+--\s+--/);
    expect(row(lines, "BTCF27.CME")).toMatch(/81000\.00\s+\+1\.25%\s+\+4\.1%/);
    // A thin contract's price takes the warning colour a stale one does, and a current one does not.
    const priceColor = (text: string) => tui.setup().captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes(text))?.fg.toInts().join(",");
    const warning = [colors.warning.slice(1, 3), colors.warning.slice(3, 5), colors.warning.slice(5, 7)].map((part) => parseInt(part, 16)).concat(255).join(",");
    expect(priceColor("81500.00")).toBe(warning);
    expect(priceColor("82000.00")).toBe(warning);
    expect(priceColor("80400.00")).toBe(warning);
    expect(priceColor("79000.00")).not.toBe(warning);
    // The warning is the footer's ⚠, which leaves the row to the quote times; `!` opens it. Contracts blanked
    // for another reason (the stale and the unpriced) are not counted again.
    expect(lines.join("\n")).toContain("⚠");
    expect(lines.join("\n")).not.toContain("Basis blank");
    await act(async () => tui.setup().mockInput.pressKey("!"));
    await settle();
    expect(tui.frame()).toContain("Basis blank on 2 thin contracts (last print over 1h before spot)");
    await tui.emitKeypress({ name: "escape" });
    await settle();
    // One thin contract reads in the singular, and at the default width the footer keeps the spot's time whole.
    spy.mockRestore(); futuresCurveCache.reset();
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload([BTC_CONTRACTS[0]!, BTC_CONTRACTS[1]!, THIN_CONTRACTS[0]!]));
    lines = await render(98, 30, "curve", { root: "BTC", quote: spot(2) });
    expect(lines.join("\n")).toMatch(/UTC\s+spot BTC-USD 80,000\.00 · \d{2}:\d{2} UTC/);
    await act(async () => tui.setup().mockInput.pressKey("!"));
    await settle();
    expect(tui.frame()).toContain("Basis blank on 1 thin contract (last print over 1h before spot)");
    await tui.emitKeypress({ name: "escape" });
    await settle();
    // Without a good spot the reason is the spot's, and no contract is thin.
    spy.mockRestore(); futuresCurveCache.reset();
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload([...BTC_CONTRACTS, ...THIN_CONTRACTS]));
    lines = await render(98, 30, "curve", { root: "BTC", quote: spot(125) });
    expect(lines.join("\n")).toContain("Basis blank: BTC-USD quote is 2h old");
    expect(lines.join("\n")).not.toContain("⚠");
  });

  test("a stale or missing spot blanks every basis cell and says why", async () => {
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload());
    let lines = await render(120, 30, "curve", { root: "BTC", quote: spot(125) });
    expect(row(lines, "BTCV26.CME")).toMatch(/80200\.00\s+--\s+--/);
    expect(row(lines, "BTCX26.CME")).toMatch(/79000\.00\s+--\s+--/);
    expect(lines.join("\n")).toContain("Basis blank: BTC-USD quote is 2h old");
    expect(lines.join("\n")).not.toContain("spot BTC-USD");
    lines = await render(120, 30, "curve", { root: "BTC", quote: async () => { throw new Error("no such symbol"); } });
    expect(row(lines, "BTCV26.CME")).toMatch(/80200\.00\s+--\s+--/);
    expect(lines.join("\n")).toContain("Basis blank: no BTC-USD quote");
  });

  test("a narrow pane drops the least useful columns before it would clip a number", async () => {
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload());
    for (const width of [100, 80]) {
      const lines = await render(width, 30, "curve", { root: "BTC", quote: spot(2) });
      const header = lines.find((line) => line.includes("CONTRACT"))!;
      expect(header).toContain("ANN BASIS");
      expect(header).not.toContain("PCTL");
      expect(row(lines, "BTCV26.CME")).toMatch(/\+0\.25%\s+\+4\.3%/);
      expect(lines.join("\n")).not.toContain("…");
    }
  });

  test("other roots, the Contracts tab and a past date have no basis columns and never read a spot", async () => {
    const quotes: string[] = [];
    const quote = async (symbol: string) => { quotes.push(symbol); return spot(1)(symbol); };
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => payload());
    expect((await render(120, 30, "curve", { quote })).join("\n")).not.toContain("VS SPOT");
    spy.mockRestore();
    spy = spyOn(apiClient, "getCloudFuturesCurve").mockImplementation(async () => btcPayload());
    expect((await render(120, 30, "contracts", { root: "BTC", quote })).join("\n")).not.toContain("VS SPOT");
    spy.mockRestore();
    const archived: FuturesCurveAsOfPayload = { root: "BTC", name: "Bitcoin", date: "2026-10-01", asOf: "2026-10-01", currency: "USD", quoteUnit: "USD", archiveStart: "2026-09-01", gaps: [],
      contracts: BTC_CONTRACTS.filter((contract) => contract.price != null).map((contract) => ({ contract: contract.symbol, symbol: contract.symbol, label: contract.label,
        deliveryMonth: contract.expiration.slice(0, 7), expiration: contract.expiration, tradeDate: "2026-10-01", price: contract.price!, volume: 1, openInterest: 1,
        asOf: "2026-10-01T00:00:00.000Z", stale: false })) };
    spy = spyOn(apiClient, "getCloudFuturesCurveAsOf").mockImplementation(async () => archived);
    const past = (await render(120, 30, "curve", { root: "BTC", asOfDate: "2026-10-01", quote })).join("\n");
    expect(past).toContain("BTCV26.CME");
    expect(past).not.toContain("VS SPOT");
    expect(past).not.toContain("Basis blank");
    expect(quotes).toEqual([]);
  });
});

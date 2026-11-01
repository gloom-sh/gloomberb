import { expect, test } from "bun:test";
import { getPaneFunctionCapability, normalizeCapabilityOptions } from "../../../cli/pane-functions/capabilities";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { backtestHeadless } from "./headless";
import { backtestModule } from "./index";
import { resolveRules } from "./presets";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { PricePoint } from "../../../types/financials";

const ENTRY = "close > sma(50)";
const EXIT = "close < sma(50)";

/** The options `fn BT` passes the load for what was typed, as the resolver normalizes them. */
function typed(options: Record<string, string>) {
  return normalizeCapabilityOptions(getPaneFunctionCapability(backtestModule.paneTemplates![0]!, backtestModule.panes![0]!), options);
}

// `fn BT XLI --entry ... --exit ...` ran the golden cross: the preset's default filled in for the option left out.
test("rules typed without --preset are tested as custom; nothing typed is the golden cross", () => {
  const rules = typed({ entry: ENTRY, exit: EXIT });
  expect(rules.preset).toBeUndefined();
  expect(resolveRules(rules.preset as string | undefined, String(rules.entry), String(rules.exit)))
    .toEqual({ entry: ENTRY, exit: EXIT, label: "Custom rules" });
  const none = typed({});
  expect(resolveRules(none.preset as string | undefined, String(none.entry), String(none.exit)).label).toBe("Golden cross (50/200)");
  // A chosen preset tests its own rules, and custom the typed ones.
  expect(resolveRules("trend-200", "", "").entry).toBe("close > sma(200)");
  expect(resolveRules("custom", ENTRY, EXIT).label).toBe("Custom rules");
});

test("rules typed beside another preset are refused, naming both, before any data is asked for", async () => {
  const unasked = createTestHeadlessContext({
    marketData: new Proxy({} as never, { get: () => { throw new Error("asked for data"); } }),
  });
  const load = (options: Record<string, string>) => backtestHeadless.load(
    createTestHeadlessArgs({ rawArgument: "XLI", argument: "XLI", symbols: ["XLI"], options: typed(options) }), unasked);
  await expect(load({ preset: "golden-cross", entry: ENTRY, exit: EXIT }))
    .rejects.toThrow("--entry and --exit are custom rules, but --preset golden-cross tests its own. Leave out --preset to test the typed rules, or give --preset custom.");
  await expect(load({ preset: "rsi-reversion", exit: EXIT })).rejects.toThrow("--exit is a custom rule, but --preset rsi-reversion tests its own.");
  // Custom and the typed rules agree: the load goes on to ask for history.
  await expect(load({ preset: "custom", entry: ENTRY, exit: EXIT })).rejects.toThrow("asked for data");
});

/**
 * `fn BT CL=F --preset trend-200` on Fri 30 Oct 2026 ran "2016-10-31 to 2026-10-30" with no word of the session
 * still trading, and --include-partial gave the same numbers; BTC-USD left its forming day out. The history BT
 * reads now marks a future's trading session partial (and served one closed before its settlement unsettled).
 */
test("BT leaves a forming last bar out of CL=F, ES=F and BTC-USD alike, says so, and is as of the last complete session", async () => {
  const DAY = 86_400_000;
  const first = Date.parse("2025-06-02T00:00:00Z");
  const series = (last: Pick<PricePoint, "partial" | "unsettled">, sessionsOnly: boolean): PricePoint[] => {
    const days = Array.from({ length: 520 }, (_, index) => new Date(first + index * DAY))
      .filter((date) => !sessionsOnly || (date.getUTCDay() !== 0 && date.getUTCDay() !== 6))
      .filter((date) => date.toISOString() <= "2026-10-30T00:00:00.000Z");
    return days.map((date, index) => {
      const close = 60 + index * 0.05 + Math.sin(index / 7) * 3;
      // The newest bar is the one still trading: a jump the run must not count.
      const newest = index === days.length - 1;
      return { date, open: close, high: close, low: close, close: newest ? close * 1.2 : close, ...(newest ? last : {}) };
    });
  };
  const run = async (symbol: string, points: PricePoint[], options: Record<string, string> = {}) => {
    const marketData = createTestDataProvider({
      getPriceHistoryForResolutionWithMetadata: async () => ({ points, resolution: "1d" }),
      getPriceHistoryWithMetadata: async () => ({ points, resolution: "1d" }),
      getQuote: async () => { throw new Error("no quote"); },
    });
    return backtestHeadless.load(createTestHeadlessArgs({ rawArgument: symbol, argument: symbol, symbols: [symbol],
      options: typed({ preset: "trend-200", lookback: "max", ...options }) }), createTestHeadlessContext({ marketData }));
  };
  const cases = [
    ["CL=F", series({ partial: true }, true)], ["ES=F", series({ partial: true }, true)], ["BTC-USD", series({ partial: true }, false)],
    // A future's trading session a server reads as closed before its settlement is not final either.
    ["CL=F", series({ unsettled: true }, true)],
  ] as const;
  for (const [symbol, points] of cases) {
    const report = await run(symbol, [...points]);
    const result = (report.metadata as { result: { end: string } }).result;
    expect(result.end, symbol).toBe("2026-10-29");
    expect(report.freshness?.asOf, symbol).toBe("2026-10-29");
    expect(report.warnings?.[0], symbol).toMatch(/^2026-10-30 is (still forming \(partial\)|not settled yet \(unsettled\)) and left out: the test runs through 2026-10-29, the last complete session\.$/);
    // Asked for, it is kept and says the results move.
    const kept = await run(symbol, [...points], { "include-partial": "true" });
    expect((kept.metadata as { result: { end: string } }).result.end, symbol).toBe("2026-10-30");
    expect(kept.warnings?.[0], symbol).toContain("2026-10-30");
    expect(kept.warnings?.[0], symbol).toContain("and kept");
  }
});

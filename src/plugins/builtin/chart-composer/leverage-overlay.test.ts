import { expect, test } from "bun:test";
import { normalizeChartSpec, validateChartSpec } from "../../../time-series/spec";
import { buildComparisonChartPreset } from "./presets";
import { comparedFundTickers, dailyObjective, loadDailyObjectives, mayDrawDailyObjective, withLeverageOverlay } from "./leverage-overlay";

const facts = (value: number, proxy: string | null, reset = "daily") => ({ leverage: { value, reset, proxy: proxy ? { ticker: proxy } : null } });

test("a leveraged fund's comparison draws its daily line from the index fund, added once when missing", async () => {
  const spec = buildComparisonChartPreset(["TQQQ", "SQQQ", "SPY"]);
  expect(comparedFundTickers(spec)).toEqual(["TQQQ", "SQQQ", "SPY"]);
  const objectives = await loadDailyObjectives(comparedFundTickers(spec), async (ticker) => (
    ticker === "TQQQ" ? facts(3, "QQQ") : ticker === "SQQQ" ? facts(-3, "QQQ") : ticker === "SPY" ? { leverage: null } : null
  ));
  const overlaid = withLeverageOverlay(spec, objectives);
  // QQQ joins once, as a compared leg like the others; each fund gets its line and its decay.
  expect(overlaid.series.map((series) => series.source.kind === "security" ? series.source.instrument.symbol : null)).toEqual(["TQQQ", "SQQQ", "SPY", "QQQ"]);
  expect(overlaid.series[3]).toMatchObject({ transform: "percent", style: "line", panelId: "main" });
  const qqq = overlaid.series[3]!.id;
  expect(overlaid.studies.map((study) => [study.kind, study.inputSeriesIds, study.parameters.factor, study.panelId])).toEqual([
    ["leverage", [qqq], 3, "main"],
    ["leverage-decay", [overlaid.series[0]!.id, qqq], 3, "decay"],
    ["leverage", [qqq], -3, "main"],
    ["leverage-decay", [overlaid.series[1]!.id, qqq], -3, "decay"],
  ]);
  expect(overlaid.panels.map((panel) => panel.id)).toEqual(["main", "decay"]);
  expect(validateChartSpec(normalizeChartSpec(JSON.parse(JSON.stringify(overlaid)))).valid).toBe(true);
  // Drawn once: a chart that has it is left alone.
  expect(withLeverageOverlay(overlaid, objectives)).toBe(overlaid);

  // The index fund already compared is the input, not added again.
  const withQqq = withLeverageOverlay(buildComparisonChartPreset(["TQQQ", "QQQ"]), new Map([["TQQQ", { factor: 3, proxy: "QQQ" }]]));
  expect(withQqq.series).toHaveLength(2);
  expect(withQqq.studies[0]!.inputSeriesIds).toEqual([withQqq.series[1]!.id]);
});

test("only a daily objective with an index fund draws a line", () => {
  expect(dailyObjective(facts(3, "QQQ"))).toEqual({ factor: 3, proxy: "QQQ" });
  // Monthly reset (Direxion's monthly funds), no fund tracking the benchmark, or an older server.
  expect(dailyObjective(facts(1.75, "QQQ", "monthly"))).toBeNull();
  expect(dailyObjective(facts(2, null))).toBeNull();
  expect(dailyObjective({})).toBeNull();
});

test("a comparison waits a bounded time for its legs' facts, and asks none when it cannot draw the line", async () => {
  const aborted: string[] = [];
  const objectives = await loadDailyObjectives(["TQQQ", "SQQQ"], (ticker, signal) => ticker === "TQQQ"
    ? Promise.resolve(facts(3, "QQQ"))
    // A read that never answers is charted without and aborted once the wait is over.
    : new Promise((_, reject) => signal.addEventListener("abort", () => { aborted.push(ticker); reject(signal.reason); })),
  { timeoutMs: 20 });
  expect([...objectives.keys()]).toEqual(["TQQQ"]);
  expect(aborted).toEqual(["SQQQ"]);

  const spec = buildComparisonChartPreset(["TQQQ", "QQQ"]);
  expect(mayDrawDailyObjective(spec)).toBe(true);
  // One session's chart, or weekly bars, would only warn that the line needs daily bars.
  expect(mayDrawDailyObjective({ ...spec, viewport: { ...spec.viewport, range: "1D" } })).toBe(false);
  expect(mayDrawDailyObjective({ ...spec, viewport: { ...spec.viewport, resolution: "1wk" } })).toBe(false);
  expect(mayDrawDailyObjective(withLeverageOverlay(spec, new Map([["TQQQ", { factor: 3, proxy: "QQQ" }]])))).toBe(false);
});

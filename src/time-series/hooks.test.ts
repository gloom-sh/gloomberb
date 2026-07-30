import { describe, expect, test } from "bun:test";
import { buildComparisonChartPreset } from "../plugins/builtin/chart-composer/presets";
import type { TickerRecord } from "../types/ticker";
import { hydrateChartSpecInstruments } from "./hooks";

function ticker(symbol: string, exchange: string): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange,
      currency: "USD",
      name: symbol,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    },
  };
}

describe("hydrateChartSpecInstruments", () => {
  test("fills missing exchanges without replacing explicit chart identities", () => {
    const initial = buildComparisonChartPreset(["SNDK", "SAP:XETR"]);
    const spec = {
      ...initial,
      series: initial.series.map((entry, index) => (
        index === 0 && entry.source.kind === "security"
          ? {
            ...entry,
            source: {
              ...entry.source,
              instrument: { ...entry.source.instrument, exchange: "" },
            },
          }
          : entry
      )),
    };

    const hydrated = hydrateChartSpecInstruments(spec, new Map([
      ["SNDK", ticker("SNDK", "NASDAQ")],
      ["SAP", ticker("SAP", "JSE")],
    ]));

    expect(hydrated.series[0]?.source).toMatchObject({
      kind: "security",
      instrument: { symbol: "SNDK", exchange: "NASDAQ" },
    });
    expect(hydrated.series[1]?.source).toMatchObject({
      kind: "security",
      instrument: { symbol: "SAP", exchange: "XETRA" },
    });
    expect(spec.series[0]?.source).toMatchObject({
      kind: "security",
      instrument: { symbol: "SNDK", exchange: "" },
    });
    expect(hydrateChartSpecInstruments(hydrated, new Map())).toBe(hydrated);
  });
});

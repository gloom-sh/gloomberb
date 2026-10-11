import { describe, expect, test } from "bun:test";
import { SeriesRegistry, capabilitySeriesId, seriesExpression } from "./registry";
import { normalizeSeriesPoints, resolveLoadedSeries, seriesLoadWindow } from "./resolve";
import { hostLabelWords, isValidSeriesUnit, validateSeriesDefinition } from "./validate";
import type { SeriesDefinition, SeriesLoadRequest } from "./types";

const loaded = (overrides: Partial<SeriesDefinition> = {}): SeriesDefinition => ({
  id: "garden:rain",
  name: "Garden rainfall",
  unit: "number",
  frequency: "daily",
  load: () => [],
  ...overrides,
} as SeriesDefinition);

describe("series validation", () => {
  test("units follow one small grammar: rates, quantities with a scale, currencies and prices per unit", () => {
    for (const unit of ["%", "bp", "index", "USD", "billion USD", "thousand barrels/day", "USD/barrel", "million shares", "currency/share"]) {
      expect(isValidSeriesUnit(unit)).toBe(true);
    }
    for (const unit of ["", "percent", "thousand %", "usd", "USD/apple", "dozen eggs", "billion"]) {
      expect(isValidSeriesUnit(unit)).toBe(false);
    }
  });

  test("rejects malformed ids, unknown frequencies, both or neither source, and a misplaced ticker slot", () => {
    const invalid: Array<[Partial<SeriesDefinition>, RegExp]> = [
      [{ id: "Garden:rain" }, /namespace:name/],
      [{ id: "rain" }, /namespace:name/],
      [{ frequency: "hourly" as never }, /frequency/],
      [{ unit: "drops" }, /unit "drops"/],
      [{ expression: "FRED:UNRATE" } as never, /exactly one of load or expression/],
      [{ load: undefined }, /exactly one of load or expression/],
      [{ load: undefined, expression: "{ticker}:close" } as never, /needs an input/],
      [{ load: undefined, expression: "AAPL:close", input: "ticker" } as never, /must contain \{ticker\}/],
      [{ load: undefined, expression: "AAPL;MSFT" } as never, /one chart series/],
      [{ refreshMs: 1_000 } as never, /refreshMs/],
      [{ url: "ftp://example" }, /url/],
    ];
    for (const [overrides, message] of invalid) {
      expect(() => validateSeriesDefinition(loaded(overrides))).toThrow(message);
    }
    expect(() => validateSeriesDefinition(loaded({ input: "ticker" }))).not.toThrow();
  });

  test("public labels say what the data is, never the host or the service it is fetched from", () => {
    const words = hostLabelWords(["api.rainco.example", "rainco.example", "x.io"]);
    expect(words).toEqual(["rainco"]);
    expect(() => validateSeriesDefinition(loaded({ name: "RainCo rainfall" }), { forbiddenWords: words })).toThrow(/rainco/);
    expect(() => validateSeriesDefinition(loaded({ tags: ["via rainco"] }), { forbiddenWords: words })).toThrow(/tag/);
    expect(() => validateSeriesDefinition(loaded({ publisher: "rain.com" }))).toThrow(/names a host/);
    expect(() => validateSeriesDefinition(loaded({ description: "from provider:rain-feed" }))).toThrow(/internal source/);
    expect(() => validateSeriesDefinition(loaded({ name: "Raincoat sales" }), { forbiddenWords: words })).not.toThrow();
  });
});

describe("series registry", () => {
  test("ids are unique, a loaded namespace has one owner, and a disposed series frees both", () => {
    const namespaces: Array<[string, string | null]> = [];
    const registry = new SeriesRegistry({ onNamespaceChange: (namespace, pluginId) => namespaces.push([namespace, pluginId]) });
    const dispose = registry.register("garden", loaded());
    expect(() => registry.register("other", loaded())).toThrow(/already registered by plugin "garden"/);
    expect(() => registry.register("other", loaded({ id: "garden:snow" }))).toThrow(/belongs to plugin "garden"/);
    // An expression series needs no capability, so it can sit in any namespace.
    registry.register("other", { id: "garden:unemployment", name: "Unemployment", unit: "%", frequency: "monthly", expression: "FRED:UNRATE" });
    expect(registry.namespaceOwner("garden")).toBe("garden");

    dispose();
    expect(registry.get("garden:rain")).toBeUndefined();
    expect(registry.namespaceOwner("garden")).toBeUndefined();
    expect(namespaces).toEqual([["garden", "garden"], ["garden", null]]);
    registry.register("other", loaded({ id: "garden:snow" }));
    expect(registry.namespaceOwner("garden")).toBe("other");
  });

  test("a series with an input charts under its name and the symbol, and only with one", () => {
    const registry = new SeriesRegistry();
    registry.register("lab", loaded({ id: "lab:fee", input: "ticker" }));
    registry.register("lab", loaded({ id: "lab:index" }));
    const fee = registry.get("lab:fee")!.definition;
    expect(seriesExpression(fee)).toBe("CAP:lab:fee/{ticker}");
    expect(capabilitySeriesId(fee, "^gspc")).toBe("fee/%5EGSPC");
    expect(registry.findLoaded("lab", "fee/%5EGSPC")).toMatchObject({ ticker: "^GSPC" });
    expect(registry.findLoaded("lab", "fee")).toBeNull();
    expect(registry.findLoaded("lab", "index/AAPL")).toBeNull();
    expect(registry.findLoaded("lab", "index")?.series.definition.id).toBe("lab:index");
    expect(registry.findLoaded("elsewhere", "index")).toBeNull();
  });

  test("the catalog snapshot is shared until something changes, and listeners hear each change", () => {
    const registry = new SeriesRegistry();
    let heard = 0;
    registry.subscribe(() => { heard += 1; });
    registry.register("lab", loaded({ id: "lab:a" }));
    const first = registry.catalog();
    expect(registry.catalog()).toBe(first);
    const dispose = registry.register("lab", loaded({ id: "lab:b" }));
    expect(registry.catalog()).not.toBe(first);
    expect(registry.catalog().map((entry) => entry.expression)).toEqual(["CAP:lab:a", "CAP:lab:b"]);
    dispose();
    expect(heard).toBe(3);
  });
});

describe("loading a series", () => {
  test("points become one per instant, oldest first, with bare dates read as UTC days and bad values as gaps", () => {
    const points = normalizeSeriesPoints([
      { date: "2024-03-02", value: 2 },
      { date: "2024-03-01", value: 1 },
      { date: "2024-03-02", value: 3 },
      { date: Date.UTC(2024, 2, 3), value: Number.NaN },
      { date: "not a date", value: 9 },
    ]);
    expect(points.map((point) => [point.date.toISOString().slice(0, 10), point.value])).toEqual([
      ["2024-03-01", 1], ["2024-03-02", 3], ["2024-03-03", null],
    ]);
  });

  test("the loader gets the chart's window and the typed symbol, and its result carries the unit and warning", async () => {
    let request: SeriesLoadRequest | null = null;
    const now = new Date("2026-06-15T00:00:00Z");
    const resolved = await resolveLoadedSeries({
      id: "lab:fee",
      name: "Lending fee",
      unit: "%",
      frequency: "weekly",
      input: "ticker",
      style: "step",
      load: (received) => {
        request = received;
        return { points: [{ date: "2026-06-01", value: 0.5 }], warning: "cached" };
      },
    }, { viewport: { range: "1Y", resolution: "auto" }, ticker: "aapl" }, now);
    expect(request!).toMatchObject({ ticker: "AAPL", start: new Date("2025-06-15T00:00:00Z") });
    expect(resolved).toMatchObject({
      id: "lab:fee/AAPL",
      label: "AAPL · Lending fee",
      unit: "%",
      unitGroup: "percent",
      nativeFrequency: "weekly",
      style: "step",
      interpolation: "step-after",
      warning: "cached",
    });
    expect(seriesLoadWindow({ range: "ALL", resolution: "auto" })).toEqual({});
    expect(seriesLoadWindow({ range: "1Y", resolution: "auto", dateWindow: { start: "2024-01-01", end: "2024-02-01" } }))
      .toEqual({ start: new Date("2024-01-01"), end: new Date("2024-02-01") });
  });
});

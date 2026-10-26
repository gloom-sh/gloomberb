import { describe, expect, test } from "bun:test";
import { SeriesRegistry, capabilitySeriesId, seriesExpression } from "./registry";
import { normalizeSeriesPoints, resolveLoadedSeries, seriesLoadWindow } from "./resolve";
import { chartSeriesResolveOutputSchema } from "../capabilities/chart-series";
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

  test("a series drawn over a price needs a ticker, and its lines need ids of their own", () => {
    expect(() => validateSeriesDefinition(loaded({ placement: "price" }))).toThrow(/needs a ticker input/);
    expect(() => validateSeriesDefinition(loaded({ placement: "above" as never, input: "ticker" }))).toThrow(/placement/);
    const line = { id: "mid", name: "Middle" };
    expect(() => validateSeriesDefinition(loaded({ lines: [line, { ...line, name: "Again" }] } as never))).toThrow(/own id/);
    expect(() => validateSeriesDefinition(loaded({ lines: [{ id: "a~b", name: "Tilde" }] } as never))).toThrow(/own id/);
    expect(() => validateSeriesDefinition(loaded({ lines: [] } as never))).toThrow(/1 to 16 lines/);
    const lines = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `line-${index}`, name: `Line ${index}` }));
    expect(() => validateSeriesDefinition(loaded({ lines: lines(16) } as never))).not.toThrow();
    expect(() => validateSeriesDefinition(loaded({ lines: lines(17) } as never))).toThrow(/1 to 16 lines/);
    expect(() => validateSeriesDefinition(loaded({ input: "ticker", placement: "price", lines: [line, { id: "up", name: "Upper", style: "step" }] } as never))).not.toThrow();
    expect(() => validateSeriesDefinition(loaded({ lines: [{ ...line, color: "blue" }] } as never))).toThrow(/#rrggbb/);
    expect(() => validateSeriesDefinition(loaded({ lines: [{ ...line, fill: "mid" }] } as never))).toThrow(/not another of its lines/);
    expect(() => validateSeriesDefinition(loaded({ lines: [{ ...line, fill: "gone" }] } as never))).toThrow(/not another of its lines/);
    expect(() => validateSeriesDefinition(loaded({ lines: [{ ...line, color: "#2962ff", fill: "low" }, { id: "low", name: "Lower" }] } as never))).not.toThrow();
  });

  test("public labels say what the data is, never the host or the service it is fetched from", () => {
    const words = hostLabelWords(["api.rainco.example", "rainco.example", "x.io"]);
    expect(words).toEqual(["rainco"]);
    expect(() => validateSeriesDefinition(loaded({ name: "RainCo rainfall" }), { forbiddenWords: words })).toThrow(/rainco/);
    expect(() => validateSeriesDefinition(loaded({ tags: ["via rainco"] }), { forbiddenWords: words })).toThrow(/tag/);
    expect(() => validateSeriesDefinition(loaded({ publisher: "rain.com" }))).toThrow(/names a host/);
    expect(() => validateSeriesDefinition(loaded({ description: "from provider:rain-feed" }))).toThrow(/internal source/);
    expect(() => validateSeriesDefinition(loaded({ name: "Raincoat sales" }), { forbiddenWords: words })).not.toThrow();
    // A government host is the publisher itself; a vendor's host is still forbidden beside it.
    expect(hostLabelWords(["api.eia.gov", "www.ons.gov.uk", "api.rainco.example"])).toEqual(["rainco"]);
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

  test("a series with lines lists each line's expression and charts one line at a time, the first when none is named", () => {
    const registry = new SeriesRegistry();
    registry.register("lab", loaded({
      id: "lab:bands",
      input: "ticker",
      placement: "panel",
      lines: [{ id: "mid", name: "Middle" }, { id: "up", name: "Upper", style: "step" }],
    } as never));
    const [entry] = registry.catalog();
    expect(entry).toMatchObject({
      expression: "CAP:lab:bands/{ticker}",
      placement: "panel",
      lines: [
        { id: "mid", name: "Middle", expression: "CAP:lab:bands~mid/{ticker}" },
        { id: "up", name: "Upper", style: "step", expression: "CAP:lab:bands~up/{ticker}" },
      ],
    });
    expect(capabilitySeriesId(registry.get("lab:bands")!.definition, "aapl", "up")).toBe("bands~up/AAPL");
    expect(registry.findLoaded("lab", "bands~up/AAPL")).toMatchObject({ ticker: "AAPL", line: { id: "up" } });
    expect(registry.findLoaded("lab", "bands/AAPL")?.line?.id).toBe("mid");
    expect(registry.findLoaded("lab", "bands~gone/AAPL")).toBeNull();
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

  test("the loader gets the chart's window and the typed symbol, and its result carries the unit, warning and attribution", async () => {
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
        return { points: [{ date: "2026-06-01", value: 0.5 }], warning: "cached", attribution: { source: "FINRA series FEE", publisher: "FINRA" } };
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
    // A report cites what the loader named only if the resolve boundary lets it through.
    expect(chartSeriesResolveOutputSchema.parse(resolved).attribution).toEqual({ source: "FINRA series FEE", publisher: "FINRA" });
    expect(() => chartSeriesResolveOutputSchema.parse({ ...resolved, attribution: { source: "" } })).toThrow();
    expect(seriesLoadWindow({ range: "ALL", resolution: "auto" })).toEqual({});
    expect(seriesLoadWindow({ range: "1Y", resolution: "auto", dateWindow: { start: "2024-01-01", end: "2024-02-01" } }))
      .toEqual({ start: new Date("2024-01-01"), end: new Date("2024-02-01") });
  });
});

describe("a series with lines", () => {
  test("loads once for the lines a chart asks for together, and each line gets its points, name, colour and style", async () => {
    const requests: SeriesLoadRequest[] = [];
    const definition = {
      id: "lab:bands",
      name: "Bands",
      unit: "currency",
      frequency: "daily",
      input: "ticker",
      placement: "price",
      lines: [{ id: "mid", name: "Middle" }, { id: "up", name: "Upper", style: "step" }],
      load: async (request: SeriesLoadRequest) => {
        requests.push(request);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { lines: { mid: [{ date: "2026-06-01", value: 10 }], up: [{ date: "2026-06-01", value: 12 }] } };
      },
    } as const;
    const viewport = { range: "5Y", resolution: "auto" } as const;
    const now = new Date("2026-06-15T00:00:00Z");
    const [mid, up] = await Promise.all([
      resolveLoadedSeries(definition as never, { viewport, ticker: "aapl", line: definition.lines[0] }, now),
      resolveLoadedSeries(definition as never, { viewport, ticker: "aapl", line: definition.lines[1] }, now),
    ]);
    expect(requests).toHaveLength(1);
    // A 5Y chart draws weekly bars unless it was set otherwise; the loader computes on the same bars.
    expect(requests[0]).toMatchObject({ ticker: "AAPL", resolution: "1wk" });
    expect(mid).toMatchObject({ id: "lab:bands~mid/AAPL", label: "AAPL · Bands · Middle", style: "line", priceOf: "AAPL" });
    expect(up).toMatchObject({ id: "lab:bands~up/AAPL", label: "AAPL · Bands · Upper", style: "step", interpolation: "step-after" });
    expect(mid.points.map((point) => point.value)).toEqual([10]);
    expect(up.points.map((point) => point.value)).toEqual([12]);
    expect(mid.color).not.toBe(up.color);
    expect(chartSeriesResolveOutputSchema.parse(mid).priceOf).toBe("AAPL");
  });

  test("a line keeps its own colour, and a line filled to another spans to it as a band", async () => {
    const definition = {
      id: "lab:channel",
      name: "Channel",
      unit: "currency",
      frequency: "daily",
      input: "ticker",
      lines: [{ id: "up", name: "Upper", color: "#2962ff", fill: "low" }, { id: "low", name: "Lower" }],
      load: () => ({ lines: {
        up: [{ date: "2026-06-01", value: 12 }, { date: "2026-06-02", value: 13 }],
        low: [{ date: "2026-06-01", value: 8 }, { date: "2026-06-02", value: null }],
      } }),
    } as const;
    const viewport = { range: "1Y", resolution: "auto" } as const;
    const up = await resolveLoadedSeries(definition as never, { viewport, ticker: "AAPL", line: definition.lines[0] });
    expect(up.color).toBe("#2962ff");
    expect(up.points.map(({ value, low, high }) => [value, low ?? null, high ?? null])).toEqual([[12, 8, 12], [13, null, null]]);
    const registry = new SeriesRegistry();
    registry.register("lab", definition as never);
    expect(registry.catalog()[0]!.lines!.map((line) => line.style ?? "line")).toEqual(["band", "line"]);
  });

  test("the shared load is called off once every line that asked for it is", async () => {
    let aborted: unknown = null;
    const definition = {
      id: "lab:slow",
      name: "Slow",
      unit: "points",
      frequency: "daily",
      input: "ticker",
      lines: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      load: (request: SeriesLoadRequest) => new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () => { aborted = request.signal!.reason; reject(request.signal!.reason); });
      }),
    } as const;
    const viewport = { range: "1Y", resolution: "auto" } as const;
    const first = new AbortController();
    const second = new AbortController();
    const a = resolveLoadedSeries(definition as never, { viewport, ticker: "AAPL", line: definition.lines[0], signal: first.signal }).catch((error) => error);
    const b = resolveLoadedSeries(definition as never, { viewport, ticker: "AAPL", line: definition.lines[1], signal: second.signal }).catch((error) => error);
    first.abort("closed");
    expect(await a).toBe("closed");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(aborted).toBeNull();
    second.abort("closed");
    expect(await b).toBe("closed");
    expect(aborted).toBe("closed");
  });
});

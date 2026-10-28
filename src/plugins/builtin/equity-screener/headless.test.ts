import { expect, test } from "bun:test";
import { KPI_FIELDS } from "../../../api-client/equity-screener";
import { isProLock } from "../../../cli/pane-functions/access-gate";
import { MAX_TOOL_RESULT_BYTES } from "../cloud/askg/protocol";
import { equityScreenerHeadless } from "./headless";
import { SCREEN_IDEAS } from "./ideas";
import { parseScreenDefinition } from "./model";
import { screenFixture } from "./test-fixture";

test("a full page with more matches is neither an error nor too large for an Ask Gloom tool result", async () => {
  const data = screenFixture();
  const row = data.rows[0]!;
  data.rows = Array.from({ length: 100 }, (_, index) => ({ ...row, symbol: `S${index}` }));
  // Sparse fields make every real payload "partial"; that is not a failure.
  Object.assign(data, { status: "partial", nextCursor: "next", universe: { ...data.universe, covered: 700, matched: 680 } });
  const apiClient = { equityScreener: async () => structuredClone(data) };
  const result = await equityScreenerHeadless.load({ argument: undefined, options: {} } as never, { apiClient } as never);
  expect(result.errors).toEqual([]);
  expect(result.complete).toBe(false);
  expect(result.metadata).toMatchObject({ matched: 680, returned: 100, hasMore: true,
    notices: ["Top 100 of 680 matches; --limit lists up to 500, or narrow the criteria to see the rest."] });
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(MAX_TOOL_RESULT_BYTES);

  data.warnings = ["Bounded scan: some listings were not evaluated."];
  const bounded = await equityScreenerHeadless.load({ argument: undefined, options: {} } as never, { apiClient } as never);
  expect(bounded.errors).toEqual(data.warnings);
});

test("ATR% can be the metric, and the help says what it is and that IV rank is a rank", async () => {
  const data = screenFixture();
  data.rows[0]!.metrics.atrPercent = { ...data.rows[0]!.metrics.atrPercent, value: 3.456, unit: "%", asOf: "2026-09-21", state: "available", scope: "derived" };
  const apiClient = { equityScreener: async () => structuredClone(data) };
  const result = await equityScreenerHeadless.load({ argument: undefined, options: { metric: "atrPercent" } } as never, { apiClient } as never);
  const section = result.sections![0]!;
  expect(section.columns!.find((column) => column.key === "value")!.header).toBe("ATR%");
  expect(section.rows![0]).toMatchObject({ value: "3.5", unit: "%", asOf: "2026-09-21", state: "available" });
  expect(equityScreenerHeadless.options.find((option) => option.key === "metric")!.values).toContainEqual({ value: "atrPercent" });
  const limitations = equityScreenerHeadless.discovery!.limitations!.join(" ");
  expect(limitations).toContain("ATR% is the 14-session average true range as a percent of the last close");
  expect(limitations).toContain("IV rank is a rank, not an IV percentile");
});

test("the catalog's example definition passes the real validator, and a bad one names the part and the operators", () => {
  const option = equityScreenerHeadless.options.find((candidate) => candidate.key === "definition")!;
  // The shell quoting is the catalog's: the JSON sits between single quotes.
  const json = /^--definition '(.+)'$/.exec(option.example!)![1]!;
  const definition = parseScreenDefinition(JSON.parse(json));
  expect(definition.criteria.map((criterion) => criterion.op)).toEqual(["in", "gte", "between"]);
  expect(option.normalize!(json)).toBe(json);
  expect(() => option.normalize!(JSON.stringify({ ...definition, criteria: [{ field: "industry", op: "eq", value: "Gold" }] })))
    .toThrow(/criteria\[0\] \(industry\): op "eq" is not supported: industry takes in, present, missing\. The example in gloom catalog EQS/);
  expect(() => option.normalize!('{"version":1}')).toThrow(/criteria is missing.*sort is missing.*currency is missing/);
});

test("a KPI the server holds back from Free says why once, in KPIS's words; a Pro KPI with gaps says what a gap is", async () => {
  // The server leaves KPI and guidance fields out of every row for a caller without Gloom Pro.
  const free = screenFixture();
  for (const row of free.rows) for (const field of KPI_FIELDS) delete (row.metrics as Partial<typeof row.metrics>)[field];
  const load = (data: typeof free) => equityScreenerHeadless.load({ argument: undefined, options: { metric: "kpiBacklog" } } as never,
    { apiClient: { equityScreener: async () => structuredClone(data) } } as never);
  const locked = await load(free);
  expect(locked.errors).toEqual(["The free screener shows no KPI values; Gloom Pro shows each company's Backlog."]);
  expect(isProLock(locked.errors![0]!)).toBe(true);
  expect(locked.sections![0]!.rows![0]).toMatchObject({ value: "--", state: "locked" });
  expect(locked.notes).toBeUndefined();

  const pro = await load(screenFixture());
  expect(pro.errors).toEqual([]);
  expect(pro.sections![0]!.rows![0]).toMatchObject({ state: "unavailable" });
  expect(pro.notes).toEqual(["1 of 1 row has no Backlog. Coverage follows available company disclosures; missing data is not zero."]);
});

test("a screen its currency emptied says the currency keeps only listings quoted in it, and gives the screen in USD", async () => {
  // A CAD screen of tobacco companies said "No data." though the USD one lists seven.
  const tobacco = { ...screenFixture(), rows: [] };
  tobacco.definition = { ...tobacco.definition, currency: "CAD", criteria: [{ field: "industry", op: "in", value: ["Tobacco"] }] };
  tobacco.universe = { ...tobacco.universe, covered: 4287, matched: 0, currencies: ["USD", "CAD"] };
  const load = async (data: typeof tobacco) => {
    const result = await equityScreenerHeadless.load({ argument: undefined, options: { definition: JSON.stringify(data.definition) } } as never,
      { apiClient: { equityScreener: async () => structuredClone(data) } } as never);
    return (result.sections![0] as { empty?: string }).empty;
  };
  const empty = (await load(tobacco))!.split("\n");
  expect(empty[0]).toBe("No listing quoted in CAD matches. Currency CAD keeps only the listings quoted in CAD and converts nothing.");
  const base = JSON.parse(/--definition '(.+)'$/.exec(empty[1]!)![1]!);
  expect(empty[1]).toStartWith("In the base currency, USD: gloom fn EQS --definition '");
  expect(base).toEqual({ ...tobacco.definition, currency: "USD" });
  // A currency no covered listing is quoted in says so; an empty screen in USD keeps the plain empty line.
  const usdOnly = { ...tobacco, universe: { ...tobacco.universe, currencies: ["USD"] } };
  expect(await load(usdOnly)).toStartWith("None of the 4,287 covered listings is quoted in CAD. Currency CAD keeps only the listings quoted in CAD and converts nothing; the covered listings are quoted in USD.");
  expect(await load({ ...tobacco, definition: { ...tobacco.definition, currency: "USD" } })).toBeUndefined();
});

test("--preset golden-cross runs the Ideas screen on days since the cross, and a preset is one choice of three", async () => {
  const data = screenFixture();
  data.definition = structuredClone(SCREEN_IDEAS.find((idea) => idea.id === "golden-cross")!.definition);
  data.rows[0]!.metrics.goldenCrossDays = { ...data.rows[0]!.metrics.goldenCrossDays, value: 4, unit: "days", asOf: "2026-09-21", state: "available", scope: "derived" };
  const queried: unknown[] = [];
  const apiClient = { equityScreener: async (_path: string, init?: { body?: string }) => {
    const { version, currency, criteria, sort } = JSON.parse(init!.body!);
    queried.push({ version, currency, criteria, sort });
    return structuredClone(data);
  } };
  const load = (options: Record<string, string>) => equityScreenerHeadless.load({ argument: undefined, options } as never, { apiClient } as never);
  const result = await load({ preset: "golden-cross" });
  expect(queried[0]).toEqual({
    version: 1,
    currency: "USD",
    criteria: [{ field: "goldenCrossDays", op: "lte", value: 10 }, { field: "marketCap", op: "gte", value: 2_000_000_000 }],
    sort: { field: "goldenCrossDays", direction: "asc" },
  });
  const section = result.sections![0]!;
  expect(section.columns!.find((column) => column.key === "value")!.header).toBe("GOLDEN X AGO");
  expect(section.rows![0]).toMatchObject({ symbol: "AAPL", value: "4", unit: "days", asOf: "2026-09-21" });
  // --metric still names the column.
  const priced = await load({ preset: "golden-cross", metric: "priceVsSma200Percent" });
  expect(priced.sections![0]!.columns!.find((column) => column.key === "value")!.header).toBe("VS SMA200%");

  expect(equityScreenerHeadless.options.find((option) => option.key === "preset")!.values!.map((value) => value.value))
    .toEqual(SCREEN_IDEAS.map((idea) => idea.id));
  await expect(load({ preset: "golden-cross", saved: "Growth" })).rejects.toThrow("Choose one of --preset, --saved and --definition.");
  // Every idea is a definition the validator takes.
  for (const idea of SCREEN_IDEAS) expect(parseScreenDefinition(idea.definition)).toEqual(idea.definition);
});

test("--limit pages to its rows; the sort field and every --metric get a column, and the states shown are explained", async () => {
  const data = screenFixture();
  data.definition = { ...data.definition, sort: { field: "dividendYieldPercent", direction: "desc" } };
  const metric = (value: number, state: "partial" | "stale") => ({ ...data.rows[0]!.metrics.trailingPE, value, state });
  const row = (symbol: string, yieldPercent: number, state: "partial" | "stale") => ({
    ...data.rows[0]!, symbol,
    metrics: { ...data.rows[0]!.metrics, trailingPE: metric(15, state), beta: metric(0.8, "partial"),
      dividendYieldPercent: { ...metric(yieldPercent, "partial"), unit: "%" } },
  });
  const pages = [[row("EIX", 6, "partial"), row("AVA", 5.3, "stale")], [row("POR", 5, "partial")]];
  const asked: Array<{ limit: number; cursor: string | null }> = [];
  const apiClient = { equityScreener: async (_path: string, init?: { body?: string }) => {
    const { limit, cursor } = JSON.parse(init!.body!);
    asked.push({ limit, cursor });
    const page = asked.length - 1;
    return structuredClone({ ...data, rows: pages[page]!, nextCursor: page === 0 ? "next" : null,
      universe: { ...data.universe, covered: 700, matched: 3 } });
  } };
  const result = await equityScreenerHeadless.load({ argument: undefined,
    options: { definition: JSON.stringify(data.definition), metric: "trailingPE,beta", limit: 3 } } as never, { apiClient } as never);
  expect(asked).toEqual([{ limit: 3, cursor: null }, { limit: 1, cursor: "next" }]);
  const section = result.sections![0]!;
  expect(section.rows!.map((entry) => entry.symbol)).toEqual(["EIX", "AVA", "POR"]);
  // P/E leads with its unit, rank, date and state; beta and the sort field follow.
  expect(section.columns!.map((column) => column.key).slice(-3)).toEqual(["state", "beta", "dividendYieldPercent"]);
  expect(section.rows![0]).toMatchObject({ value: "15.0", unit: "x", state: "partial", beta: "0.80", dividendYieldPercent: "6.0" });
  expect(result.notes!.map((note) => note.split(" means ")[0])).toEqual(["A partial State", "A stale State"]);
  expect(result.complete).toBe(true);
  // Repeated flags and a comma list read as one list, each metric once.
  expect(equityScreenerHeadless.options.find((option) => option.key === "metric")!.normalize!("trailingPE, beta,trailingPE"))
    .toBe("trailingPE,beta");
  expect(() => equityScreenerHeadless.options.find((option) => option.key === "metric")!.normalize!("trailingPE,pe"))
    .toThrow('Invalid --metric value "pe"');
});

test("a sector or industry that names nothing says the names it was likely meant as, instead of No data", async () => {
  const run = async (criteria: unknown[], rows: boolean) => {
    const data = screenFixture();
    data.definition = { ...data.definition, criteria: criteria as never };
    if (!rows) data.rows = [];
    data.universe = { ...data.universe, sectors: ["Technology", "Utilities"] };
    const apiClient = { equityScreener: async () => structuredClone(data) };
    return equityScreenerHeadless.load({ argument: undefined, options: { definition: JSON.stringify(data.definition) } } as never,
      { apiClient } as never);
  };
  const empty = await run([{ field: "sector", op: "in", value: ["Utility"] }], false);
  expect((empty.sections![0] as { empty?: string }).empty)
    .toBe('No sector is named "Utility". Closest: Utilities. gloom catalog EQS lists every sector and industry.');
  // With rows, the value that matched nothing is a warning beside them; a sector given as an industry says which it is.
  const some = await run([{ field: "industry", op: "in", value: ["Solar", "Utilities", "Banks"] }], true);
  expect(some.warnings).toEqual(['No industry is named "Utilities"; it is a sector name, so use "field": "sector". '
    + 'No industry is named "Banks". Closest: Banks - Diversified, Banks - Regional. gloom catalog EQS lists every sector and industry.']);
  // A GICS sector name points at the sector it is here.
  const gics = await run([{ field: "sector", op: "in", value: ["Information Technology"] }], false);
  expect((gics.sections![0] as { empty?: string }).empty).toStartWith('No sector is named "Information Technology". Closest: Technology.');
  expect(equityScreenerHeadless.discovery!.reference!.map(({ title, items }) => [title, items.length])).toEqual([["Sectors", 11], ["Industries", 144]]);
});

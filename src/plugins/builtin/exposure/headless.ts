import type { HeadlessPaneColumn, HeadlessPaneDefinition, HeadlessPaneRow } from "../../../types/plugin";
import type { ExposureExtensionObservation, ExposurePayload, ExposureRequest } from "../../../api-client/exposure";
import { clipToDisplayWidth } from "../../../utils/format";
import { humanLabel } from "../shared/research-cells";
import { fetchExposure, fetchScenarios } from "./client";
import { DEFAULT_SCENARIO, exposureCellText, parseCustomScenario, parseHoldings, pathRows, portfolioRows, scenarioTitle, tableRows, TABS, type ExposureRow } from "./model";
import { portfolioHoldings, watchlistHoldings } from "./holdings";
import { driverAmount, driverRows, driverScope } from "./drivers";

/*
 * The text report prints each section as its pane tab draws it: exposure
 * ranges and weights as percents, a driver's value compact with its unit
 * (201.18B USD) and its scope in words. The title names the scenario, so a
 * one-shock scenario needs no shock column. Long names are cut and caveats
 * print under their row, so every table fits a terminal; a holding's own
 * caveats are the report's error lines. CSV, NDJSON and JSON keep the
 * records whole.
 */
type CellId = Parameters<typeof exposureCellText>[1];
type TextRow = ExposureRow & { kind?: string; note?: string | null };
interface TextOptions { right?: boolean; max?: number }
const text = (key: string, header: string, read: (row: TextRow) => string, { right, max }: TextOptions = {}): HeadlessPaneColumn => ({
  key, header, ...(right ? { align: "right" as const } : {}),
  format: (_value, row) => { const value = read(row as unknown as TextRow); return max ? clipToDisplayWidth(value, max) : value; },
});
const cell = (id: CellId, header: string, options?: TextOptions) => text(id, header, row => exposureCellText(row, id), options);
const holding = (header: string) => text("symbol", header, row => row.symbol, { max: 14 });
const period = cell("period", "Period", { max: 18 });
const note: HeadlessPaneColumn = { key: "note", header: "Note", underRow: true };
const textRows = (items: TextRow[]) => items as unknown as HeadlessPaneRow[];
/** Caveats that belong to one row, printed under it; null prints nothing. */
const withNotes = (items: ExposureRow[], read: (row: ExposureRow) => string[]): TextRow[] => items.map(row => ({ ...row, note: read(row).join("\n") || null }));

function holdingColumns(data: ExposurePayload): HeadlessPaneColumn[] {
  return [holding("Holding"), ...(data.scenario.shocks.length > 1 ? [cell("label", "Shock", { max: 16 })] : []), cell("basis", "Basis"),
    cell("exposure", "Exposure %", { right: true }), cell("classification", "Evidence"), cell("impact", "Stress est. %", { right: true }), period, cell("weight", "NAV wt. %", { right: true })];
}
const PATH_COLUMNS = [holding("Holding"), cell("label", "Path", { max: 24 }), cell("basis", "Basis"), cell("exposure", "Exposure %", { right: true }),
  cell("classification", "Evidence"), cell("impact", "Stress est. %", { right: true }), period];

/** A credit line's figures repeat the instrument their scope names: "$1.0 billion revolver: drawn" reads Drawn. */
function driverLabel(driver: ExposureExtensionObservation): string {
  const named = Object.values(driver.dimensions ?? {}).find(value => driver.label.startsWith(`${value}: `));
  const rest = named ? driver.label.slice(named.length + 2) : driver.label;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}
/** The scope in words, after the basis when the figure is not the reported one: Adjusted · diluted. */
function driverScopeText(driver: ExposureExtensionObservation): string {
  return [driver.basis && driver.basis !== "reported" ? humanLabel(driver.basis) : "", driverScope(driver)].filter(Boolean).join(" · ") || "--";
}
const DRIVER_COLUMNS = [holding("Holding"), text("label", "Company driver", row => row.driver ? driverLabel(row.driver) : row.label, { max: 20 }),
  text("value", "Value", row => row.driver ? driverAmount(row.driver) : "--", { right: true }), text("period", "Period", row => row.driver?.period ?? "--", { max: 21 }),
  text("scope", "Scope", row => row.driver ? driverScopeText(row.driver) : "--", { max: 22 }), note];

/**
 * Stress lines are always estimates, so the unknown share of holdings under a
 * line says how partial it is. A concentration's share is unknown or an
 * estimate, so it says only when its bound leaves out relationships without a
 * share, in the word the pane's Bound figure uses. With one holding, which
 * holdings a line covers and their weight say nothing the Holdings table does
 * not.
 */
function portfolioColumns(data: ExposurePayload, concentration: boolean, items: ExposureRow[]): HeadlessPaneColumn[] {
  const several = data.holdings.length > 1;
  // Signed exposure differs from gross only where a holding is short.
  const signed = concentration && items.some(row => JSON.stringify(row.impact) !== JSON.stringify(row.exposure));
  const partial = (row: ExposureRow) => row.incomplete && row.exposure !== null;
  if (concentration) return [text("kind", "Kind", row => humanLabel(row.kind ?? "")), ...(several ? [holding("Holdings")] : []), cell("label", "Target", { max: 26 }),
    cell("basis", "Basis"), cell("exposure", "Gross exp. %", { right: true }), ...(signed ? [cell("impact", "Signed exp. %", { right: true })] : []),
    ...(items.some(partial) ? [text("bound", "Bound", row => partial(row) ? "Incomplete" : "")] : []), period, ...(several ? [cell("weight", "Gross wt. %", { right: true })] : [])];
  return [...(several ? [holding("Holdings")] : []), ...(data.scenario.shocks.length > 1 ? [cell("label", "Target", { max: 16 })] : []), cell("basis", "Basis"),
    cell("exposure", "Exposure %", { right: true }), cell("impact", "Stress est. %", { right: true }), period, cell("weight", "Covered wt. %", { right: true }), note];
}

const CONCENTRATION_VIEWS = ["country", "supplier", "customer"] as const;

export const exposureHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: { status: "not-a-feed", basis: "company disclosures" },
  argument: { kind: "free-text", optional: true, placeholder: "AAPL=60% NVDA=40%", description: "Tickers, signed NAV weights, PORT:<id>, or WATCH:<id>. Unweighted lists and watchlists use equal weights." },
  discovery: { aliases: ["EXPO"], dataRequirements: ["Gloom Cloud geographic revenue, disclosed supply chains, KPIs, guidance and credit disclosures", "Portfolio NAV for local PORT weights"],
    limitations: ["Pro: full holdings and up to four-hop paths; free: one holding, one hop.", "Operating exposure estimates, never predicted stock returns.", "Missing relationships and sensitivities remain unknown.", "Basis and reporting period are kept separate."] },
  options: [
    { key: "scenario", type: "string", settingKey: "scenario", defaultValue: "taiwan-disruption", description: "Library scenario id, or use --custom." },
    { key: "custom", type: "string", settingKey: "customScenario", description: "JSON scenario with label and shocks; supports multiple shocks and explicit transmission assumptions." },
    { key: "depth", type: "integer", settingKey: "depth", defaultValue: 2, minimum: 1, maximum: 4, description: "Maximum relationship hops." },
    { key: "nav", type: "string", settingKey: "nav", description: "Positive portfolio NAV in its configured currency; required for PORT." },
    { key: "cash", type: "string", settingKey: "cash", description: "Explicit cash weight as NAV fraction; no normalization." },
    { key: "tab", type: "enum", settingKey: "tab", defaultValue: "table", values: TABS.map(t => ({ value: t.value })), description: "Pane tab." },
    { key: "view", type: "enum", settingKey: "view", defaultValue: "stress", values: ["stress", "country", "supplier", "customer"].map(value => ({ value })), description: "Portfolio stress or concentration grouping." },
  ],
  describe: (args, result) => {
    const payload = result?.metadata?.payload as ExposurePayload | undefined;
    return `Exposure | ${args.rawArgument || "holdings"}${payload ? ` | ${scenarioTitle(payload.scenario)}` : ""}`;
  },
  async load(args, ctx) {
    const input = args.rawArgument.trim();
    const source = /^(PORT|WATCH):(.+)$/i.exec(input);
    let holdings: ExposureRequest["holdings"];
    if (source?.[1]?.toUpperCase() === "PORT") {
      const local = await ctx.resolvePortfolio?.(source[2]!);
      if (!local) throw new Error(`Unknown local portfolio: ${source[2]}`);
      holdings = await portfolioHoldings(local.portfolio, local.tickers, Number(args.options.nav), ctx.marketData);
    } else if (source) {
      const tickers = await ctx.resolveWatchlist?.(source[2]!);
      if (!tickers) throw new Error(`Unknown local watchlist: ${source[2]}`);
      holdings = watchlistHoldings(tickers, source[2]!);
    } else holdings = parseHoldings(input);
    const id = String(args.options.scenario ?? DEFAULT_SCENARIO.id);
    const scenario = args.options.custom ? parseCustomScenario(String(args.options.custom)) : (await fetchScenarios(ctx.apiClient)).find(s => s.id === id);
    if (!scenario) throw new Error(`Unknown scenario: ${id}`);
    const cashWeight = args.options.cash === undefined ? undefined : Number(args.options.cash);
    if (cashWeight !== undefined && (!Number.isFinite(cashWeight) || Math.abs(cashWeight) > 10)) throw new Error("Cash must be a NAV fraction between -10 and 10.");
    if (ctx.signal.aborted) throw new Error("Exposure analysis cancelled.");
    const data = await fetchExposure({ holdings, scenario, depth: Number(args.options.depth ?? 2), ...(cashWeight === undefined ? {} : { cashWeight }) }, ctx.apiClient);
    const drivers = withNotes(driverRows(data), row => row.driver?.notes ?? []);
    const stress = withNotes(portfolioRows(data, "stress"), row => row.incomplete ? row.unknowns : []);
    const concentrations = CONCENTRATION_VIEWS.flatMap(kind => portfolioRows(data, kind).map(row => ({ ...row, kind })));
    return { complete: data.lockedHoldings === 0 && data.holdings.every(h => h.status === "quantified") && data.unknowns.length === 0,
      errors: [...data.unknowns, ...(data.access === "preview" ? ["Free preview: one holding, depth one. Full analysis requires Pro."] : [])],
      sections: [
        { title: "Holdings", rows: data.holdings.map(h => ({ symbol: h.symbol, weight: h.weight, status: h.status, measures: h.measures, coverage: h.coverage, unknowns: h.unknowns })),
          textColumns: holdingColumns(data), textRows: textRows(tableRows(data)) },
        { title: "Company drivers", rows: data.holdings.flatMap(h => (h.extensions ?? []).map(row => ({ symbol: h.symbol, ...row }))),
          textColumns: DRIVER_COLUMNS, textRows: textRows(drivers) },
        { title: "Paths and evidence", rows: data.holdings.flatMap(h => h.components.map(c => ({ symbol: h.symbol, ...c }))),
          textColumns: PATH_COLUMNS, textRows: textRows(pathRows(data)) },
        { title: "Portfolio operating stress", rows: data.portfolio.measures.map(m => ({ ...m })),
          textColumns: portfolioColumns(data, false, stress), textRows: textRows(stress) },
        { title: "Concentrations", rows: data.portfolio.concentrations.map(c => ({ ...c })),
          textColumns: portfolioColumns(data, true, concentrations), textRows: textRows(concentrations) },
      ], metadata: { payload: data } };
  },
};

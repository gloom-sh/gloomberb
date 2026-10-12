import type { HeadlessPaneColumn, HeadlessPaneDefinition, HeadlessPaneRow } from "../../../types/plugin";
import type { ExposureExtensionObservation, ExposurePayload, ExposureRequest } from "../../../api-client/exposure";
import { cliTerminalWidth } from "../../../utils/cli-output";
import { clipToDisplayWidth, displayWidth } from "../../../utils/format";
import { fiscalLabel } from "../company-kpis/model";
import { humanLabel } from "../shared/research-cells";
import { fetchExposure, fetchScenarios } from "./client";
import { DEFAULT_SCENARIO, exposureCellText, parseCustomScenario, parseHoldings, pathRows, portfolioRows, scenarioTitle, tableRows, TABS, type ExposureRow } from "./model";
import { portfolioHoldings, watchlistHoldings } from "./holdings";
import { describeCollections, findNamedCollection } from "../../../portfolio/collection-name";
import { driverAmount, driverRows, driverScope } from "./drivers";

/*
 * The text report prints each section as its pane tab draws it: exposure
 * ranges and weights as percents, a driver's value compact with its unit
 * (201.18B USD), its fiscal period as KPIS prints it (FY2024) and its scope in
 * words. The title names the scenario, so a one-shock scenario needs no shock
 * column. Every table fits 100 columns, or a narrower terminal: names and
 * scopes take the room the figures leave and are cut at a word only when they
 * cannot fit. Caveats print under their row; a holding's own caveats are the
 * report's error lines. CSV, NDJSON and JSON keep the records whole.
 */
type CellId = Parameters<typeof exposureCellText>[1];
type TextRow = ExposureRow & { kind?: string; note?: string | null };
/** A column's cells, and how far it may narrow to fit: `min` lets it give way, cut at a word; `long` is a fuller form printed only when the whole table fits with it. */
interface TextColumn { key: string; header: string; read: (row: TextRow) => string; right?: boolean; min?: number; long?: (row: TextRow) => string }
type ColumnOptions = Omit<TextColumn, "key" | "header" | "read">;
const REPORT_WIDTH = 100;
/** The space the report renderer puts between columns. */
const GAP = 2;

const column = (key: string, header: string, read: TextColumn["read"], options: ColumnOptions = {}): TextColumn => ({ key, header, read, ...options });
const cell = (id: CellId, header: string, options?: ColumnOptions) => column(id, header, row => exposureCellText(row, id), options);
const holding = (header: string) => column("symbol", header, row => row.symbol);
/** The narrowest a name may get before the table gives up fitting, as the report renderer allows. */
const NAME = 8;
const period = cell("period", "Period");
const note: HeadlessPaneColumn = { key: "note", header: "Note", underRow: true };
const textRows = (items: TextRow[]) => items as unknown as HeadlessPaneRow[];
/** Caveats that belong to one row, printed under it; null prints nothing. */
const withNotes = (items: ExposureRow[], read: (row: ExposureRow) => string[]): TextRow[] => items.map(row => ({ ...row, note: read(row).join("\n") || null }));

/** Whole words that fit `width`, then an ellipsis, with no separator left dangling; a first word too long for it is cut. */
function clipWords(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let kept = "";
  for (const word of text.split(" ")) {
    const next = kept ? `${kept} ${word}` : word;
    if (displayWidth(next) > width - 1) break;
    kept = next;
  }
  kept = kept.replace(/[\s·,;:(/→-]+$/, "");
  return kept ? `${kept}…` : clipToDisplayWidth(text, width);
}
/** The narrowest width past `width` at which a cut cell shows more of its text. */
function revealWidth(text: string, width: number): number {
  const shown = clipWords(text, width);
  for (let next = displayWidth(shown) + 1; next < displayWidth(text); next++) if (clipWords(text, next) !== shown) return next;
  return displayWidth(text);
}

/**
 * Column widths for `rows` within `budget`. The fuller forms print when the
 * whole table fits with them. Otherwise the widest narrowing column gives up
 * a cell at a time until the table fits, or each is at its floor; then the
 * room a word cut leaves goes back, a word at a time, to the cut cell that
 * needs the least of it.
 */
function fit(columns: TextColumn[], rows: TextRow[], budget: number): { read: TextColumn["read"]; width: number }[] {
  const header = (index: number) => displayWidth(columns[index]!.header);
  const measure = (reads: TextColumn["read"][]) => reads.map((read, index) => Math.max(header(index), ...rows.map(row => displayWidth(read(row)))));
  const total = (widths: number[]) => widths.reduce((sum, width) => sum + width, 0) + GAP * (widths.length - 1);
  const long = columns.map(item => item.long ?? item.read);
  const fuller = measure(long);
  if (total(fuller) <= budget) return columns.map((_, index) => ({ read: long[index]!, width: fuller[index]! }));
  const reads = columns.map(item => item.read);
  const narrowing = columns.flatMap((item, index) => item.min === undefined ? [] : [index]);
  const floor = (index: number) => Math.max(columns[index]!.min!, header(index));
  let widths = measure(reads);
  for (let overflow = total(widths) - budget; overflow > 0; overflow--) {
    const widest = narrowing.reduce((pick, index) => widths[index]! > floor(index) && (pick < 0 || widths[index]! > widths[pick]!) ? index : pick, -1);
    if (widest < 0) break;
    widths[widest]!--;
  }
  const shown = (allotted: number[]) => allotted.map((width, index) => !narrowing.includes(index) ? width
    : Math.max(header(index), ...rows.map(row => displayWidth(clipWords(reads[index]!(row), width)))));
  widths = shown(widths);
  for (;;) {
    const spare = budget - total(widths);
    let best: { index: number; width: number } | null = null;
    for (const index of narrowing) for (const row of rows) {
      const text = reads[index]!(row);
      if (displayWidth(text) <= widths[index]!) continue;
      const width = revealWidth(text, widths[index]!);
      if (width - widths[index]! <= spare && (!best || width - widths[index]! < best.width - widths[best.index]!)) best = { index, width };
    }
    if (!best) break;
    widths = shown(widths.map((width, index) => index === best!.index ? best!.width : width));
  }
  return columns.map((_, index) => ({ read: reads[index]!, width: widths[index]! }));
}

/** The text report's columns for these rows, fitted when they print, to 100 columns or the terminal when it is narrower. */
function fitted(columns: TextColumn[], rows: TextRow[], under: HeadlessPaneColumn[] = []): HeadlessPaneColumn[] {
  const layouts = new Map<number, ReturnType<typeof fit>>();
  const layout = () => {
    const budget = Math.min(REPORT_WIDTH, cliTerminalWidth() ?? REPORT_WIDTH);
    if (!layouts.has(budget)) layouts.set(budget, fit(columns, rows, budget));
    return layouts.get(budget)!;
  };
  return [...columns.map((item, index): HeadlessPaneColumn => ({ key: item.key, header: item.header, ...(item.right ? { align: "right" as const } : {}),
    format: (_value, row) => { const { read, width } = layout()[index]!; return clipWords(read(row as unknown as TextRow), width); } })), ...under];
}

function holdingColumns(data: ExposurePayload): TextColumn[] {
  return [holding("Holding"), ...(data.scenario.shocks.length > 1 ? [cell("label", "Shock", { min: NAME })] : []), cell("basis", "Basis"),
    cell("exposure", "Exposure %", { right: true }), cell("classification", "Evidence", { min: 10 }), cell("impact", "Stress est. %", { right: true }), period, cell("weight", "NAV wt. %", { right: true })];
}
const PATH_COLUMNS = [holding("Holding"), cell("label", "Path", { min: NAME }), cell("basis", "Basis"), cell("exposure", "Exposure %", { right: true }),
  cell("classification", "Evidence", { min: 10 }), cell("impact", "Stress est. %", { right: true }), period];

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
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/**
 * A disclosure's fiscal period as KPIS prints it, FY2024 or Q3 FY2026, with
 * the date it ended (FY2024 · Sep 28, 2024) as the fuller form. The source
 * words it freely; wording that is not a fiscal year or quarter prints as is.
 */
function driverPeriod(driver: ExposureExtensionObservation): { short: string; long: string } {
  const text = driver.period?.trim() || "--";
  const match = /^(?:full\s+)?(?:Q([1-4])\s+)?(?:fiscal(?:\s+year)?\s+|FY\s?)(\d{4})(?:\s+ended\s+(.+))?$/i.exec(text);
  if (!match) return { short: text, long: text };
  const quarter = match[1] ? Number(match[1]) : null;
  const short = fiscalLabel({ period: { start: null, end: null, kind: quarter ? "quarter" : "year", fiscalYear: Number(match[2]), fiscalQuarter: quarter, label: text } });
  const ended = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(match[3]?.trim() ?? "");
  const month = ended && MONTHS.includes(ended[1]!.toLowerCase()) ? `${ended[1]!.charAt(0).toUpperCase()}${ended[1]!.slice(1).toLowerCase()}` : null;
  return { short, long: month ? `${short} · ${month} ${ended![2]}, ${ended![3]}` : short };
}
const DRIVER_COLUMNS = [holding("Holding"), column("label", "Company driver", row => row.driver ? driverLabel(row.driver) : row.label, { min: NAME }),
  column("value", "Value", row => row.driver ? driverAmount(row.driver) : "--", { right: true }),
  column("period", "Period", row => row.driver ? driverPeriod(row.driver).short : "--", { min: 10, long: row => row.driver ? driverPeriod(row.driver).long : "--" }),
  column("scope", "Scope", row => row.driver ? driverScopeText(row.driver) : "--", { min: NAME })];

/**
 * An anonymous counterparty leads with the name its filing gives it, and the
 * Kind column already says what it is: "Undisclosed customer (Customer one)"
 * reads "Customer one (undisclosed)", which still tells two apart when cut.
 */
const targetName = (row: TextRow) => {
  const match = row.kind ? new RegExp(`^Undisclosed ${row.kind} \\((.+)\\)$`, "i").exec(row.label) : null;
  return match ? `${match[1]} (undisclosed)` : row.label;
};

/**
 * Stress lines are always estimates, so the unknown share of holdings under a
 * line says how partial it is. A concentration's share is unknown or an
 * estimate, so it says only when its bound is partial, leaving out
 * relationships without a share. With one holding, which
 * holdings a line covers and their weight say nothing the Holdings table does
 * not.
 */
function portfolioColumns(data: ExposurePayload, concentration: boolean, items: ExposureRow[]): TextColumn[] {
  const several = data.holdings.length > 1;
  // Signed exposure differs from gross only where a holding is short.
  const signed = concentration && items.some(row => JSON.stringify(row.impact) !== JSON.stringify(row.exposure));
  const partial = (row: ExposureRow) => row.incomplete && row.exposure !== null;
  const holdings = several ? [holding("Holdings")] : [];
  if (concentration) return [column("kind", "Kind", row => humanLabel(row.kind ?? "")), ...holdings, column("label", "Target", targetName, { min: NAME }),
    cell("basis", "Basis"), cell("exposure", "Gross exp. %", { right: true }), ...(signed ? [cell("impact", "Signed exp. %", { right: true })] : []),
    ...(items.some(partial) ? [column("bound", "Bound", row => partial(row) ? "Partial" : "")] : []), period, ...(several ? [cell("weight", "Gross wt. %", { right: true })] : [])];
  return [...holdings, ...(data.scenario.shocks.length > 1 ? [cell("label", "Target", { min: NAME })] : []), cell("basis", "Basis"),
    cell("exposure", "Exposure %", { right: true }), cell("impact", "Stress est. %", { right: true }), period, cell("weight", "Covered wt. %", { right: true })];
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
      if (!local) throw new Error(`Unknown local portfolio: ${source[2]}.${ctx.config.portfolios.length ? ` Portfolios: ${describeCollections(ctx.config.portfolios)}.` : ""}`);
      holdings = await portfolioHoldings(local.portfolio, local.tickers, Number(args.options.nav), ctx.marketData);
    } else if (source) {
      const tickers = await ctx.resolveWatchlist?.(source[2]!);
      if (!tickers) throw new Error(`Unknown local watchlist: ${source[2]}.${ctx.config.watchlists.length ? ` Watchlists: ${describeCollections(ctx.config.watchlists)}.` : ""}`);
      // The host reads the name in any case; membership is kept under the configured id.
      holdings = watchlistHoldings(tickers, findNamedCollection(ctx.config.watchlists, source[2])?.id ?? source[2]!);
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
    const holdingRows = tableRows(data), paths = pathRows(data);
    return { complete: data.lockedHoldings === 0 && data.holdings.every(h => h.status === "quantified") && data.unknowns.length === 0,
      errors: [...data.unknowns, ...(data.access === "preview" ? ["Free preview: one holding, depth one. Full analysis requires Pro."] : [])],
      sections: [
        { title: "Holdings", rows: data.holdings.map(h => ({ symbol: h.symbol, weight: h.weight, status: h.status, measures: h.measures, coverage: h.coverage, unknowns: h.unknowns })),
          textColumns: fitted(holdingColumns(data), holdingRows), textRows: textRows(holdingRows) },
        { title: "Company drivers", rows: data.holdings.flatMap(h => (h.extensions ?? []).map(row => ({ symbol: h.symbol, ...row }))),
          textColumns: fitted(DRIVER_COLUMNS, drivers, [note]), textRows: textRows(drivers) },
        { title: "Paths and evidence", rows: data.holdings.flatMap(h => h.components.map(c => ({ symbol: h.symbol, ...c }))),
          textColumns: fitted(PATH_COLUMNS, paths), textRows: textRows(paths) },
        { title: "Portfolio operating stress", rows: data.portfolio.measures.map(m => ({ ...m })),
          textColumns: fitted(portfolioColumns(data, false, stress), stress, [note]), textRows: textRows(stress) },
        { title: "Concentrations", rows: data.portfolio.concentrations.map(c => ({ ...c })),
          textColumns: fitted(portfolioColumns(data, true, concentrations), concentrations), textRows: textRows(concentrations) },
      ], metadata: { payload: data } };
  },
};

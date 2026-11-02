import type { CotClass, CotClassSummary, CotContractPayload, CotHistoryPoint } from "../../../api-client/cot";
import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchCotBoard, fetchCotContract } from "./client";
import { COT_CLASSES, COT_FAMILIES, COT_MAJOR_CODES, COT_POSITIONS, COT_SCOPES, cotClass, cotContractCode, cotContractUnitText, cotFamily, cotInteger, cotMarketName, cotPositions, cotPositionsText, cotProxyFor, cotProxyNote, cotReleaseTime, cotScope, cotUnknownMarketMessage } from "./model";
import { COMMODITIES_VIEW_STATE } from "../commodities-energy/view-state";
import { REPORT_ROWS } from "../shared/headless-options";

const camelClass = (id: CotClass) => id.replace(/-(\w)/g, (_match, letter: string) => letter.toUpperCase());
const rounded = (value: number | null, digits: number) => value == null ? null : Number(value.toFixed(digits));
const count = (value: unknown) => cotInteger(typeof value === "number" ? value : null);
const signed = (value: unknown) => cotInteger(typeof value === "number" ? value : null, true);
const percent = (value: unknown) => typeof value === "number" ? `${value > 0 ? "+" : ""}${value.toFixed(1)}%` : "--";
const rank = (value: unknown) => typeof value === "number" ? value.toFixed(0) : "--";

/** The report's release, by the CFTC's schedule, for an export's publication time; nothing outside the schedule. */
function cotReleased(asOf: string | null) {
  const publishedAt = cotReleaseTime(asOf);
  return publishedAt ? { freshness: { publishedAt } } : {};
}

/** The pane's columns: percentiles as their rank value, net share of open interest to one decimal. */
function cotPositionRow(row: CotClassSummary) {
  return { long: row.long, short: row.short, spreading: row.spreading, net: row.net,
    netPercentOfOpenInterest: rounded(row.netPercentOfOpenInterest, 1), weeklyChange: row.weeklyChange, previousReportDate: row.previousReportDate,
    oneYearPercentile: rounded(row.percentile1Y.value, 0), threeYearPercentile: rounded(row.percentile3Y.value, 0) };
}
/**
 * A market's title line: its name, the report date (the Tuesday the positions
 * are of) and what one contract is, so a net of +207,879 reads in ounces too.
 */
function cotContractTitle(data: CotContractPayload, code: string): string {
  const units = cotContractUnitText(data.contract?.contractUnits);
  return [data.contract ? cotMarketName(data.contract.marketName) : code, data.asOf ? `report date ${data.asOf}` : null, units,
    data.scope === "combined" ? cotPositionsText(data.scope) : null].filter(Boolean).join("  ·  ");
}
/** Every trader class of every report, each once, in the reports' order. */
const TRADER_CLASSES = [...new Set(Object.values(COT_CLASSES).flat().map(({ value }) => value))];

/** The weekly reports newest first, the newest `limit` of them when given. */
function cotWeeklyRows(history: readonly CotHistoryPoint[], limit: number | null): CotHistoryPoint[] {
  const newest = [...history].reverse();
  return limit == null ? newest : newest.slice(0, limit);
}

const POSITION_COLUMNS: HeadlessPaneColumn[] = [
  { key: "net", header: "Net", align: "right", format: signed },
  { key: "weeklyChange", header: "1W Δ", align: "right", format: signed },
  { key: "netPercentOfOpenInterest", header: "Net % OI", align: "right", format: percent },
  { key: "oneYearPercentile", header: "Pctl 1Y", align: "right", format: rank },
  { key: "threeYearPercentile", header: "Pctl 3Y", align: "right", format: rank },
];

export const cotHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  // Tuesday positions published the Friday after; two weeks without a new report means one was missed.
  freshness: { source: "CFTC", status: "not-a-feed", basis: "weekly report", maxAgeMinutes: 14 * 24 * 60 },
  argument: { kind: "free-text", optional: true, placeholder: "code or name", description: "Futures root (KC), commodity name (coffee) or CFTC market code; omit for the extremes board." },
  options: [{ key: "report", type: "enum", values: COT_FAMILIES.map(({ value }) => ({ value })), defaultValue: "legacy", description: "CFTC report: legacy, disaggregated, or tff (Traders in Financial Futures)." },
    { key: "traderClass", type: "enum", values: TRADER_CLASSES.map((value) => ({ value })), description: "Trader class for the extremes board; defaults by report family.",
      pluginState: { pluginId: COMMODITIES_VIEW_STATE.cot, key: "class" } },
    { key: "positions", type: "enum", values: COT_POSITIONS.map(({ value }) => ({ value })), defaultValue: "futures-only", description: "Futures positions only, or futures and options combined, as in the pane.",
      pluginState: { pluginId: COMMODITIES_VIEW_STATE.cot, key: "positions" } },
    { key: "scope", type: "enum", values: COT_SCOPES.map(({ value }) => ({ value })), defaultValue: "major", description: "Markets on the extremes board, as in the pane.",
      pluginState: { pluginId: COMMODITIES_VIEW_STATE.cot, key: "scope" } },
    // Weekly reports come newest first, so --tail asks for the same newest n as --limit.
    { key: "limit", type: "integer", aliases: ["tail", "weeks", "rows"], minimum: 1, maximum: 2000, shot: REPORT_ROWS,
      description: "Newest weekly reports a market lists; every one by default." }],
  discovery: { aliases: ["COT", "CFTC"], dataRequirements: ["Gloom Cloud CFTC history"], limitations: ["Positions aggregate all maturities; combined adds options, delta-adjusted.", "Legacy, disaggregated and TFF classes differ.", "Observation date is not publication date.", "Some markets have short or suppressed histories."] },
  describe: "CFTC positioning",
  async load(args, ctx) {
    const family = cotFamily(args.options.report);
    const positions = cotPositions(args.options.positions);
    if (args.argument) {
      const code = cotContractCode(args.argument);
      if (!code) throw new Error(cotUnknownMarketMessage(args.argument));
      const proxy = cotProxyFor(args.argument);
      const data = await fetchCotContract(code, family, ctx.apiClient, positions);
      const classes = data.positions.map((row) => row.id);
      const limit = args.options.limit == null ? null : Number(args.options.limit);
      const weeks = cotWeeklyRows(data.history, limit);
      return { sections: [{ title: cotContractTitle(data, code),
        columns: [{ key: "class", header: "Class" }, { key: "long", header: "Long", align: "right", format: count },
          { key: "short", header: "Short", align: "right", format: count }, ...POSITION_COLUMNS],
        rows: data.positions.map((row) => ({ class: row.label, ...cotPositionRow(row) })) },
      { title: weeks.length < data.history.length ? `Weekly positions  ·  newest ${weeks.length} of ${data.history.length}` : "Weekly positions",
        columns: [{ key: "reportDate", header: "Report date" }, { key: "openInterest", header: "Open interest", align: "right", format: count },
          ...classes.map((id) => ({ key: `${camelClass(id)}Net`, header: `${data.positions.find((row) => row.id === id)?.label ?? id} net`, align: "right" as const, format: signed }))],
        rows: weeks.map((row) => ({ reportDate: row.reportDate, openInterest: row.openInterest,
          ...Object.fromEntries(row.positions.map((position) => [`${camelClass(position.id)}Net`, position.net])) })) }],
      // "jet fuel" reads heating oil's positions, and says so.
      ...(proxy ? { notes: [cotProxyNote(proxy)] } : {}),
      errors: data.gaps, metadata: { ...data, complete: data.status === "available" }, ...cotReleased(data.asOf) };
    }
    const traderClass = cotClass(family, args.options.traderClass);
    if (args.options.traderClass && traderClass !== args.options.traderClass) throw new Error("Trader class does not belong to this report family");
    const scope = cotScope(args.options.scope);
    const data = await fetchCotBoard(family, traderClass, ctx.apiClient, positions);
    const rows = data.rows.filter((row) => scope === "all" || COT_MAJOR_CODES.has(row.contractCode));
    return { sections: [{ title: positions === "combined" ? `Positioning extremes  ·  ${cotPositionsText(positions)}` : "Positioning extremes",
      columns: [{ key: "marketName", header: "Market" }, { key: "contractCode", header: "Code" }, ...POSITION_COLUMNS,
        { key: "openInterest", header: "Open interest", align: "right", format: count }, { key: "reportDate", header: "As of" }],
      rows: rows.map((row) => ({ contractCode: row.contractCode, marketName: cotMarketName(row.marketName), reportDate: row.reportDate, openInterest: row.openInterest, ...cotPositionRow(row.position) })) }],
    errors: data.gaps, metadata: { ...data, scope, complete: data.status === "available" }, ...cotReleased(data.asOf) };
  },
};

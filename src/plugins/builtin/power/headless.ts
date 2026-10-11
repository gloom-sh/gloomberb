import type { DataTableColumn } from "../../../components";
import type { HeadlessPaneColumn, HeadlessPaneDefinition, HeadlessPaneRow } from "../../../types/plugin";
import { withoutQuietColumns } from "../shared/research-cells";
import { fetchPowerBoard, fetchAllPowerHistory, fetchPowerTickerScopes } from "./client";
import { powerQuery } from "./query";
import {
  COVERAGE_COLUMNS, EXPOSURE_COLUMNS, GENERATION_COLUMNS, HISTORY_COLUMNS, POWER_TABS, PROJECT_COLUMNS, RATE_COLUMNS, UTILITY_COLUMNS,
  historyRows, powerNumber, powerPercent, powerRegion, powerScopeOptions, powerTab, powerTickerEmpty, projectRows, tickerLabel, titleCase, UNMAPPED, type PowerTab,
} from "./model";

/** Bars the pane draws beside the numbers they are made of; the report has the numbers. */
const GRAPHIC_COLUMNS = new Set(["outcome", "pipeline"]);
/** Columns that only repeat a default on every row, as the pane leaves them out. */
const QUIET_COLUMNS: Record<string, readonly string[]> = { scope: ["Project"], unknownCapacity: ["0"], unknown: ["0"], fuel: ["Load"], role: ["Direct"], kind: ["Queue"] };
const text = (value: unknown) => value == null || value === "" ? "-" : String(value);
const coded = (value: unknown) => typeof value === "string" && value ? titleCase(value) : "-";

/**
 * The pane's columns for a tab, printed as the pane prints them: MW and MWh
 * to a tenth with thousands separators, rates as percentages, register codes
 * by name, and each record's listed company or "unmapped". Raw metrics and
 * evidence stay in the exported rows, out of the table.
 */
function reportColumns(tab: PowerTab, context: unknown): HeadlessPaneColumn[] {
  const columns: DataTableColumn[] = tab === "capacity" && context === "generation" ? GENERATION_COLUMNS : tab === "capacity" && context === "utility" ? UTILITY_COLUMNS
    : ["queue", "loads", "capacity"].includes(tab) ? PROJECT_COLUMNS : tab === "history" ? HISTORY_COLUMNS : tab === "outcomes" ? RATE_COLUMNS : tab === "utilities" ? EXPOSURE_COLUMNS : COVERAGE_COLUMNS;
  // The coverage list names its register by its own id; everything else by the record's source.
  const region = (value: unknown, row: HeadlessPaneRow) => typeof value !== "string" ? "-"
    : tab === "utilities" ? value : powerRegion(value, String((tab === "coverage" ? row.id : row.sourceId) ?? ""));
  const format = (column: DataTableColumn): HeadlessPaneColumn["format"] => {
    if (column.id === "region") return region;
    if (["fuel", "status", "kind", "role"].includes(column.id)) return coded;
    if (column.id === "ticker") return (value) => typeof value === "string" && value ? value : UNMAPPED;
    if (column.id === "developer") return (value, row) => text(value ?? row.utility);
    if (column.id === "observedAt") return (value) => typeof value === "string" ? value.slice(0, 16).replace("T", " ") : "-";
    if (/Rate$/.test(column.id)) return (value) => typeof value === "number" ? powerPercent(value) : "-";
    if (column.align === "right") return (value) => typeof value === "number" ? `${column.id === "changeMw" && value > 0 ? "+" : ""}${powerNumber(value)}` : "-";
    return text;
  };
  // The pane groups outcomes under region headings; the report names the region on each row.
  return [...(tab === "outcomes" ? [{ id: "region", label: "Region", width: 16, align: "left" as const }] : []), ...columns].filter((column) => !GRAPHIC_COLUMNS.has(column.id))
    .map((column) => ({ key: column.id, header: column.label, align: column.align === "right" ? "right" as const : "left" as const, format: format(column) }));
}

export const powerHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: { source: "Grid operator queues and utility filings", status: "not-a-feed", basis: "published records", dataset: true },
  argument: { kind: "free-text", optional: true, placeholder: "ticker", description: "Optional listed developer or utility ticker, with exchange suffix where needed." },
  options: [
    { key: "tab", type: "enum", settingKey: "tab", defaultValue: "queue", values: POWER_TABS.map(({ value }) => ({ value })), description: "Queue, history, outcomes, large loads, utility exposure, capacity or coverage." },
    ...["country", "region", "fuel", "status", "search", "sourceId", "from", "to"].map((key) => ({ key, type: "string" as const, settingKey: key, description: `Filter by ${key}.` })),
    { key: "context", type: "enum", settingKey: "context", values: [{ value: "capacity" }, { value: "generation" }, { value: "utility" }], defaultValue: "capacity", description: "Generation capacity, monthly generation or utility context on the Capacity tab." },
    { key: "loadClass", aliases: ["load-class"], type: "enum", settingKey: "loadClass", values: [{ value: "datacenter" }], description: "Only loads explicitly classified as datacenters." },
    { key: "historical", type: "boolean", settingKey: "historical", defaultValue: false, description: "Use historical benchmark queues separately from direct observations." },
  ],
  discovery: { aliases: ["POWER"], dataRequirements: ["Gloom Cloud power queues and large-load disclosures"],
    limitations: ["Pro dataset; free accounts see three rows per section and limited history", "Proposed projects are not committed supply; requests and approvals are distinct", "Coverage varies by jurisdiction; missing MW and unavailable sources remain explicit"] },
  describe: "Power queues, large loads and utility exposure (Pro)",
  async load(args, ctx) {
    const tab = powerTab(args.options.tab);
    const symbol = (Array.isArray(args.argument) ? args.argument.join(" ") : args.argument)?.trim();
    const filter = { ...powerQuery(args.options, symbol), limit: 500 };
    const board = await fetchPowerBoard(filter, ctx.apiClient);
    const projects = [...board.projects];
    const ids = new Set(projects.map((row) => row.id));
    let offset = board.nextOffset;
    let hasMore = board.hasMore;
    // Export traverses every page; a stuck cursor fails visibly instead of silently truncating.
    while (["queue", "loads", "capacity"].includes(tab) && hasMore) {
      if (offset === null || offset < projects.length) throw new Error("Power pagination did not advance.");
      const page = await fetchPowerBoard({ ...filter, offset }, ctx.apiClient);
      if (page.hasMore && (page.nextOffset === null || page.nextOffset <= offset)) throw new Error("Power pagination did not advance.");
      if (page.projects.some((row) => ids.has(row.id))) throw new Error("Power records changed during export; retry the request.");
      for (const row of page.projects) ids.add(row.id);
      projects.push(...page.projects); offset = page.nextOffset; hasMore = page.hasMore;
    }
    const history = tab === "history" ? await fetchAllPowerHistory(filter, ctx.apiClient) : null;
    // Exported rows keep every field the server sent; the pane's derived cells (the ticker map, location, scope) ride beside them.
    const cells = projectRows(projects);
    const rows: HeadlessPaneRow[] = tab === "history" ? historyRows(history!.points).map((point) => ({ ...point, date: point.basis === "published" ? point.period : point.observedAt.slice(0, 16).replace("T", " ") }))
      : tab === "outcomes" ? board.rates.map((rate) => ({ ...rate }))
        : tab === "utilities" ? board.exposure.map((exposure) => ({ ...exposure, ticker: tickerLabel(exposure) }))
          : tab === "coverage" ? board.coverage.map((coverage) => ({ ...coverage }))
            : projects.map((project, index) => {
              const { ticker, location, scope, generationMwh, summerPeakDemandMw, winterPeakDemandMw, salesMwh, revenueUsd } = cells[index]!.cells;
              return { ...project, ticker, location, scope, generationMwh, summerPeakDemandMw, winterPeakDemandMw, salesMwh, revenueUsd };
            });
    const locked = history?.locked ?? (tab === "outcomes" ? board.locked.rates : tab === "utilities" ? board.locked.exposure : tab === "coverage" ? 0 : board.locked.projects);
    const columns = reportColumns(tab, args.options.context);
    const shown = withoutQuietColumns(columns.map((column) => ({ id: column.key, label: column.header, width: 0, align: "left" as const })), rows,
      (row, id) => columns.find((column) => column.key === id)!.format!(row[id], row), QUIET_COLUMNS).map((column) => column.id);
    // A ticker with nothing on this tab says where its records are instead; a narrower filter is the filters' doing.
    const narrowed = ["country", "region", "fuel", "status", "search", "sourceId", "from", "to", "loadClass", "historical"].some((key) => !!args.options[key]);
    const empty = !rows.length && symbol && !narrowed && tab !== "coverage" ? await fetchPowerTickerScopes(symbol, tab, String(args.options.context ?? "capacity"), ctx.apiClient)
      .then((scopes) => {
        const message = powerTickerEmpty(symbol, tab, String(args.options.context ?? "capacity"), scopes);
        const where = message.found.map((scope) => `${powerNumber(scope.total)} ${scope.label} (${powerScopeOptions(scope)})`).join(", ");
        return [message.title, where ? `${symbol} has ${where}.` : message.hint?.replace(/\.$/, " (--search <name>).")].filter(Boolean).join(" ");
      }) : "No reported records match these filters.";
    return { complete: locked === 0, sections: [{ title: POWER_TABS.find((t) => t.value === tab)!.label, columns: columns.filter((column) => shown.includes(column.key)), rows, empty }],
      metadata: { generatedAt: board.generatedAt, access: board.access, locked, total: board.total, units: "MW unless specified", filters: filter, aggregates: board.aggregates, coverage: board.coverage },
      errors: [...(locked ? ["Additional records and history need Gloom Pro."] : []), ...board.coverage.filter((c) => c.status !== "current").map((c) => `${c.region}: ${c.status}${c.reason ? `: ${c.reason}` : ""}`)] };
  },
};

import type { DataTableColumn } from "../../../components";
import type { HeadlessBundleSection, HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { withoutQuietColumns } from "../shared/research-cells";
import { resolveHeadlessIssuerListing } from "../shared/headless-market-data";
import { companyQuery, fetchCompanyData, type CompanyDataset, type CompanyMode } from "./client";
import { allGuidance, allObservations, companyCellText, companyColumns, companyPreviewNote, QUIET_COLUMNS, type CompanyRow } from "./model";
import type { KpiObservation } from "../../../api-client/company-kpis";

/** What the server takes as a metric; anything else is not a metric id and is not sent. */
const METRIC_ID = /^[a-z0-9_]{1,80}$/;
/** Filters the free preview ignores: it is fixed at the latest disclosures. */
const PRO_FILTERS = ["basis", "from", "to", "asOf"] as const;
/** The row field behind each pane column, where there is one; exports keep that field's value. */
const ROW_KEYS: Record<string, string> = { scope: "dimensions", issued: "issuedDate" };

/**
 * The pane's table columns, printed as the pane prints them: fiscal labels
 * (FY2024), compact values with their unit (12.48B USD), the scope in words,
 * and Basis and Scope only when a row is not the reported, consolidated
 * figure. Each row's disclosure date follows. The rows keep every field the
 * server sent for exports.
 */
function reportColumns(mode: CompanyMode, history: boolean, revisions: boolean, rows: CompanyRow[], observations: KpiObservation[]): HeadlessPaneColumn[] {
  const columns: DataTableColumn[] = [...companyColumns(mode === "guidance", false, history),
    ...(revisions ? [{ id: "revision", label: "Revision", width: 12, align: "left" as const }] : [])];
  return [...withoutQuietColumns(columns, rows, (row, id) => companyCellText(row, id, observations), QUIET_COLUMNS).map((column): HeadlessPaneColumn => ({
    key: column.id === "value" && mode === "guidance" ? "rangeText" : ROW_KEYS[column.id] ?? column.id, header: column.label, align: column.align === "right" ? "right" : "left",
    format: (_value, row) => companyCellText(row as unknown as CompanyRow, column.id, observations),
  })), { key: "asOf", header: "As of", format: (value) => typeof value === "string" ? value.slice(0, 10) : "--" }];
}

function datasetRows(data: CompanyDataset): CompanyRow[] {
  return "series" in data ? allObservations(data) : allGuidance(data);
}

/** The metrics a report has rows for, `revenue (Revenue)`, in the order the server lists them. */
function metricList(rows: CompanyRow[]): string {
  return [...new Map(rows.map((row) => [row.metricId, `${row.metricId} (${row.metric.name})`])).values()].join(", ");
}

/**
 * The free preview is fixed, so a metric asked for is picked out of it here,
 * never answered with another metric's rows. An id the dictionary does not
 * know fails naming the ones this company has; a known metric without rows
 * says so and names them.
 */
function metricFilter(requested: string, data: CompanyDataset, mode: CompanyMode): { keep: (row: CompanyRow) => boolean; empty?: string } {
  if (!requested) return { keep: () => true };
  const rows = datasetRows(data);
  const whose = data.access === "preview" ? `${data.symbol}'s free preview` : data.symbol;
  const offered = metricList(rows);
  const has = offered ? `${whose} has ${offered}` : `${whose} has no ${mode === "kpis" ? "KPI" : "guidance"} disclosures`;
  const known = data.dictionary.find((metric) => metric.id === requested) ?? rows.find((row) => row.metricId === requested)?.metric;
  if (!known) throw new Error(`${requested} is not a known metric id. ${has}.`);
  const keep = (row: CompanyRow) => row.metricId === requested;
  if (rows.some(keep)) return { keep };
  return { keep, empty: `${whose} has no ${known.name} (${known.id}) ${mode === "kpis" ? "disclosures" : "guidance"}${offered ? `; it has ${offered}` : ""}.` };
}

/**
 * How old a free preview's rows are: the footer dates the company's newest
 * disclosure, which the fixed preview may not show.
 */
function ageNote(data: CompanyDataset, latest: CompanyRow[], mode: CompanyMode): string | null {
  const shown = latest.map((row) => row.asOf.slice(0, 10)).sort().at(-1);
  const newest = data.asOf?.slice(0, 10);
  if (data.access !== "preview" || !shown || !newest || newest <= shown) return null;
  return `The free preview's latest ${mode === "kpis" ? "KPIs are" : "guidance is"} as of ${shown}, older than ${data.symbol}'s newest disclosure (${newest}).`;
}

export function companyHeadless(mode: CompanyMode): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    freshness: { source: "Company filings and calls", status: "not-a-feed", basis: "reported data" },
    argument: { kind: "ticker", description: "Listed company ticker, including exchange-qualified global symbols.", placeholder: "ticker" },
    discovery: { aliases: [mode === "kpis" ? "KPIS" : "GUIDE"], dataRequirements: ["Gloom Cloud company disclosures"],
      limitations: ["Pro dataset with a fixed latest preview on Free.", "Coverage follows available company disclosures; missing data is not zero.", "Compare matching definition, period, currency, basis and scope.", "Fiscal labels without explicit calendar dates are retained without inferred dates."] },
    options: [
      { key: "tab", type: "enum", settingKey: "tab", defaultValue: "table", values: [{ value: "table" }, { value: "chart" }, ...(mode === "guidance" ? [{ value: "history" }] : []), { value: "evidence" }], description: "The pane section to render." },
      { key: "metric", type: "string", settingKey: "metric", description: "Canonical metric ID, such as arr or subscribers.", normalize: (value) => value.trim().toLowerCase() },
      { key: "basis", type: "enum", values: [{ value: "reported" }, { value: "adjusted" }, { value: "constant_currency" }, { value: "organic" }], description: "Accounting basis filter (Pro)." },
      { key: "from", type: "string", description: "First calendar period end, YYYY-MM-DD (Pro)." },
      { key: "to", type: "string", description: "Last calendar period end, YYYY-MM-DD (Pro)." },
      { key: "asOf", type: "string", description: "Point-in-time publication cutoff, YYYY-MM-DD (Pro)." },
    ],
    describe: (args) => `${mode === "kpis" ? "Company KPIs" : "Company guidance"} | ${args.symbols[0]}`,
    async load(args, ctx) {
      const requested = typeof args.options.metric === "string" && args.options.metric !== "all" ? args.options.metric.trim().toLowerCase() : "";
      const options = companyQuery({ ...args.options, metric: METRIC_ID.test(requested) ? requested : undefined });
      const symbol = args.symbols[0]!;
      const data = await fetchCompanyData(mode, symbol, options, ctx.apiClient, await resolveHeadlessIssuerListing(ctx, symbol));
      const { keep, empty } = metricFilter(requested, data, mode);
      const observations = "series" in data ? allObservations(data) : [];
      // A metric with no rows says why once, in the first section.
      const section = (title: string, rows: CompanyRow[], { history = false, revisions = false, first = false } = {}): HeadlessBundleSection => {
        const shown = rows.filter(keep);
        return { title, columns: reportColumns(mode, history, revisions, shown, observations), rows: shown.map((row) => ({ ...row })), ...(empty && first ? { empty } : {}) };
      };
      const latest = ("series" in data ? data.series.map((series) => series.latest) : data.guidance).filter(keep);
      const ignored = data.access === "preview" ? PRO_FILTERS.filter((key) => typeof args.options[key] === "string" && args.options[key] !== "") : [];
      const notes = [ageNote(data, latest, mode),
        ignored.length ? `The free preview is fixed: ${ignored.map((key) => `--${key}`).join(", ")} ${ignored.length > 1 ? "need" : "needs"} Gloom Pro.` : null].filter((note): note is string => !!note);
      return { complete: !data.truncated, errors: data.truncated ? [data.access === "preview" ? companyPreviewNote(data, mode === "guidance") : "Response limit reached; narrow the metric or date range"] : [],
        ...(notes.length ? { notes } : {}),
        sections: "series" in data ? [
          section("Latest KPIs", data.series.map((series) => series.latest), { first: true }),
          section("KPI history", data.series.flatMap((series) => series.observations)),
          section("Revisions and conflicts", data.revisions, { revisions: true }),
        ] : [section("Current guidance", data.guidance, { first: true }), section("Guidance history", data.history, { history: true })],
        metadata: { symbol: data.symbol, asOf: data.asOf, access: data.access, coverage: data.coverage, dictionary: data.dictionary,
          lockedRows: data.lockedRows, totalRows: data.totalRows, methodology: data.methodology } };
    },
  };
}

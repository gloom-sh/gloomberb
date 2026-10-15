import type { AwardFilter, AwardRow, AwardType } from "../../../api-client/awards";
import { notATickerSymbol } from "../../../sources/provider-errors";
import type { HeadlessBundleSection, HeadlessPaneColumn, HeadlessPaneContext, HeadlessPaneDefinition, HeadlessPaneRow } from "../../../types/headless";
import { isoDateOption } from "../../../utils/calendar-date";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { fetchAward, fetchAwards } from "./client";
import { AWARD_TABS, awardScope, awardsPreviewNote, awardTypeLabel, futureAwardDatesNote, money } from "./model";

/**
 * "Not a ticker: ZZZZQ." when no listing has the symbol, so a preview that
 * cannot filter by ticker does not read the same for a typo as for a real
 * company. Any other failure (a timeout) says nothing.
 */
async function notATicker(ticker: string, ctx: HeadlessPaneContext): Promise<string | null> {
  try {
    const { symbol, exchange } = await resolveHeadlessInstrument(ctx, ticker);
    await ctx.marketData.getQuote(symbol, exchange);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return notATickerSymbol(message) ? message : null;
  }
}

const awardRecord = (row: AwardRow) => ({ id: row.id, date: row.awardDate, dateBasis: row.dateBasis ?? "award", dataBasis: row.dataBasis ?? null,
  fieldAsOf: row.fieldAsOf ?? null, fieldSourceUrls: row.fieldSourceUrls ?? null, recipient: row.recipient.name, ticker: row.entity?.ticker ?? null,
  classifications: row.classifications ?? [],
  agency: row.agency.name, jurisdiction: row.jurisdiction, type: row.awardType, currency: row.currency,
  value: row.awardAmount ?? null, obligated: row.obligatedAmount ?? null, ceiling: row.ceilingAmount ?? null,
  periodStart: row.periodStart ?? null, periodEnd: row.periodEnd ?? null, title: row.title,
  annualRevenuePercent: row.revenueComparison?.percent ?? null, revenueComparison: row.revenueComparison,
  sourceUrl: row.sourceUrl, observedAt: row.observedAt, revisionId: row.revisionId, evidenceQuote: row.evidenceQuote ?? null,
  confidence: row.confidence ?? null, entityEvidence: row.entity });

/*
 * The pane's columns, printed as the pane prints them: amounts compact in
 * their currency's column (3.19B), shares to a tenth of a percent, record
 * types and scopes by name. Amounts are decimal strings from the source, so
 * exports keep them whole: the compact form is the text report's alone.
 */
const text = (value: unknown) => value == null || value === "" ? "--" : String(value);
const amount = (key: string, header: string): HeadlessPaneColumn => ({ key, header, align: "right", textFormat: (value) => money(value as string | null) });
const nested = (pick: (row: HeadlessPaneRow) => unknown, key: string, header: string): HeadlessPaneColumn => ({ key, header, align: "right",
  format: (_value, row) => text(pick(row)), textFormat: (_value, row) => money(pick(row) as string | null) });
const share: HeadlessPaneColumn = { key: "sharePercent", header: "Share %", align: "right", format: (value) => typeof value === "number" ? `${value.toFixed(1)}%` : "--" };
const count: HeadlessPaneColumn = { key: "count", header: "Awards", align: "right", textFormat: (value) => typeof value === "number" ? value.toLocaleString("en-US") : "--" };
const scope: HeadlessPaneColumn = { key: "source", header: "Scope", format: (value) => typeof value === "string" ? awardScope(value) : "--" };
const type: HeadlessPaneColumn = { key: "awardType", header: "Type", format: (value) => typeof value === "string" ? awardTypeLabel(value as AwardType) : "--" };
const period = (_value: unknown, row: HeadlessPaneRow) => row.periodStart || row.periodEnd ? `${text(row.periodStart)} / ${text(row.periodEnd)}` : "--";
const dateBasis = (value: unknown) => value === "period-start" ? "Period start" : value === "publication" ? "Publication" : "Award date";
const comparison = (row: HeadlessPaneRow) => row.revenueComparison as { awardAmount?: string; annualRevenue?: string; basis?: string; periodEnd?: string } | null;
const FEED_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date" }, { key: "recipient", header: "Awardee" }, { key: "ticker", header: "Ticker" }, { key: "currency", header: "CCY" },
  amount("value", "Value"), amount("obligated", "Obligated"), amount("ceiling", "Ceiling"), { key: "agency", header: "Agency" }, { key: "jurisdiction", header: "Country" },
  { key: "performancePeriod", header: "Performance period", format: period }, { key: "title", header: "Contract" }, { key: "dateBasis", header: "Date basis", format: dateBasis },
];
const EVENT_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date" }, { key: "recipient", header: "Awardee" }, { key: "ticker", header: "Ticker" },
  { key: "annualRevenuePercent", header: "% revenue", align: "right", format: (value) => typeof value === "number" ? `${value.toFixed(2)}%` : "--" },
  { key: "currency", header: "CCY" }, nested((row) => comparison(row)?.awardAmount, "comparedValue", "Compared value"),
  nested((row) => comparison(row)?.annualRevenue, "annualRevenue", "Annual revenue"),
  { key: "revenueComparison", header: "Value basis", format: (_value, row) => comparison(row)?.basis === "obligated" ? "Obligated" : "Award value" },
  { key: "revenuePeriodEnd", header: "Revenue FY end", format: (_value, row) => text(comparison(row)?.periodEnd) },
  { key: "agency", header: "Agency" }, { key: "title", header: "Contract" },
];
const COHORT_COLUMNS: HeadlessPaneColumn[] = [{ key: "month", header: "Month", format: (value) => text(value).slice(0, 7) }, scope, { key: "currency", header: "CCY" }, type, count,
  amount("obligatedAmount", "Obligated"), amount("ceilingAmount", "Ceiling"), amount("awardAmount", "Value"), amount("cumulativeObligatedAmount", "Cumulative obligated")];
const aggregateColumns = (label: string): HeadlessPaneColumn[] => [{ key: "label", header: label }, scope, { key: "currency", header: "CCY" }, share,
  amount("obligatedAmount", "Obligated"), amount("awardAmount", "Value"), amount("ceilingAmount", "Ceiling"), count];
const LEADER_COLUMNS: HeadlessPaneColumn[] = [{ key: "label", header: "Company" }, { key: "ticker", header: "Ticker" }, { key: "currency", header: "CCY" }, share,
  amount("awardAmount", "Value"), amount("obligatedAmount", "Obligated"), count, { key: "sector", header: "Sector" }, amount("ceilingAmount", "Ceiling"), scope];
const REVISION_COLUMNS: HeadlessPaneColumn[] = [{ key: "observedAt", header: "Observed" }, { key: "sourceUpdatedAt", header: "Source updated" }, { key: "supersedes", header: "Supersedes" },
  nested((row) => (row.award as AwardRow | undefined)?.awardAmount, "awardAmount", "Value"), nested((row) => (row.award as AwardRow | undefined)?.obligatedAmount, "obligatedAmount", "Obligated"),
  { key: "award", header: "Contract", format: (value) => text((value as AwardRow | undefined)?.title) }];
const EDGE_COLUMNS: HeadlessPaneColumn[] = [{ key: "kind", header: "Kind" }, { key: "from", header: "From", format: (value) => text((value as { name?: string } | null)?.name) },
  { key: "to", header: "To", format: (value) => text((value as { name?: string } | null)?.name) }, { key: "currency", header: "CCY" }, amount("amount", "Amount"), { key: "awardId", header: "Award" }];

const FILTER_KEYS = ["jurisdiction", "currency", "source", "agency", "sector", "parentId", "from", "to", "query"] as const;

export const awardsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "ticker", description: "Optional verified listed-company ticker, including exchange suffix." },
  freshness: { source: "Public procurement records", status: "not-a-feed", basis: "published awards" },
  discovery: { aliases: ["AWARDS"], dataRequirements: ["Verified Gloom Cloud account"],
    limitations: ["Pro dataset; free accounts receive a limited preview.", "Published procurement records; source coverage varies by jurisdiction.",
      "Currencies and prime awards, subawards and notices are separate.", "Award obligations are not revenue or remaining backlog.", "Unresolved recipients retain their legal names."] },
  options: [
    { key: "tab", type: "enum", settingKey: "tab", defaultValue: "feed", values: [...AWARD_TABS.map(({ value }) => ({ value })), { value: "all" }], description: "Feed, company history, agencies, sectors, events, or all sections." },
    { key: "view", type: "enum", settingKey: "leaderView", defaultValue: "companies", values: [{ value: "companies" }, { value: "sectors" }], description: "Sectors tab: company leaders or sector totals." },
    ...FILTER_KEYS.map((key) => key === "from" || key === "to"
      ? { key, type: "string" as const, settingKey: key, placeholder: "YYYY-MM-DD", description: `${key === "from" ? "Start" : "End"} of the date range. Dates use YYYY-MM-DD.`,
        normalize: (value: string) => isoDateOption(value, key) }
      : { key, type: "string" as const, settingKey: key, description: `Filter by ${key}.` }),
    { key: "type", type: "enum", settingKey: "awardType", defaultValue: "prime", values: [{ value: "prime" }, { value: "subaward" }, { value: "notice" }, { value: "modification" }], description: "Keep record types separate." },
    { key: "cursor", type: "string", description: "Continue after the previous response's nextCursor." },
    { key: "limit", type: "integer", minimum: 1, maximum: 200, defaultValue: 100, description: "Maximum feed rows in this response." },
    { key: "award", type: "string", settingKey: "award", description: "Open one award's evidence, revisions, subawards and modifications by stable id." },
    { key: "revisionsCursor", type: "string", description: "Continue a detail response's revisions using nextRevisionsCursor." },
  ],
  describe: "Government awards, agency concentration and company exposure (Pro)",
  async load(args, ctx) {
    if (args.options.award) {
      const detail = await fetchAward(String(args.options.award), ctx.apiClient, ctx.signal, args.options.revisionsCursor ? String(args.options.revisionsCursor) : undefined);
      return { complete: !detail.locked && !detail.nextRevisionsCursor && !Object.values(detail.truncated ?? {}).some(Boolean), sections: [{ title: "Award", columns: FEED_COLUMNS, rows: detail.row ? [awardRecord(detail.row)] : [] },
        { title: "Revisions", columns: REVISION_COLUMNS, rows: detail.revisions.map((row) => ({ ...row })) },
        { title: "Subawards", columns: FEED_COLUMNS, rows: detail.subawards.map(awardRecord) }, { title: "Modifications", columns: FEED_COLUMNS, rows: detail.modifications.map(awardRecord) },
        { title: "Relationships", columns: EDGE_COLUMNS, rows: detail.edges.map((row) => ({ ...row })) }], metadata: { access: detail.access, locked: detail.locked, nextRevisionsCursor: detail.nextRevisionsCursor, truncated: detail.truncated } };
    }
    const filter: AwardFilter = { ticker: args.rawArgument.trim().toUpperCase() || undefined, awardType: args.options.type as AwardFilter["awardType"], limit: Number(args.options.limit ?? 100) };
    for (const key of [...FILTER_KEYS, "cursor"] as const) if (args.options[key]) filter[key] = String(args.options[key]);
    const data = await fetchAwards(filter, ctx.apiClient, ctx.signal);
    // A preview's rows are anyone's, and Pro's are empty either way, so only those two ask whether the ticker exists.
    const missing = filter.ticker && (data.locked || !data.rows.length) ? await notATicker(filter.ticker, ctx) : null;
    const lock = awardsPreviewNote(data, filter);
    const futureDates = futureAwardDatesNote(data.rows, data.generatedAt);
    const sections: HeadlessBundleSection[] = [];
    const tab = String(args.options.tab ?? "feed");
    if (tab === "feed" || tab === "company" || tab === "all") sections.push({ title: "Awards", columns: FEED_COLUMNS, rows: data.rows.map(awardRecord) });
    if (tab === "company" || tab === "all") sections.push({ title: "Award cohorts by month and currency", columns: COHORT_COLUMNS, rows: data.history.map((row) => ({ ...row })) });
    if (tab === "agencies" || tab === "all") sections.push({ title: "Agency concentration", columns: aggregateColumns("Agency"), rows: data.agencies.map((row) => ({ ...row })) });
    if (tab === "sectors" || tab === "all") sections.push({ title: "Sector company leaders", columns: LEADER_COLUMNS, rows: (data.leaders ?? []).map((row) => ({ ...row })) },
      { title: "Sector totals", columns: aggregateColumns("Sector"), rows: data.sectors.map((row) => ({ ...row })) });
    if (tab === "events" || tab === "all") sections.push({ title: "Awards relative to annual revenue", columns: EVENT_COLUMNS, rows: data.alerts.map(awardRecord) });
    return { complete: !data.locked && !data.nextCursor && data.status === "available" && !Object.values(data.truncated ?? {}).some(Boolean), sections,
      ...(futureDates ? { notes: [futureDates] } : {}),
      errors: [...(missing ? [missing] : []), ...data.gaps, ...(lock ? [lock] : [])],
      // A preview is the same latest awards whatever was asked, so the filters were requested, not applied.
      metadata: { generatedAt: data.generatedAt, asOf: data.asOf, access: data.access, nextCursor: data.nextCursor, truncated: data.truncated, coverage: data.coverage, sources: data.sources,
        filters: filter, filtersApplied: !data.locked } };
  },
};

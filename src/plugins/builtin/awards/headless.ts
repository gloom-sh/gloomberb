import type { AwardFilter, AwardRow } from "../../../api-client/awards";
import type { HeadlessBundleSection, HeadlessPaneDefinition } from "../../../types/headless";
import { fetchAward, fetchAwards } from "./client";
import { AWARD_TABS } from "./model";

const awardRecord = (row: AwardRow) => ({ id: row.id, date: row.awardDate, dateBasis: row.dateBasis ?? "award", dataBasis: row.dataBasis ?? null,
  fieldAsOf: row.fieldAsOf ?? null, fieldSourceUrls: row.fieldSourceUrls ?? null, recipient: row.recipient.name, ticker: row.entity?.ticker ?? null,
  classifications: row.classifications ?? [],
  agency: row.agency.name, jurisdiction: row.jurisdiction, type: row.awardType, currency: row.currency,
  value: row.awardAmount ?? null, obligated: row.obligatedAmount ?? null, ceiling: row.ceilingAmount ?? null,
  periodStart: row.periodStart ?? null, periodEnd: row.periodEnd ?? null, title: row.title,
  annualRevenuePercent: row.revenueComparison?.percent ?? null, revenueComparison: row.revenueComparison,
  sourceUrl: row.sourceUrl, observedAt: row.observedAt, revisionId: row.revisionId, evidenceQuote: row.evidenceQuote ?? null,
  confidence: row.confidence ?? null, entityEvidence: row.entity });

export const awardsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "ticker", description: "Optional verified listed-company ticker, including exchange suffix." },
  freshness: { source: "Public procurement records", status: "not-a-feed", basis: "published awards" },
  discovery: { aliases: ["AWARDS"], dataRequirements: ["Verified Gloom Cloud account"],
    limitations: ["Pro dataset; free accounts receive a limited preview", "Published procurement records; source coverage varies by jurisdiction",
      "Currencies and prime awards, subawards and notices are separate", "Award obligations are not revenue or remaining backlog", "Unresolved recipients retain their legal names"] },
  options: [
    { key: "tab", type: "enum", settingKey: "tab", defaultValue: "feed", values: [...AWARD_TABS.map(({ value }) => ({ value })), { value: "all" }], description: "Feed, company history, agencies, sectors, events, or all sections." },
    { key: "view", type: "enum", settingKey: "leaderView", defaultValue: "companies", values: [{ value: "companies" }, { value: "sectors" }], description: "Sectors tab: company leaders or sector totals." },
    ...["jurisdiction", "currency", "source", "agency", "sector", "parentId", "from", "to", "query"].map((key) => ({ key, type: "string" as const, settingKey: key, description: `Filter by ${key}; dates use YYYY-MM-DD.` })),
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
      return { complete: !detail.locked && !detail.nextRevisionsCursor && !Object.values(detail.truncated ?? {}).some(Boolean), sections: [{ title: "Award", rows: detail.row ? [awardRecord(detail.row)] : [] },
        { title: "Revisions", rows: detail.revisions.map((row) => ({ ...row })) },
        { title: "Subawards", rows: detail.subawards.map(awardRecord) }, { title: "Modifications", rows: detail.modifications.map(awardRecord) },
        { title: "Relationships", rows: detail.edges.map((row) => ({ ...row })) }], metadata: { access: detail.access, locked: detail.locked, nextRevisionsCursor: detail.nextRevisionsCursor, truncated: detail.truncated } };
    }
    const filter: AwardFilter = { ticker: args.rawArgument.trim().toUpperCase() || undefined, awardType: args.options.type as AwardFilter["awardType"], limit: Number(args.options.limit ?? 100) };
    for (const key of ["jurisdiction", "currency", "source", "agency", "sector", "parentId", "from", "to", "query", "cursor"] as const) if (args.options[key]) filter[key] = String(args.options[key]);
    const data = await fetchAwards(filter, ctx.apiClient, ctx.signal);
    const sections: HeadlessBundleSection[] = [];
    const tab = String(args.options.tab ?? "feed");
    if (tab === "feed" || tab === "company" || tab === "all") sections.push({ title: "Awards", rows: data.rows.map(awardRecord) });
    if (tab === "company" || tab === "all") sections.push({ title: "Award cohorts by month and currency", rows: data.history.map((row) => ({ ...row })) });
    if (tab === "agencies" || tab === "all") sections.push({ title: "Agency concentration", rows: data.agencies.map((row) => ({ ...row })) });
    if (tab === "sectors" || tab === "all") sections.push({ title: "Sector company leaders", rows: (data.leaders ?? []).map((row) => ({ ...row })) },
      { title: "Sector totals", rows: data.sectors.map((row) => ({ ...row })) });
    if (tab === "events" || tab === "all") sections.push({ title: "Awards relative to annual revenue", rows: data.alerts.map(awardRecord) });
    return { complete: !data.locked && !data.nextCursor && data.status === "available" && !Object.values(data.truncated ?? {}).some(Boolean), sections,
      errors: [...data.gaps, ...(data.locked ? ["Additional awards and history require Gloom Pro"] : [])],
      metadata: { generatedAt: data.generatedAt, asOf: data.asOf, access: data.access, nextCursor: data.nextCursor, truncated: data.truncated, coverage: data.coverage, sources: data.sources, filters: filter } };
  },
};

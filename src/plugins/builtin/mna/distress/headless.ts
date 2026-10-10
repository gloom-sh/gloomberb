import type { DistressFilingKind } from "../../../../api-client/distress";
import type { HeadlessPaneColumn, HeadlessPaneDefinition, HeadlessPaneOptionDef, HeadlessRowsResult } from "../../../../types/plugin";
import { fetchDesignations, fetchDistressFilings, fetchGoingConcern, fetchInsolvencyNotices } from "./client";
import {
  ALL,
  cellText,
  DESIGNATION_KIND_LABELS,
  designationDate,
  designationKindLabel,
  designationName,
  DATE_BASIS_LABELS,
  distressView,
  exchangeLabel,
  filingDate,
  filingEventLabel,
  filingTicker,
  goingConcernTitle,
  INSOLVENCY_KIND_LABELS,
  insolvencyKindLabel,
  insolvencyNoticeLabel,
  isoDay,
  namePrefix,
  noticeStatusLabel,
  unlessAll,
  VERDICT_LABELS,
  type DistressViewId,
  type GoingConcernVerdictFilter,
} from "./model";

/** The Distress tab's pane state, so `shot DIST --view listings` opens on what was asked. */
const tabState = (key: string) => ({ pluginId: "ticker-research", key: `distress:${key}` });

const OPTIONS: HeadlessPaneOptionDef[] = [
  {
    key: "view",
    description: "Which records: 8-K filings, going-concern disclosures, exchange listing designations or insolvency notices.",
    type: "enum",
    defaultValue: "filings",
    values: [
      { value: "filings", aliases: ["8k", "8-k"] },
      { value: "going-concern", aliases: ["gc", "going"] },
      { value: "listings", aliases: ["designations"] },
      { value: "insolvency", aliases: ["notices"] },
    ],
    pluginState: tabState("view"),
  },
  {
    key: "items",
    description: "8-K items: bankruptcy and obligation triggers (1.03, 2.04) or listing notices (3.01).",
    type: "enum",
    defaultValue: "distress",
    values: [{ value: "distress", aliases: ["bankruptcy"] }, { value: "listing", aliases: ["3.01"] }],
    pluginState: tabState("filings:kind"),
  },
  {
    key: "verdict",
    description: "Going-concern disclosure reading.",
    type: "enum",
    defaultValue: "doubt_raised",
    values: ["doubt_raised", "doubt_alleviated", "policy_only", "unclear", ALL].map((value) => ({ value })),
    pluginState: tabState("going-concern:verdict"),
  },
  {
    key: "status",
    description: "Listing designation.",
    type: "enum",
    defaultValue: ALL,
    values: [ALL, ...Object.keys(DESIGNATION_KIND_LABELS)].map((value) => ({ value })),
    pluginState: tabState("listings:kind"),
  },
  {
    key: "exchange",
    description: "Exchange of a listing designation.",
    type: "enum",
    defaultValue: ALL,
    values: [{ value: ALL }, { value: "TWSE" }, { value: "TPEX", aliases: ["tpex"] }],
    pluginState: tabState("listings:exchange"),
  },
  {
    key: "country",
    description: "Country of an insolvency notice.",
    type: "enum",
    defaultValue: ALL,
    values: [{ value: ALL }, { value: "FR", aliases: ["france"] }, { value: "GB", aliases: ["uk"] }],
    pluginState: tabState("insolvency:country"),
  },
  {
    key: "procedure",
    description: "Insolvency procedure.",
    type: "enum",
    defaultValue: ALL,
    values: [ALL, ...Object.keys(INSOLVENCY_KIND_LABELS)].map((value) => ({ value })),
    pluginState: tabState("insolvency:kind"),
  },
  {
    key: "name",
    description: "Insolvency notices for companies whose name starts with this (two characters or more).",
    type: "string",
    pluginState: tabState("insolvency:query"),
  },
  { key: "limit", aliases: ["count", "rows"], description: "Maximum rows.", type: "integer", defaultValue: 50, minimum: 1, maximum: 200 },
];

const COLUMNS: Record<DistressViewId, HeadlessPaneColumn[]> = {
  filings: [
    { key: "filed", header: "Filed" },
    { key: "company", header: "Company" },
    { key: "ticker", header: "Ticker" },
    { key: "items", header: "Items" },
    { key: "headline", header: "Headline" },
  ],
  "going-concern": [
    { key: "filed", header: "Filed" },
    { key: "company", header: "Company" },
    { key: "ticker", header: "Ticker" },
    { key: "form", header: "Form" },
    { key: "periodEnd", header: "Period" },
    { key: "disclosure", header: "Disclosure" },
  ],
  listings: [
    { key: "date", header: "Date" },
    { key: "dateBasis", header: "Date basis" },
    { key: "code", header: "Code" },
    { key: "company", header: "Company" },
    { key: "exchange", header: "Exchange" },
    { key: "status", header: "Status" },
  ],
  insolvency: [
    { key: "published", header: "Published" },
    { key: "company", header: "Company" },
    { key: "country", header: "Country" },
    { key: "registryId", header: "Registry no." },
    { key: "procedure", header: "Procedure" },
    { key: "notice", header: "Notice" },
    { key: "procedureDate", header: "Dated" },
  ],
};

const text = (value: unknown) => (typeof value === "string" ? value : "");

export const distressHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  freshness: { source: "Public filings and insolvency notices", status: "not-a-feed", basis: "filed records" },
  description: "Dated public records about companies in difficulty: US 8-K bankruptcy, obligation and listing filings, SEC going-concern disclosures, Taiwan exchange listing designations, and French and UK company insolvency notices. No scores or predictions.",
  argument: { kind: "none" },
  discovery: {
    aliases: ["DIST"],
    dataRequirements: ["Public SEC EDGAR filings and financial statement notes, TWSE and TPEx open data, BODACC and The Gazette notices"],
    limitations: [
      "A company missing from a list may still be in difficulty; absence is not a finding",
      "Going-concern disclosures come from monthly SEC data sets, weeks after filing",
      "Listing status is not a statement about solvency, and some Taiwan dates are when the row was first seen",
      "Insolvency notices are not linked to listed companies",
    ],
  },
  options: OPTIONS,
  describe: (args) => `Distress | ${distressView(args.options.view)}`,
  async load(args, ctx): Promise<HeadlessRowsResult> {
    const view = distressView(args.options.view);
    const limit = Math.max(1, Math.min(200, Number(args.options.limit ?? 50)));
    const signal = ctx.signal;
    switch (view) {
      case "filings": {
        const kind: DistressFilingKind = args.options.items === "listing" ? "listing" : "distress";
        const payload = await fetchDistressFilings(kind, ctx.apiClient, signal, limit);
        return {
          columns: COLUMNS.filings,
          rows: payload.events.map((event) => ({
            id: event.id,
            filed: filingDate(event),
            company: cellText(event.company.name),
            ticker: filingTicker(event),
            cik: event.company.cik,
            form: event.form ?? "8-K",
            items: filingEventLabel(event),
            itemCodes: event.items,
            headline: event.headline ? cellText(event.headline) : null,
            summary: event.summary ? cellText(event.summary) : null,
            url: event.docUrl,
          })),
          metadata: { view, items: kind },
        };
      }
      case "going-concern": {
        const verdict = (text(args.options.verdict) || "doubt_raised") as GoingConcernVerdictFilter;
        const payload = await fetchGoingConcern({ verdict: verdict === ALL ? undefined : verdict, limit }, ctx.apiClient, signal);
        return {
          columns: COLUMNS["going-concern"],
          rows: payload.disclosures.map((row) => ({
            id: row.id,
            filed: row.filed_at,
            company: goingConcernTitle(row),
            ticker: row.ticker,
            cik: row.cik,
            form: row.form,
            periodEnd: row.period_end,
            disclosure: VERDICT_LABELS[row.verdict],
            quote: cellText(row.quote),
            summary: cellText(row.summary),
            datasetMonth: row.dataset_month,
            url: row.filing_url,
          })),
          metadata: { view, verdict, hasMore: payload.hasMore },
        };
      }
      case "listings": {
        const payload = await fetchDesignations({
          kind: unlessAll(text(args.options.status)),
          exchange: unlessAll(text(args.options.exchange)),
          limit,
        }, ctx.apiClient, signal);
        return {
          columns: COLUMNS.listings,
          rows: payload.designations.map((row) => ({
            id: row.id,
            date: designationDate(row),
            dateBasis: DATE_BASIS_LABELS[row.date_basis],
            code: row.local_code,
            symbol: row.symbol,
            company: designationName(row),
            name: cellText(row.entity_name),
            exchange: exchangeLabel(row.exchange),
            status: designationKindLabel(row.kind),
            lastSeen: isoDay(row.last_seen_at),
            ended: row.ended_at ? isoDay(row.ended_at) : null,
            url: row.notice_url ?? row.source_url,
          })),
          metadata: { view, hasMore: payload.hasMore, attributions: payload.attributions },
        };
      }
      case "insolvency": {
        const payload = await fetchInsolvencyNotices({
          country: unlessAll(text(args.options.country)),
          kind: unlessAll(text(args.options.procedure)),
          name_prefix: namePrefix(text(args.options.name)),
          limit,
        }, ctx.apiClient, signal);
        return {
          columns: COLUMNS.insolvency,
          rows: payload.notices.map((row) => ({
            id: `${row.source}:${row.notice_id}`,
            published: row.published_date,
            company: cellText(row.entity_name),
            country: row.country,
            registryId: row.registry_id,
            procedure: insolvencyKindLabel(row.kind),
            notice: insolvencyNoticeLabel(row),
            noticeCode: row.raw_code,
            procedureDate: row.notice_date,
            status: noticeStatusLabel(row.status),
            url: row.notice_url,
          })),
          metadata: { view, hasMore: payload.hasMore, attributions: payload.attributions },
        };
      }
    }
  },
};

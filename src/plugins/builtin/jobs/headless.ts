import type {
  HeadlessBundleResult,
  HeadlessPaneDefinition,
} from "../../../types/plugin";
import { formatCompact, formatNumber } from "../../../utils/format";
import { fetchJobs, fetchJobsMovers, type JobsCloudClient, type JobsCompanyState } from "./client";
import {
  buildMoverRows,
  buildPostingRows,
  formatChange,
  formatSalaryRange,
  formatShare,
  functionLabel,
} from "./model";

function companyBundle(symbol: string, state: JobsCompanyState, roleLimit: number): HeadlessBundleResult {
  if (state.kind === "denied") throw new Error(state.message);
  if (state.kind === "pending") {
    return {
      sections: [{ title: "Hiring", entries: [{ label: "Status", value: "pending", formatted: state.message }] }],
      metadata: { symbol, status: "pending" },
    };
  }
  if (state.kind === "uncovered") {
    return {
      sections: [{ title: "Hiring", entries: [{ label: "Status", value: "uncovered", formatted: state.message }] }],
      unavailableSymbols: [symbol],
      metadata: { symbol, status: "uncovered" },
    };
  }
  const summary = state.summary;
  const roles = buildPostingRows(summary.recent).slice(0, roleLimit);
  return {
    symbols: [symbol],
    sections: [
      {
        title: "Summary",
        entries: [
          { label: "Open roles", value: summary.openCount, formatted: formatNumber(summary.openCount, 0) },
          ...(summary.openPerThousandEmployees != null
            ? [{ label: "Per 1,000 employees", value: summary.openPerThousandEmployees, formatted: formatNumber(summary.openPerThousandEmployees, 1) }]
            : []),
          { label: "New, 7 days", value: summary.new7d, formatted: formatNumber(summary.new7d, 0) },
          { label: "New, 30 days", value: summary.new30d, formatted: formatNumber(summary.new30d, 0) },
          { label: "Closed, 30 days", value: summary.closed30d, formatted: formatNumber(summary.closed30d, 0) },
          { label: "Change, 30 days", value: summary.change30d?.count ?? null, formatted: formatChange(summary.change30d) },
          { label: "Change, 90 days", value: summary.change90d?.count ?? null, formatted: formatChange(summary.change90d) },
          { label: "Posted, last 30 days", value: summary.posted30d ?? null, formatted: summary.posted30d != null ? formatNumber(summary.posted30d, 0) : "-" },
          { label: "Remote share", value: summary.remoteShare, formatted: summary.remoteShare != null ? formatShare(summary.remoteShare) : "-" },
          ...(summary.evergreenShare != null && summary.evergreenCount != null
            ? [
                { label: "Evergreen share", value: summary.evergreenShare, formatted: formatShare(summary.evergreenShare) },
                {
                  label: "Specific roles",
                  value: Math.max(0, summary.openCount - summary.evergreenCount),
                  formatted: formatNumber(Math.max(0, summary.openCount - summary.evergreenCount), 0),
                },
              ]
            : []),
          ...(summary.contractShare != null
            ? [{ label: "Contract share", value: summary.contractShare, formatted: formatShare(summary.contractShare) }]
            : []),
          { label: "Median posting age", value: summary.medianAgeDays, formatted: summary.medianAgeDays != null ? `${summary.medianAgeDays} days` : "-" },
          ...(summary.salary
            ? [{
                label: "Median pay range",
                value: [summary.salary.medianMin, summary.salary.medianMax],
                formatted: `${formatSalaryRange(summary.salary.medianMin, summary.salary.medianMax, summary.salary.currency, summary.salary.period)} (${summary.salary.count} postings)`,
              }]
            : []),
          { label: "Source", value: summary.coverage.vendor, formatted: `${summary.coverage.vendor ?? "-"}${summary.coverage.lastCollectedAt ? `, read ${summary.coverage.lastCollectedAt.slice(0, 16).replace("T", " ")}` : ""}` },
        ],
      },
      {
        title: "By function",
        columns: [
          { key: "function", header: "Function" },
          { key: "count", header: "Open", align: "right", format: (value) => formatNumber(Number(value), 0) },
          { key: "share", header: "Share", align: "right", format: (value) => formatShare(Number(value)) },
          { key: "previous", header: "30d ago", align: "right", format: (value) => (value == null ? "-" : formatNumber(Number(value), 0)) },
        ],
        rows: summary.functions.map((bucket) => ({ function: bucket.label, count: bucket.count, share: bucket.share, previous: bucket.previous })),
      },
      {
        title: "By country",
        columns: [
          { key: "country", header: "Country" },
          { key: "count", header: "Open", align: "right", format: (value) => formatNumber(Number(value), 0) },
          { key: "share", header: "Share", align: "right", format: (value) => formatShare(Number(value)) },
          { key: "previous", header: "30d ago", align: "right", format: (value) => (value == null ? "-" : formatNumber(Number(value), 0)) },
        ],
        rows: summary.countries.slice(0, 12).map((bucket) => ({ country: bucket.label, count: bucket.count, share: bucket.share, previous: bucket.previous })),
      },
      {
        title: "Open roles by posting age",
        columns: [
          { key: "age", header: "Posted" },
          { key: "count", header: "Open", align: "right", format: (value) => formatNumber(Number(value), 0) },
        ],
        rows: (summary.ageBuckets ?? []).map((bucket) => ({ age: bucket.label, count: bucket.count })),
      },
      {
        title: "Signals",
        columns: [
          { key: "signal", header: "Theme" },
          { key: "count", header: "Roles", align: "right", format: (value) => formatNumber(Number(value), 0) },
        ],
        rows: summary.tags.slice(0, 10).map((bucket) => ({ signal: bucket.label, count: bucket.count })),
      },
      {
        title: "Open roles over time",
        columns: [
          { key: "day", header: "Day" },
          { key: "open", header: "Open", align: "right", format: (value) => formatNumber(Number(value), 0) },
          { key: "new", header: "New", align: "right" },
          { key: "closed", header: "Closed", align: "right" },
        ],
        rows: summary.series.slice(-30).map((point) => ({ day: point.day, open: point.open, new: point.new, closed: point.closed })),
      },
      {
        title: "Newest roles",
        columns: [
          { key: "title", header: "Role" },
          { key: "function", header: "Function" },
          { key: "location", header: "Location" },
          { key: "postedAt", header: "Posted" },
          { key: "pay", header: "Pay", align: "right" },
        ],
        rows: roles.map((row) => ({
          title: row.title,
          function: row.function,
          location: row.location,
          postedAt: row.posting.postedAt ?? row.posting.firstSeenAt.slice(0, 10),
          pay: row.salary || "-",
          url: row.posting.url,
        })),
      },
    ],
    metadata: {
      symbol,
      companyName: summary.companyName,
      coverage: { ...summary.coverage },
      openCount: summary.openCount,
    },
  };
}

/**
 * `fn JOBS NVDA`: the company's hiring picture. `fn JOBS`: every covered
 * company ranked, as one table section, so both are the same report shape.
 */
export const jobsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: {
    kind: "ticker",
    placeholder: "ticker",
    optional: true,
    description: "Listed company. Without one, every covered company ranked by open roles.",
  },
  options: [
    {
      key: "roles",
      aliases: ["limit"],
      description: "Open roles listed for a company, newest first; companies listed without one.",
      type: "integer",
      defaultValue: 15,
      minimum: 0,
      maximum: 200,
    },
  ],
  describe: (args) => (args.symbols[0] ? `Hiring | ${args.symbols[0]}` : "Hiring | coverage"),
  async load(args, ctx): Promise<HeadlessBundleResult> {
    const limit = Number(args.options.roles);
    const symbol = args.symbols[0];
    if (symbol) {
      const state = await fetchJobs(symbol, { force: true, client: ctx.apiClient as JobsCloudClient });
      return companyBundle(symbol, state, limit);
    }
    const payload = await fetchJobsMovers(ctx.apiClient as JobsCloudClient);
    const rows = buildMoverRows(payload.movers).slice(0, Math.max(limit, 15)).map((row) => ({
      ticker: row.ticker,
      company: row.company,
      openCount: row.mover.openCount,
      change30d: row.mover.change30d?.count ?? null,
      posted30d: row.mover.posted30d ?? null,
      new7d: row.mover.new7d,
      topFunction: functionLabel(row.mover.topFunction),
      topCountry: row.mover.topCountry?.code ?? null,
    }));
    return {
      sections: [
        {
          title: "Companies by open roles",
          columns: [
            { key: "ticker", header: "Ticker" },
            { key: "company", header: "Company" },
            { key: "openCount", header: "Open", align: "right", format: (value) => formatCompact(Number(value)) },
            { key: "change30d", header: "30d", align: "right", format: (value) => (value == null ? "-" : `${Number(value) > 0 ? "+" : ""}${formatNumber(Number(value), 0)}`) },
            { key: "posted30d", header: "Posted 30d", align: "right", format: (value) => (value == null ? "-" : formatCompact(Number(value))) },
            { key: "new7d", header: "New 7d", align: "right" },
            { key: "topFunction", header: "Top function" },
            { key: "topCountry", header: "Top country", format: (value) => (value == null ? "-" : String(value)) },
          ],
          rows,
        },
      ],
      metadata: { asOf: payload.asOf, covered: payload.covered },
    };
  },
};

import type { HeadlessBundleSection, HeadlessPaneDefinition } from "../../../types/plugin";
import { loadRiskReportWithClient, loadRiskReportsWithClient, type RiskReportsResult } from "./data";
import { SEC_FILINGS } from "../shared/report-freshness";

export const riskFactorsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: { ...SEC_FILINGS, basis: "10-K filings" },
  argument: { kind: "ticker", placeholder: "ticker", description: "Company symbol." },
  options: [
    { key: "year", type: "string", defaultValue: "latest", description: "Filing year (for example 2025), or latest discovered report." },
    { key: "refresh", type: "boolean", defaultValue: false, description: "Refresh the selected report and, for latest, report discovery." },
  ],
  describe: (args) => `Risk Factors | ${String(args.argument)} | ${String(args.options.year ?? "latest")}`,
  async load(args, context) {
    const ticker = String(args.argument);
    const selection = String(args.options.year ?? "latest").trim().toLowerCase();
    if (selection !== "latest" && !/^\d{4}$/.test(selection)) throw new Error("Risk report year must be a four-digit filing year or latest.");
    const force = args.options.refresh === true;
    // A specific immutable filing does not depend on the latest discovery list.
    let list: RiskReportsResult | null = null;
    if (selection === "latest") list = await loadRiskReportsWithClient(context.apiClient, ticker, { force });
    const year = list
      ? [...list.reports].sort((a, b) => b.reportYear - a.reportYear)[0]?.reportYear
      : Number(selection);
    if (year === undefined) {
      throw new Error(list?.refreshError
        ? `No cached risk report available for ${ticker}; report discovery failed: ${list.refreshError}`
        : `No 10-K risk reports on file for ${ticker}.`);
    }
    const report = await loadRiskReportWithClient(context.apiClient, ticker, year, { force });
    const sections: HeadlessBundleSection[] = [
      { title: "Filing", entries: [
        { label: "Ticker", value: report.ticker },
        { label: "Filing year", value: report.reportYear },
        { label: "Filed", value: report.filedAt },
        { label: "Report updated", value: report.updatedAt },
        { label: "Source", value: report.docUrl },
      ] },
      { title: "Analysis", entries: [{ label: "Overview", value: report.overview }] },
      { title: "Risk factors", columns: [
        { key: "index", header: "#" }, { key: "change", header: "Change" },
        { key: "group", header: "Group" }, { key: "heading", header: "Heading" },
        { key: "excerpt", header: "Source excerpt" }, { key: "note", header: "Analysis" },
      ], rows: report.risks.map((risk, index) => {
        const change = !report.diff ? null : report.diff.added.includes(index) ? "added"
          : report.diff.reworded.some((item) => item.index === index) ? "reworded" : "carried";
        const notes = change === "added" ? report.notes.added : change === "reworded" ? report.notes.reworded : report.notes.top;
        return { index: index + 1, ...risk, change, note: notes.find((note) => note.index === index)?.text ?? null };
      }) },
    ];
    if (report.diff) sections.push({ title: "Dropped risks", columns: [
      { key: "group", header: "Group" }, { key: "heading", header: "Heading" },
      { key: "excerpt", header: "Prior source excerpt" }, { key: "note", header: "Analysis" },
    ], rows: report.diff.removed.map((risk, index) => ({ ...risk, note: report.notes.removed.find((note) => note.index === index)?.text ?? null })) });
    const errors = [list?.refreshError, report.refreshError].filter((error): error is string => !!error);
    return {
      sections,
      errors: errors.length ? errors : undefined,
      ...(list?.stale || report.stale ? { complete: false } : {}),
      metadata: {
        ticker: report.ticker, requestedYear: selection, reportYear: report.reportYear,
        filedAt: report.filedAt, updatedAt: report.updatedAt, docUrl: report.docUrl,
        reportFetchedAt: report.fetchedAt, reportStale: report.stale,
        listFetchedAt: list?.fetchedAt ?? null, listStale: list?.stale ?? false,
        latestDiscoveryChecked: list !== null,
        availableYears: list?.reports.map((entry) => entry.reportYear) ?? report.otherYears.map((entry) => entry.reportYear),
        riskCount: report.riskCount, groupCount: report.groupCount, wordCount: report.wordCount,
        diff: report.diff, notes: report.notes,
      },
    };
  },
};

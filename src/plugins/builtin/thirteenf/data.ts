import {
  type Forms13FReadOptions,
  listThirteenFFormHoldings,
  listThirteenFFormHoldingsPage,
  listThirteenFForms,
  listThirteenFFilings,
  listTopThirteenFFunds,
  lookupThirteenFHoldersByCusip,
  lookupThirteenFTickers,
  normalizeCik,
  searchThirteenFFunds,
} from "./api";
import {
  buildBrowserRows,
  dateYearsAgo,
  latestLikely13FQuarter,
  recentIso,
  buildPeriodReports,
  dedupeLatestForms,
  todayIso,
} from "./model";
import type {
  FundBrowserRow,
  FundDetailData,
  ThirteenFBrowserTab,
  ThirteenFFund,
  ThirteenFHoldingRecord,
  ThirteenFTopFund,
  ThirteenFPeriodReport,
} from "./types";

const BROWSER_PAGE_LIMIT = 75;
const LATEST_FILINGS_PAGE_LIMIT = 120;
const FORM_ENRICHMENT_LIMIT = 35;

async function loadReportsForFunds(
  funds: ThirteenFFund[],
  options: Forms13FReadOptions & { from: string; to: string; signal?: AbortSignal; periods?: Map<string, string> },
): Promise<{ reports: Map<string, ThirteenFPeriodReport>; warning?: string }> {
  const reports = new Map<string, ThirteenFPeriodReport>();
  const failures: string[] = [];
  let index = 0;
  async function worker() {
    while (!options.signal?.aborted && index < funds.length) {
      const fund = funds[index++]!;
      try {
        const forms = await listThirteenFForms(fund.cik, options.from, options.to, 100, options.signal, options);
        const periods = buildPeriodReports(forms);
        const selectedPeriod = options.periods?.get(fund.cik);
        const report = selectedPeriod ? periods.find((item) => item.periodOfReport === selectedPeriod) : periods[0];
        if (report) reports.set(fund.cik, report);
      } catch {
        if (options.signal?.aborted) throw options.signal.reason;
        failures.push(`${fund.cik}: filing metadata unavailable.`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, funds.length) }, worker));
  return { reports, ...(failures.length ? { warning: failures.join(" ") } : {}) };
}

export interface BrowserLoadResult {
  rows: FundBrowserRow[];
  period?: string;
  quarter?: string;
  warning?: string;
  hasMore?: boolean;
  nextOffset?: number;
}

export async function loadBrowserRows(
  tab: ThirteenFBrowserTab,
  query: string,
  signal?: AbortSignal,
  options: { forceRefresh?: boolean; offset?: number; limit?: number } = {},
): Promise<BrowserLoadResult> {
  const warnings: string[] = [];
  const result = await loadBrowserPage(tab, query, signal, { ...options, onWarning: warning => warnings.push(warning) });
  return { ...result, warning: [...new Set([result.warning, ...warnings].filter(Boolean))].join(" ") || undefined };
}

async function loadBrowserPage(
  tab: ThirteenFBrowserTab,
  query: string,
  signal?: AbortSignal,
  options: Forms13FReadOptions & { offset?: number; limit?: number } = {},
): Promise<BrowserLoadResult> {
  const now = new Date();
  const from = dateYearsAgo(2, now);
  const to = todayIso(now);
  const quarter = latestLikely13FQuarter(now);
  const offset = Math.max(0, options.offset ?? 0);
  const browserLimit = Math.max(1, options.limit ?? BROWSER_PAGE_LIMIT);
  const latestLimit = Math.max(1, options.limit ?? LATEST_FILINGS_PAGE_LIMIT);
  const apiOptions = { forceRefresh: options.forceRefresh, onWarning: options.onWarning };
  const pageApiOptions = { ...apiOptions, offset };

  if (tab === "performance") {
    const topFunds = await listTopThirteenFFunds(quarter, browserLimit, signal, pageApiOptions);
    const quarters = [1, 2, 3].map(back => {
      const year = Number(quarter.slice(0, 4));
      const index = Number(quarter.at(-1)) - 1 - back;
      return `${year + Math.floor(index / 4)}Q${((index % 4) + 4) % 4 + 1}`;
    });
    const history = await Promise.all(quarters.map(async previous => {
      try { return new Map((await listTopThirteenFFunds(previous, 100, signal, apiOptions)).filter(fund => fund.periodOfReport === quarterToPeriod(previous)).map(fund => [fund.cik, fund.pnl])); }
      catch (error) { if (signal?.aborted) throw error; options.onWarning?.(`${previous}: performance ranking unavailable.`); return new Map<string, number | null>(); }
    }));
    const funds: ThirteenFFund[] = topFunds.map((fund) => ({ cik: fund.cik, name: fund.name }));
    const { reports, warning } = await loadReportsForFunds(funds.slice(0, Math.min(browserLimit, FORM_ENRICHMENT_LIMIT)), {
      from, to, signal, ...apiOptions,
      periods: new Map(topFunds.map((fund) => [fund.cik, fund.periodOfReport])),
    });
    return {
      rows: buildBrowserRows({ topFunds, reports, source: "performance" }).map(row => ({ ...row, priorReturns: quarters.map((previous, index) => ({ quarter: previous, value: history[index]?.get(row.cik) ?? null })) })),
      warning,
      quarter,
      period: topFunds[0]?.periodOfReport,
      hasMore: topFunds.length >= browserLimit,
      nextOffset: offset + topFunds.length,
    };
  }

  if (tab === "latest") {
    const filings = await listThirteenFFilings(recentIso(21, now), to, latestLimit, signal, pageApiOptions);
    const selected = dedupeLatestForms(filings);
    const { reports, warning } = await loadReportsForFunds(selected.map((form) => ({ cik: form.cik, name: form.companyName })), {
      from, to, signal, ...apiOptions,
      periods: new Map(selected.map((form) => [form.cik, form.periodOfReport])),
    });
    return {
      rows: buildBrowserRows({ latestFilings: filings, reports, source: "latest" }),
      warning,
      period: filings[0]?.periodOfReport,
      hasMore: filings.length >= latestLimit,
      nextOffset: offset + filings.length,
    };
  }

  if (tab === "byTicker") {
    const ticker = query.trim().toUpperCase();
    if (!ticker) return { rows: [], quarter };
    const tickers = await lookupThirteenFTickers([ticker], signal, apiOptions);
    const exact = tickers.filter((item) => item.ticker === ticker);
    const candidates = exact.length > 0 ? exact : tickers;
    const cusips = [...new Set(candidates.map((item) => item.cusip).filter(Boolean))];
    const cusip = cusips.length === 1 ? cusips[0] : undefined;
    if (!cusip) {
      return {
        rows: [],
        quarter,
        warning: cusips.length === 0 ? `No CUSIP found for ${ticker}` : `Ambiguous CUSIP for ${ticker}`,
      };
    }
    const periodOfReport = quarterToPeriod(quarter);
    try {
      const holders = await lookupThirteenFHoldersByCusip(cusip, periodOfReport, signal, apiOptions);
      const pageCiks = holders.ciks.slice(offset, offset + browserLimit);
      const { reports, warning } = await loadReportsForFunds(pageCiks.map((cik) => ({ cik, name: cik })), {
        from, to, signal, ...apiOptions,
        periods: new Map(pageCiks.map((cik) => [cik, holders.periodOfReport])),
      });
      const funds = pageCiks.map((cik) => ({ cik, name: reports.get(cik)?.filings.at(-1)?.companyName || cik }));
      return {
        rows: buildBrowserRows({ funds, reports, source: "ticker" }),
        warning,
        period: holders.periodOfReport,
        hasMore: holders.ciks.length > offset + pageCiks.length,
        nextOffset: offset + pageCiks.length,
      };
    } catch (error) {
      return {
        rows: [],
        quarter,
        warning: error instanceof Error ? error.message : "Ticker holder lookup failed",
      };
    }
  }

  const trimmed = query.trim();
  if (!trimmed) return { rows: [], quarter };
  if (/^\d{6,10}$/.test(trimmed)) {
    const cik = normalizeCik(trimmed);
    const forms = await listThirteenFForms(cik, from, to, 100, signal, apiOptions);
    const report = buildPeriodReports(forms)[0];
    const form = report?.filings.at(-1);
    const fund = { cik, name: form?.companyName || cik };
    const reports = new Map<string, ThirteenFPeriodReport>();
    if (report) reports.set(cik, report);
    return {
      rows: buildBrowserRows({ funds: [fund], reports, source: "funds" }),
      period: form?.periodOfReport,
      hasMore: false,
      nextOffset: offset + 1,
    };
  }
  const funds = await searchThirteenFFunds(trimmed, browserLimit, signal, pageApiOptions);
  const [{ reports, warning }, topFunds] = await Promise.all([
    loadReportsForFunds(funds.slice(0, Math.min(browserLimit, FORM_ENRICHMENT_LIMIT)), { from, to, signal, ...apiOptions }),
    listTopThirteenFFunds(quarter, browserLimit, signal, apiOptions).catch(() => []),
  ]);
  const topByCik = new Map(topFunds.map((fund) => [fund.cik, fund]));
  const matchedTopFunds = funds
    .map((fund) => topByCik.get(fund.cik))
    .filter((fund): fund is ThirteenFTopFund => !!fund);
  return {
    rows: buildBrowserRows({
      funds,
      topFunds: matchedTopFunds,
      reports,
      source: "funds",
    }),
    quarter,
    warning,
    hasMore: funds.length >= browserLimit,
    nextOffset: offset + funds.length,
  };
}

export async function loadFundDetail(
  cik: string,
  fallbackName: string,
  signal?: AbortSignal,
  options: { forceRefresh?: boolean } = {},
): Promise<FundDetailData> {
  const now = new Date();
  const warnings: string[] = [];
  const apiOptions = { forceRefresh: options.forceRefresh, onWarning: (warning: string) => warnings.push(warning) };

  const forms = await listThirteenFForms(
    cik,
    dateYearsAgo(4, now),
    todayIso(now),
    100,
    signal,
    apiOptions,
  );
  const reports = buildPeriodReports(forms);
  const latestReport = reports[0];
  const previousReport = reports[1];
  const latestForm = latestReport?.filings.at(-1) ?? null;
  const previousForm = previousReport?.filings.at(-1) ?? null;
  async function loadReport(report: ThirteenFPeriodReport | undefined): Promise<ThirteenFHoldingRecord[]> {
    if (!report) return [];
    const holdings: ThirteenFHoldingRecord[] = [];
    for (const form of report.filings) {
      const rows = await listThirteenFFormHoldings(cik, form.accessionNumber, signal, apiOptions);
      holdings.push(...rows);
      if (form.tableEntryTotal != null && rows.length !== form.tableEntryTotal) {
        report.complete = false;
        warnings.push(`${report.periodOfReport}: loaded ${rows.length} of ${form.tableEntryTotal} disclosed entries for ${form.accessionNumber}.`);
      }
    }
    if (!report.complete && !warnings.some((warning) => warning.startsWith(report.periodOfReport))) {
      warnings.push(`${report.periodOfReport}: amendment type or original report unavailable; disclosed entries cannot be reconciled into a full report.`);
    }
    return holdings;
  }
  const [latestHoldings, previousHoldings] = await Promise.all([
    loadReport(latestReport),
    loadReport(previousReport).catch((error) => {
      if (signal?.aborted) throw error;
      if (previousReport) previousReport.complete = false;
      warnings.push(`${previousReport?.periodOfReport ?? "Prior quarter"}: holdings unavailable; comparison unavailable.`);
      return [];
    }),
  ]);
  return {
    cik: normalizeCik(cik),
    name: latestForm?.companyName || fallbackName,
    forms,
    latestForm,
    previousForm,
    latestHoldings,
    previousHoldings,
    latestReport,
    previousReport,
    warnings,
  };
}

export async function loadFilingPositions(
  cik: string,
  accessionNumber: string,
  signal?: AbortSignal,
  options: { forceRefresh?: boolean; offset?: number; limit?: number } = {},
): Promise<{ rows: ThirteenFHoldingRecord[]; hasMore: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  const result = await listThirteenFFormHoldingsPage(cik, accessionNumber, signal, {
    ...options, onWarning: warning => warnings.push(warning),
  });
  return { ...result, warnings };
}

function quarterToPeriod(quarter: string): string {
  const match = /^(\d{4})Q([1-4])$/.exec(quarter);
  if (!match) return "";
  const year = match[1];
  switch (match[2]) {
    case "1":
      return `${year}-03-31`;
    case "2":
      return `${year}-06-30`;
    case "3":
      return `${year}-09-30`;
    default:
      return `${year}-12-31`;
  }
}

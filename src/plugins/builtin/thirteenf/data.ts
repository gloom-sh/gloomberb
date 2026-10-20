import {
  type Forms13FReadOptions,
  listThirteenFFormHoldings,
  listThirteenFFormHoldingsPage,
  listThirteenFForms,
  listThirteenFFilings,
  listTopThirteenFFunds,
  loadThirteenFFilerStatus,
  lookupThirteenFHoldersByCusip,
  lookupThirteenFTickers,
  normalizeCik,
  searchThirteenFFunds,
} from "./api";
import { isoDateDaysAgo, isoDateToday, isoDateYearsAgo } from "../../../utils/calendar-date";
import { abortable, withDeadline } from "../../../utils/async-deadline";
import { logFailure } from "../../../utils/log-failure";
import {
  buildBrowserRows,
  filingGapFor,
  estimateFilingQuarterReturn,
  hasComparable13FQuarter,
  latestLikely13FQuarter,
  oneFundPerCik,
  buildPeriodReports,
  dedupeLatestForms,
  filingSplitCandidates,
  type FilingQuarterReturn,
} from "./model";
import { mapWithConcurrency } from "../../../utils/concurrency";
import { describeTickerChange, movedAwayChange, startTickerChangeLookup } from "../../../tickers/ticker-changes";
import type { DataProvider } from "../../../types/data-provider";
import type {
  FundBrowserRow,
  FundDetailData,
  ThirteenFBrowserTab,
  ThirteenFFilingGap,
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

function copyReportFields(rows: FundBrowserRow[], nextRows: FundBrowserRow[]) {
  const byId = new Map(nextRows.map((row) => [row.id, row]));
  for (const row of rows) {
    const next = byId.get(row.id);
    if (!next) continue;
    row.name = next.name;
    row.periodOfReport = next.periodOfReport;
    row.filedAsOfDate = next.filedAsOfDate;
    row.tableValueTotal = next.tableValueTotal;
    row.tableEntryTotal = next.tableEntryTotal;
    if ("estQuarterReturn" in next) row.estQuarterReturn = next.estQuarterReturn;
  }
}

function fillReports(
  result: BrowserLoadResult,
  rows: FundBrowserRow[],
  pending: Promise<{ reports: Map<string, ThirteenFPeriodReport>; warning?: string }>,
  rebuild: (reports: Map<string, ThirteenFPeriodReport>) => FundBrowserRow[],
  signal?: AbortSignal,
) {
  result.reportsLoaded = pending.then(({ reports, warning }) => {
    if (signal?.aborted) return;
    copyReportFields(rows, rebuild(reports));
    if (warning) result.warning = [result.warning, warning].filter(Boolean).join(" ");
  }).catch((error: unknown) => {
    if (signal?.aborted) return;
    throw error;
  });
}

export interface BrowserLoadResult {
  rows: FundBrowserRow[];
  period?: string;
  quarter?: string;
  warning?: string;
  hasMore?: boolean;
  nextOffset?: number;
  reportsLoaded?: Promise<void>;
}

export async function loadBrowserRows(
  tab: ThirteenFBrowserTab,
  query: string,
  signal?: AbortSignal,
  options: { forceRefresh?: boolean; offset?: number; limit?: number } = {},
): Promise<BrowserLoadResult> {
  const warnings: string[] = [];
  const result = await loadBrowserPage(tab, query, signal, { ...options, onWarning: warning => warnings.push(warning) });
  if (warnings.length) result.warning = [...new Set([result.warning, ...warnings].filter(Boolean))].join(" ") || undefined;
  return result;
}

async function loadBrowserPage(
  tab: ThirteenFBrowserTab,
  query: string,
  signal?: AbortSignal,
  options: Forms13FReadOptions & { offset?: number; limit?: number } = {},
): Promise<BrowserLoadResult> {
  const now = new Date();
  const from = isoDateYearsAgo(2, now);
  const to = isoDateToday(now);
  const quarter = latestLikely13FQuarter(now);
  const offset = Math.max(0, options.offset ?? 0);
  const browserLimit = Math.max(1, options.limit ?? BROWSER_PAGE_LIMIT);
  const latestLimit = Math.max(1, options.limit ?? LATEST_FILINGS_PAGE_LIMIT);
  const apiOptions = { forceRefresh: options.forceRefresh, onWarning: options.onWarning };
  const pageApiOptions = { ...apiOptions, offset };

  if (tab === "performance") {
    const topFunds = await listTopThirteenFFunds(quarter, browserLimit, signal, pageApiOptions);
    const quarters = priorQuarters(quarter);
    const history = await loadRankingHistory(quarters, signal, { ...apiOptions, onWarning: options.onWarning });
    const funds: ThirteenFFund[] = topFunds.map((fund) => ({ cik: fund.cik, name: fund.name }));
    const rows = buildBrowserRows({ topFunds, source: "performance" }).map(row => ({ ...row, priorReturns: quarters.map((previous, index) => ({ quarter: previous, value: history[index]?.get(row.cik) ?? null })) }));
    const result: BrowserLoadResult = {
      rows,
      quarter,
      period: topFunds[0]?.periodOfReport,
      hasMore: topFunds.length >= browserLimit,
      nextOffset: offset + topFunds.length,
    };
    fillReports(result, rows, loadReportsForFunds(funds.slice(0, Math.min(browserLimit, FORM_ENRICHMENT_LIMIT)), {
      from, to, signal, ...apiOptions,
      periods: new Map(topFunds.map((fund) => [fund.cik, fund.periodOfReport])),
    }), (reports) => buildBrowserRows({ topFunds, reports, source: "performance" }), signal);
    return result;
  }

  if (tab === "latest") {
    const filings = await listThirteenFFilings(isoDateDaysAgo(21, now), to, latestLimit, signal, pageApiOptions);
    const selected = dedupeLatestForms(filings);
    const rows = buildBrowserRows({ latestFilings: filings, source: "latest" });
    const result: BrowserLoadResult = {
      rows,
      period: filings[0]?.periodOfReport,
      hasMore: filings.length >= latestLimit,
      nextOffset: offset + filings.length,
    };
    fillReports(result, rows, loadReportsForFunds(selected.map((form) => ({ cik: form.cik, name: form.companyName })), {
      from, to, signal, ...apiOptions,
      periods: new Map(selected.map((form) => [form.cik, form.periodOfReport])),
    }), (reports) => buildBrowserRows({ latestFilings: filings, reports, source: "latest" }), signal);
    return result;
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
      const funds = pageCiks.map((cik) => ({ cik, name: cik }));
      const rows = buildBrowserRows({ funds, source: "ticker" });
      const result: BrowserLoadResult = {
        rows,
        period: holders.periodOfReport,
        hasMore: holders.ciks.length > offset + pageCiks.length,
        nextOffset: offset + pageCiks.length,
      };
      fillReports(result, rows, loadReportsForFunds(funds, {
        from, to, signal, ...apiOptions,
        periods: new Map(pageCiks.map((cik) => [cik, holders.periodOfReport])),
      }), (reports) => buildBrowserRows({
        funds: pageCiks.map((cik) => ({ cik, name: reports.get(cik)?.filings.at(-1)?.companyName || cik })),
        reports,
        source: "ticker",
      }), signal);
      return result;
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
  const found = await searchThirteenFFunds(trimmed, browserLimit, signal, pageApiOptions);
  const funds = oneFundPerCik(found);
  const topFunds = await listTopThirteenFFunds(quarter, browserLimit, signal, apiOptions).catch((error: unknown): ThirteenFTopFund[] => {
    if (!signal?.aborted) logFailure("thirteenf.data", "Load performance ranks for fund search failed")(error);
    return [];
  });
  const topByCik = new Map(topFunds.map((fund) => [fund.cik, fund]));
  const matchedTopFunds = funds
    .map((fund) => topByCik.get(fund.cik))
    .filter((fund): fund is ThirteenFTopFund => !!fund);
  const rows = buildBrowserRows({ funds: oneFundPerCik(found), topFunds: matchedTopFunds, source: "funds" });
  const result: BrowserLoadResult = {
    rows,
    quarter,
    hasMore: found.length >= browserLimit,
    nextOffset: offset + found.length,
  };
  fillReports(result, rows, loadReportsForFunds(funds.slice(0, Math.min(browserLimit, FORM_ENRICHMENT_LIMIT)), {
    from, to, signal, ...apiOptions,
  }), (reports) => buildBrowserRows({
    funds: oneFundPerCik(found, reports),
    topFunds: matchedTopFunds,
    reports,
    source: "funds",
  }), signal);
  return result;
}

/** How long a fund's report waits on EDGAR's filing list before it goes out unchecked. */
const FILER_STATUS_TIMEOUT_MS = 4_000;

/**
 * What the fund filed for the newest quarter past its deadline, when its
 * latest report (`latestPeriod`) predates that quarter: EDGAR says whether it
 * was a 13F-NT and who reported instead. Null when the report is current; a
 * gap with `checked: false` when EDGAR could not be asked (a server without
 * the route, a failure, or no answer within the deadline).
 */
export async function loadFilingGap(
  cik: string,
  latestPeriod: string | null | undefined,
  signal?: AbortSignal,
  now = new Date(),
  options: { forceRefresh?: boolean; timeoutMs?: number } = {},
): Promise<ThirteenFFilingGap | null> {
  if (!filingGapFor(latestPeriod, null, now)) return null;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeoutMs = options.timeoutMs ?? FILER_STATUS_TIMEOUT_MS;
  try {
    const status = await withDeadline(
      loadThirteenFFilerStatus(cik, controller.signal, { forceRefresh: options.forceRefresh }),
      timeoutMs,
      `13F filer status timed out after ${timeoutMs}ms`,
      (error) => controller.abort(error),
    ).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return null;
    });
    return filingGapFor(latestPeriod, status, now);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/** The three quarters before `quarter` (`2026Q2`), newest first, as the performance list's columns name them. */
function priorQuarters(quarter: string): string[] {
  return [1, 2, 3].map(back => {
    const year = Number(quarter.slice(0, 4));
    const index = Number(quarter.at(-1)) - 1 - back;
    return `${year + Math.floor(index / 4)}Q${((index % 4) + 4) % 4 + 1}`;
  });
}

/** Each quarter's ranked estimates by CIK; a quarter whose ranking fails is empty, with a warning. */
async function loadRankingHistory(
  quarters: readonly string[],
  signal: AbortSignal | undefined,
  options: Forms13FReadOptions,
): Promise<Array<Map<string, number | null>>> {
  return Promise.all(quarters.map(async previous => {
    try { return new Map((await listTopThirteenFFunds(previous, 100, signal, options)).filter(fund => fund.periodOfReport === quarterToPeriod(previous)).map(fund => [fund.cik, fund.pnl])); }
    catch (error) { if (signal?.aborted) throw error; options.onWarning?.(`${previous}: performance ranking unavailable.`); return new Map<string, number | null>(); }
  }));
}

/** How far down the performance ranking a fund's own row is looked for. */
const RANKING_LOOKUP_LIMIT = 100;

/** One fund's row of the performance list, and where its estimate comes from. */
export interface FundPerformanceResult extends BrowserLoadResult {
  /** `ranking`: the fund's own row of the ranking; `filings`: estimated from its last two filings; null: neither has one. */
  basis: "ranking" | "filings" | null;
  /**
   * The fund in its latest quarter's ranking: `ranked` (with or without a
   * return), `unranked`, or `unavailable` when the ranking failed to load;
   * null without a filed quarter.
   */
  ranking: "ranked" | "unranked" | "unavailable" | null;
  /** Lines of a filings estimate split between the filings (priced split-adjusted) and those left out; see estimateFilingQuarterReturn. */
  splits?: FilingQuarterReturn["splits"];
  skipped?: FilingQuarterReturn["skipped"];
  /** What EDGAR shows for the quarter after the fund's latest report, when it is behind (loadFundDetail). */
  filingGap?: ThirteenFFilingGap | null;
  /** Why there is no estimate, when there is none. */
  unavailable?: string;
}

/** A ticker's split factor, new shares per old, after one day through another: 1 for none, null when its actions cannot be read. */
export type SplitFactorLookup = (ticker: string, after: string, through: string) => Promise<number | null>;

/** The least provider adjustment that is a share split: 5:4. A spinoff's price adjustment, nearer 1, changes no share count. */
const MIN_SPLIT_FACTOR = 1.25;

/** The share splits a ticker's own corporate actions show, as one factor; see corporateSplitFactor. */
async function ownSplitFactor(marketData: Pick<DataProvider, "getCorporateActions">, ticker: string, after: string, through: string): Promise<number | null> {
  if (!marketData.getCorporateActions) return null;
  const actions = await marketData.getCorporateActions(ticker);
  if (actions.coverage?.splits === "unavailable") return null;
  return actions.splits.reduce((factor, split) => {
    const ratio = split.fromFactor && split.toFactor ? split.toFactor / split.fromFactor : split.ratio;
    const inWindow = split.date.slice(0, 10) > after && split.date.slice(0, 10) <= through;
    return inWindow && ratio && Number.isFinite(ratio) && Math.abs(Math.log(ratio)) >= Math.log(MIN_SPLIT_FACTOR) - 1e-9 ? factor * ratio : factor;
  }, 1);
}

/** How long a renamed ticker's change record is waited for. */
const RENAME_LOOKUP_MS = 5_000;

/**
 * The share splits a ticker's corporate actions show after `after` through
 * `through` (ex-dates, `YYYY-MM-DD`), as one factor of new shares per old: 1
 * for none, null when the source has no corporate actions or says it has no
 * splits for the ticker.
 *
 * A ticker its company has left (BK became BNY, VSCO became VSXY) has none of
 * its own, so when the ticker's actions are unreadable they are asked of the
 * symbol the company trades as now, once, when its change record says nothing
 * lists under the old one. A ticker with no such record stays unreadable.
 */
export async function corporateSplitFactor(marketData: Pick<DataProvider, "getCorporateActions" | "getTickerChanges">, ticker: string, after: string, through: string): Promise<number | null> {
  let failure: unknown;
  const own = await ownSplitFactor(marketData, ticker, after, through).catch((error: unknown) => { failure = error; return null; });
  if (own != null) return own;
  const payload = await startTickerChangeLookup(marketData, ticker).settle(RENAME_LOOKUP_MS);
  const current = movedAwayChange(describeTickerChange(ticker, payload))?.tradesAs;
  if (!current || current.toUpperCase() === ticker.trim().toUpperCase()) {
    if (failure) throw failure;
    return null;
  }
  return ownSplitFactor(marketData, current, after, through);
}

/** Corporate-action lookups in flight at once for one fund's split candidates. */
const SPLIT_LOOKUP_CONCURRENCY = 6;
/** How long one ticker's corporate actions are waited for before its split reads as unconfirmed. */
const SPLIT_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * The split factor between a fund's two quarter ends for each of its split
 * candidates (filingSplitCandidates), by row id, for estimateFilingQuarterReturn
 * and the Holdings rows: a few lookups at once, each as the lookup answers it.
 * A line the lookup cannot answer for (no ticker, a failure, no answer in time)
 * is null, unconfirmed. Only an abort rejects. A fund with no candidates, or
 * without two comparable quarters, makes no lookup.
 */
export async function loadSplitFactors(detail: FundDetailData, lookup: SplitFactorLookup, signal?: AbortSignal): Promise<Map<string, number | null>> {
  const period = detail.latestForm?.periodOfReport;
  const previousPeriod = detail.previousForm?.periodOfReport;
  if (!period || !previousPeriod) return new Map();
  return new Map(await mapWithConcurrency(filingSplitCandidates(detail), SPLIT_LOOKUP_CONCURRENCY, async (line) => {
    signal?.throwIfAborted();
    if (!line.ticker) return [line.id, null] as const;
    const factor = await abortable(
      withDeadline(lookup(line.ticker, previousPeriod, period), SPLIT_LOOKUP_TIMEOUT_MS, `${line.ticker} split lookup timed out`),
      signal,
      "Split lookup aborted",
    ).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return null;
    });
    return [line.id, factor] as const;
  }));
}

/**
 * One fund's row of the performance list, with the list's columns: its
 * ranking's return for its latest quarter when the ranking gives one,
 * otherwise its return estimated from its own last two filings
 * (estimateFilingQuarterReturn); `ranking` says whether the ranking lists it
 * without a return, leaves it out, or failed to load. The prior quarters are
 * the ranking's, as the list's are.
 */
export async function loadFundPerformance(
  cik: string,
  fallbackName: string,
  signal?: AbortSignal,
  options: { forceRefresh?: boolean; splitFactor?: SplitFactorLookup } = {},
): Promise<FundPerformanceResult> {
  const warnings: string[] = [];
  const apiOptions = { forceRefresh: options.forceRefresh, onWarning: (warning: string) => warnings.push(warning) };
  const detail = await loadFundDetail(cik, fallbackName, signal, options);
  const period = detail.latestForm?.periodOfReport;
  const quarter = period ? periodToQuarter(period) : null;
  const quarters = quarter ? priorQuarters(quarter) : [];
  const [ranked, history] = await Promise.all([
    quarter
      ? listTopThirteenFFunds(quarter, RANKING_LOOKUP_LIMIT, signal, apiOptions).catch((error: unknown): null => {
        if (signal?.aborted) throw error;
        warnings.push(`${quarter}: performance ranking unavailable.`);
        return null;
      })
      : Promise.resolve(null),
    loadRankingHistory(quarters, signal, apiOptions),
  ]);
  const own = ranked?.find((fund) => fund.cik === detail.cik && fund.periodOfReport === period);
  const ranking = !quarter ? null : !ranked ? "unavailable" : own ? "ranked" : "unranked";
  // A line that moved as across a split is priced by its corporate actions: split-adjusted, as a trade, or left out unread.
  const factors = own?.pnl != null || !options.splitFactor ? new Map<string, number | null>() : await loadSplitFactors(detail, options.splitFactor, signal);
  const filed = own?.pnl != null ? null : estimateFilingQuarterReturn(detail, factors);
  const estimate = own?.pnl ?? filed?.percent ?? null;
  const basis = own?.pnl != null ? "ranking" : estimate != null ? "filings" : null;
  const latest = detail.latestReport;
  const row: FundBrowserRow = {
    id: `performance:${detail.cik}`,
    cik: detail.cik,
    name: detail.name,
    periodOfReport: period,
    filedAsOfDate: detail.latestForm?.filedAsOfDate,
    // An incomplete report has no total to state, as the list leaves it out.
    tableValueTotal: latest ? (latest.complete ? latest.tableValueTotal : null) : null,
    tableEntryTotal: latest ? (latest.complete ? latest.tableEntryTotal : null) : null,
    estQuarterReturn: estimate,
    priorReturns: quarters.map((previous, index) => ({ quarter: previous, value: history[index]?.get(detail.cik) ?? null })),
    source: "performance",
  };
  const unavailable = basis ? undefined
    : !period ? "No 13F filing in the last four years."
      : !hasComparable13FQuarter(detail) ? `No comparable quarter before ${period} to estimate a return from.`
        : filed?.skipped.length ? `No share position held through the quarter to ${period} that could be priced across it.`
          : `No share position held through the quarter to ${period}.`;
  const warning = [...new Set([...(detail.warnings ?? []), ...warnings])].join(" ") || undefined;
  return {
    rows: [row], ...(quarter ? { quarter } : {}), ...(period ? { period } : {}), hasMore: false, basis, ranking,
    ...(filed?.splits.length ? { splits: filed.splits } : {}),
    ...(filed?.skipped.length ? { skipped: filed.skipped } : {}),
    ...(detail.filingGap ? { filingGap: detail.filingGap } : {}),
    ...(unavailable ? { unavailable } : {}), ...(warning ? { warning } : {}),
  };
}

export async function loadFundDetail(
  cik: string,
  fallbackName: string,
  signal?: AbortSignal,
  /** `filingGap: false` skips EDGAR's filing list, for a load that never shows it (an overlap). */
  options: { forceRefresh?: boolean; filingGap?: boolean } = {},
): Promise<FundDetailData> {
  const now = new Date();
  const warnings: string[] = [];
  const apiOptions = { forceRefresh: options.forceRefresh, onWarning: (warning: string) => warnings.push(warning) };

  const forms = await listThirteenFForms(
    cik,
    isoDateYearsAgo(4, now),
    isoDateToday(now),
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
  const [latestHoldings, previousHoldings, filingGap] = await Promise.all([
    loadReport(latestReport),
    loadReport(previousReport).catch((error) => {
      if (signal?.aborted) throw error;
      if (previousReport) previousReport.complete = false;
      warnings.push(`${previousReport?.periodOfReport ?? "Prior quarter"}: holdings unavailable; comparison unavailable.`);
      return [];
    }),
    options.filingGap === false ? null
      : loadFilingGap(cik, latestForm?.periodOfReport, signal, now, { forceRefresh: options.forceRefresh }),
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
    filingGap,
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

/** `2026Q2` for a quarter end such as 2026-06-30. */
function periodToQuarter(period: string): string | null {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(period);
  return match ? `${match[1]}Q${Math.floor((Number(match[2]) - 1) / 3) + 1}` : null;
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

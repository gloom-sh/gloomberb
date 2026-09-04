import {
  listThirteenFFormHoldings,
  listThirteenFFormHoldingsPage,
  listThirteenFForms,
  listThirteenFFilings,
  listTopThirteenFFunds,
  lookupThirteenFHoldersByCusip,
  lookupThirteenFTickers,
  loadLatestFormsForFunds,
  normalizeCik,
  searchThirteenFFunds,
} from "./api";
import {
  buildBrowserRows,
  dateYearsAgo,
  latestLikely13FQuarter,
  recentIso,
  selectLatestFormsByPeriod,
  todayIso,
} from "./model";
import type {
  FundBrowserRow,
  FundDetailData,
  ThirteenFBrowserTab,
  ThirteenFFormSummary,
  ThirteenFFund,
  ThirteenFHoldingRecord,
  ThirteenFTopFund,
} from "./types";

const BROWSER_PAGE_LIMIT = 75;
const LATEST_FILINGS_PAGE_LIMIT = 120;
const FORM_ENRICHMENT_LIMIT = 35;

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
  const now = new Date();
  const from = dateYearsAgo(2, now);
  const to = todayIso(now);
  const quarter = latestLikely13FQuarter(now);
  const offset = Math.max(0, options.offset ?? 0);
  const browserLimit = Math.max(1, options.limit ?? BROWSER_PAGE_LIMIT);
  const latestLimit = Math.max(1, options.limit ?? LATEST_FILINGS_PAGE_LIMIT);
  const apiOptions = { forceRefresh: options.forceRefresh };
  const pageApiOptions = { forceRefresh: options.forceRefresh, offset };

  if (tab === "performance") {
    const topFunds = await listTopThirteenFFunds(quarter, browserLimit, signal, pageApiOptions);
    const funds: ThirteenFFund[] = topFunds.map((fund) => ({ cik: fund.cik, name: fund.name }));
    const forms = await loadLatestFormsForFunds(funds.slice(0, Math.min(browserLimit, FORM_ENRICHMENT_LIMIT)), { from, to, signal, concurrency: 5, forceRefresh: options.forceRefresh });
    return {
      rows: buildBrowserRows({ topFunds, forms, source: "performance" }),
      quarter,
      period: topFunds[0]?.periodOfReport,
      hasMore: topFunds.length >= browserLimit,
      nextOffset: offset + topFunds.length,
    };
  }

  if (tab === "latest") {
    const filings = await listThirteenFFilings(recentIso(21, now), to, latestLimit, signal, pageApiOptions);
    return {
      rows: buildBrowserRows({ latestFilings: filings, source: "latest" }),
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
      const forms = new Map<string, ThirteenFFormSummary>();
      const pageCiks = holders.ciks.slice(offset, offset + browserLimit);
      const funds = await Promise.all(pageCiks.map(async (cik): Promise<ThirteenFFund> => {
        const fundForms = await listThirteenFForms(cik, from, to, 1, signal, apiOptions);
        if (fundForms[0]) forms.set(cik, fundForms[0]);
        return {
          cik,
          name: fundForms[0]?.companyName || cik,
        };
      }));
      return {
        rows: buildBrowserRows({ funds, forms, source: "ticker" }),
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
    const forms = await listThirteenFForms(cik, from, to, 1, signal, apiOptions);
    const fund = { cik, name: forms[0]?.companyName || cik };
    const formsMap = new Map<string, NonNullable<typeof forms[0]>>();
    if (forms[0]) formsMap.set(cik, forms[0]);
    return {
      rows: buildBrowserRows({ funds: [fund], forms: formsMap, source: "funds" }),
      period: forms[0]?.periodOfReport,
      hasMore: false,
      nextOffset: offset + 1,
    };
  }
  const funds = await searchThirteenFFunds(trimmed, browserLimit, signal, pageApiOptions);
  const [forms, topFunds] = await Promise.all([
    loadLatestFormsForFunds(funds.slice(0, Math.min(browserLimit, FORM_ENRICHMENT_LIMIT)), { from, to, signal, concurrency: 5, forceRefresh: options.forceRefresh }),
    listTopThirteenFFunds(quarter, browserLimit, signal, { forceRefresh: options.forceRefresh }).catch(() => []),
  ]);
  const topByCik = new Map(topFunds.map((fund) => [fund.cik, fund]));
  const matchedTopFunds = funds
    .map((fund) => topByCik.get(fund.cik))
    .filter((fund): fund is ThirteenFTopFund => !!fund);
  return {
    rows: buildBrowserRows({
      funds,
      topFunds: matchedTopFunds,
      forms,
      source: "funds",
    }),
    quarter,
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
  const apiOptions = { forceRefresh: options.forceRefresh };

  const forms = selectLatestFormsByPeriod(await listThirteenFForms(
    cik,
    dateYearsAgo(4, now),
    todayIso(now),
    20,
    signal,
    apiOptions,
  ));
  const latestForm = forms[0] ?? null;
  const previousForm = forms[1] ?? null;
  const [latestHoldings, previousHoldings] = await Promise.all([
    latestForm ? listThirteenFFormHoldings(cik, latestForm.accessionNumber, signal, apiOptions) : Promise.resolve([]),
    previousForm ? listThirteenFFormHoldings(cik, previousForm.accessionNumber, signal, apiOptions) : Promise.resolve([]),
  ]);
  return {
    cik: normalizeCik(cik),
    name: latestForm?.companyName || fallbackName,
    forms,
    latestForm,
    previousForm,
    latestHoldings,
    previousHoldings,
  };
}

export async function loadFilingPositions(
  cik: string,
  accessionNumber: string,
  signal?: AbortSignal,
  options: { forceRefresh?: boolean; offset?: number; limit?: number } = {},
): Promise<{ rows: ThirteenFHoldingRecord[]; hasMore: boolean }> {
  return listThirteenFFormHoldingsPage(cik, accessionNumber, signal, options);
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

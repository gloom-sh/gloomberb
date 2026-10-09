import { formatPriceEarnings } from "../../../../utils/price-earnings";
import { convertMarketCapitalization } from "../../../../utils/market-capitalization";
import { priceColor } from "../../../../theme/colors";
import type { CompanyProfile, NextEarnings, Quote, TickerFinancials } from "../../../../types/financials";
import type { TickerPosition, TickerRecord } from "../../../../types/ticker";
import {
  formatCompact,
  formatCompactCurrency,
  formatCurrency,
  formatNumber,
  formatLevelPercent,
  formatPercent,
  formatPercentRaw,
} from "../../../../utils/format";
import {
  formatMarketCostWithCurrency,
  formatMarketPriceWithCurrency,
  formatMarketQuantity,
  withCurrencyMinorDigits,
} from "../../../../market-data/market/format";
import type { OverviewFunctionLink, PositionTableRow, StatField } from "./types";
import { getPortfolioPositionMetrics, getPortfolioQuoteDisplay, resolvePortfolioMarketValue, resolvePortfolioPositionPnl, portfolioPnlPercent, signedPositionDirection } from "../../portfolio-list/position-metrics";
import { liveDividendYield, liveForwardPE, liveMarketCapitalization, liveTrailingPE } from "../../portfolio-list/live-valuation";
import { formatReportedMoney } from "../../../../utils/reported-money";
import { formatShortDate } from "../../../../utils/datetime-format";
import { safeExternalUrl } from "../../../../utils/external-url";

type CurrencyConverter = (value: number, fromCurrency: string) => number;

const RELATIONSHIP_GRAPH: OverviewFunctionLink = { name: "Relationship Graph", templateId: "relationship-graph-pane" };
const HOLDERS: OverviewFunctionLink = { name: "Holders", tabId: "holders", templateId: "holders-pane" };
const SHORT_INTEREST: OverviewFunctionLink = { name: "Short Interest", tabId: "short-interest", templateId: "short-interest-pane" };
const EARNINGS: OverviewFunctionLink = { name: "Earnings", templateId: "earnings-calendar-pane" };
const DIVIDENDS: OverviewFunctionLink = { name: "Dividends", tabId: "dividend-yield", templateId: "dividend-yield-pane" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const finite = (value: number | undefined): value is number => value != null && Number.isFinite(value);

/** Whole calendar days from `today` to `date`, both YYYY-MM-DD. */
function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** "Sep 10", or "Dec 12, 25" in another year. */
function calendarDate(date: string, today: string): string {
  return formatShortDate(`${date}T00:00:00Z`, { year: date.slice(0, 4) === today.slice(0, 4) ? false : "2-digit", utc: true });
}

/** "in 49d", then "49d" for a narrow column. */
function daysAhead(days: number, prefix?: string): string[] {
  const lead = prefix ? `${prefix} ` : "";
  return days === 0 ? [`${lead}today`] : [`${lead}in ${days}d`, `${lead}${days}d`];
}

function compactPositionAccount(position: TickerPosition): string {
  const rawAccount = position.brokerAccountId || position.portfolio;
  const isBrokerPortfolio = rawAccount.startsWith("broker:");
  const account = isBrokerPortfolio
    ? rawAccount.split(":").filter(Boolean).at(-1) || rawAccount
    : rawAccount;
  const prefix = !isBrokerPortfolio && position.broker && position.broker !== "manual" ? `${position.broker} ` : "";
  const suffix = signedPositionDirection(position) < 0 ? " SHORT" : "";
  return `${prefix}${account}${suffix}`;
}

export function buildOverviewStats({
  quote,
  fundamentals,
  quoteCurrency,
  baseCurrency,
  marketCapExchangeRates = new Map(),
  nextEarnings,
  depositaryReceipt = false,
  today,
}: {
  quote: Quote | undefined;
  fundamentals: TickerFinancials["fundamentals"] | undefined;
  quoteCurrency: string;
  baseCurrency: string;
  toBase: CurrencyConverter;
  marketCapExchangeRates?: ReadonlyMap<string, number>;
  nextEarnings?: NextEarnings;
  /** The share count is in depositary receipts, not ordinary shares. */
  depositaryReceipt?: boolean;
  /** The listing's calendar day, YYYY-MM-DD; dates before it are left out. */
  today?: string;
}): StatField[] {
  const stats: StatField[] = [];
  const money = (value: number, perShare = false) => formatReportedMoney(value, fundamentals?.financialCurrency, perShare);

  if (quote?.volume != null) {
    // Live figures keep their decimals (12.30M, not 12.3M) so the digits hold still.
    stats.push({ label: "Volume", value: formatCompact(quote.volume, { fixedDecimals: true }) });
  }
  // Price-derived statistics follow the quote; see live-valuation for when a stored figure is kept.
  const capitalization = liveMarketCapitalization(quote, fundamentals);
  if (capitalization) {
    const converted = convertMarketCapitalization(capitalization.value, capitalization.currency, baseCurrency, marketCapExchangeRates);
    stats.push({
      label: "Market Cap",
      value: formatCompactCurrency(
        converted ?? capitalization.value,
        converted == null ? capitalization.currency : baseCurrency,
        { fixedDecimals: true },
      ),
    });
  }
  if (fundamentals?.sharesOutstanding) {
    stats.push({
      label: "Shares Out",
      value: formatCompact(fundamentals.sharesOutstanding),
      ...(depositaryReceipt ? { detail: ["ADR equivalent", "in ADRs"] } : {}),
    });
  }
  if (finite(fundamentals?.floatShares) && fundamentals.floatShares > 0) {
    stats.push({ label: "Float", value: formatCompact(fundamentals.floatShares) });
  }
  const trailingPE = liveTrailingPE(quote, fundamentals);
  if (trailingPE != null) {
    stats.push({ label: "P/E (TTM)", value: formatPriceEarnings(trailingPE) });
  }
  const forwardPE = liveForwardPE(quote, fundamentals);
  if (forwardPE != null) {
    stats.push({ label: "Fwd P/E", value: formatPriceEarnings(forwardPE) });
  }
  if (fundamentals?.eps != null) {
    stats.push({ label: "EPS", value: money(fundamentals.eps, true) });
  }
  if (fundamentals?.pegRatio != null) {
    stats.push({ label: "PEG", value: formatPriceEarnings(fundamentals.pegRatio, 2) });
  }
  // A report the payload still lists after its day has passed is not the next one.
  if (today && nextEarnings && ISO_DATE.test(nextEarnings.date) && nextEarnings.date >= today) {
    const timing = nextEarnings.timing?.toUpperCase();
    stats.push({
      label: "Earnings",
      value: calendarDate(nextEarnings.date, today),
      detail: daysAhead(daysUntil(nextEarnings.date, today), timing),
      link: EARNINGS,
    });
  }
  const dividendYield = liveDividendYield(quote, fundamentals);
  if (fundamentals && dividendYield != null) {
    const label = fundamentals.dividendYieldBasis === "forward" ? "Fwd Div Yld" : fundamentals.dividendYieldBasis === "trailing" ? "TTM Div Yld" : "Div Yield";
    stats.push({ label, value: formatLevelPercent(dividendYield) });
  }
  const exDividendDate = fundamentals?.exDividendDate;
  if (exDividendDate && ISO_DATE.test(exDividendDate)) {
    const days = today ? daysUntil(exDividendDate, today) : -1;
    stats.push({
      label: "Ex-Dividend",
      value: calendarDate(exDividendDate, today ?? exDividendDate),
      detail: days >= 0 ? daysAhead(days) : undefined,
      link: DIVIDENDS,
    });
  }
  if (fundamentals?.revenue != null) {
    stats.push({ label: "Revenue", value: money(fundamentals.revenue) });
  }
  if (fundamentals?.netIncome != null) {
    stats.push({ label: "Net Income", value: money(fundamentals.netIncome) });
  }
  if (fundamentals?.freeCashFlow != null) {
    stats.push({ label: "FCF", value: money(fundamentals.freeCashFlow) });
  }
  if (fundamentals?.operatingMargin != null) {
    stats.push({ label: "Op Margin", value: formatLevelPercent(fundamentals.operatingMargin) });
  }
  if (fundamentals?.profitMargin != null) {
    stats.push({ label: "Profit Marg", value: formatLevelPercent(fundamentals.profitMargin) });
  }
  if (fundamentals?.revenueGrowth != null) {
    stats.push({
      label: "Rev Growth",
      value: formatPercent(fundamentals.revenueGrowth),
      valueColor: priceColor(fundamentals.revenueGrowth),
    });
  }
  if (fundamentals?.unavailableFields?.includes("enterpriseValue")) {
    stats.push({ label: "EV", value: "—" });
  } else if (fundamentals?.enterpriseValue != null) {
    stats.push({ label: "EV", value: formatCompactCurrency(fundamentals.enterpriseValue, quoteCurrency) });
  }
  if (finite(fundamentals?.beta)) {
    stats.push({ label: "Beta", value: formatNumber(fundamentals.beta, 2), link: RELATIONSHIP_GRAPH });
  }
  if (finite(fundamentals?.shortPercentOfFloat)) {
    stats.push({
      label: "Short Float",
      value: formatLevelPercent(fundamentals.shortPercentOfFloat),
      detail: finite(fundamentals.shortRatio) ? `${formatNumber(fundamentals.shortRatio, 1)}d to cover` : undefined,
      link: SHORT_INTEREST,
    });
  }
  if (finite(fundamentals?.institutionPercentHeld)) {
    stats.push({ label: "Inst Own", value: formatLevelPercent(fundamentals.institutionPercentHeld), link: HOLDERS });
  }
  if (finite(fundamentals?.insiderPercentHeld)) {
    stats.push({ label: "Insider Own", value: formatLevelPercent(fundamentals.insiderPercentHeld), link: HOLDERS });
  }

  return stats;
}

/** Who the company is: instrument type, classification, head count, site and identifiers. */
export function buildProfileFields({
  instrumentType,
  sector,
  industry,
  profile,
  isin,
}: {
  instrumentType?: string;
  sector?: string;
  industry?: string;
  profile?: CompanyProfile;
  isin?: string;
}): StatField[] {
  const fields: StatField[] = [];
  if (instrumentType) fields.push({ label: "Type", value: instrumentType });
  if (sector) fields.push({ label: "Sector", value: sector });
  if (industry) fields.push({ label: "Industry", value: industry });
  if (finite(profile?.employees) && profile.employees > 0) {
    fields.push({ label: "Employees", value: formatNumber(profile.employees, 0) });
  }
  const fiscalMonth = MONTHS[Number(/^(\d{2})-\d{2}$/.exec(profile?.fiscalYearEnd ?? "")?.[1]) - 1];
  if (fiscalMonth) fields.push({ label: "FY End", value: fiscalMonth });
  if (profile?.sic) fields.push({ label: "SIC", value: profile.sic, detail: profile.sicDescription, clipDetail: true });
  const website = profile?.website ? safeExternalUrl(profile.website) : null;
  if (website) {
    fields.push({ label: "Website", value: new URL(website).hostname.replace(/^www\./, ""), url: website });
  }
  if (isin) fields.push({ label: "ISIN", value: isin });
  return fields;
}

export function buildPositionRows({
  ticker,
  quote,
  quoteCurrency,
  baseCurrency,
  toBase,
}: {
  ticker: TickerRecord;
  quote: Quote | undefined;
  quoteCurrency: string;
  baseCurrency: string;
  toBase: CurrencyConverter;
}): PositionTableRow[] {
  return ticker.metadata.positions.filter((position) => position.shares !== 0).map((position) => {
    const positionCurrency = getPortfolioPositionMetrics(
      { ...ticker, metadata: { ...ticker.metadata, positions: [position] } }, undefined, quoteCurrency, undefined, quote,
    ).positionCurrency;
    const metrics = getPortfolioPositionMetrics(
      { ...ticker, metadata: { ...ticker.metadata, positions: [position] } },
      undefined,
      quoteCurrency,
      { currency: baseCurrency, convert: toBase },
      quote,
    );
    const activeQuote = getPortfolioQuoteDisplay(metrics, quote);
    const currentPrice = activeQuote?.price ?? null;
    const finiteValue = (value: number | null): number | null => value != null && Number.isFinite(value) ? value : null;
    const costBasisBase = finiteValue(metrics.totalCost);
    const hasBrokerMark = metrics.brokerMarkPrice != null && Number.isFinite(metrics.brokerMarkPrice);
    const fallbackMarkPrice = currentPrice ?? (hasBrokerMark ? position.markPrice : undefined);
    const fallbackMarkCurrency = currentPrice != null ? quoteCurrency : positionCurrency;
    const marketValueBase = resolvePortfolioMarketValue(metrics, currentPrice != null ? toBase(currentPrice, quoteCurrency) : null)?.gross ?? null;
    const selectedPnl = resolvePortfolioPositionPnl(metrics,
      currentPrice != null ? toBase(currentPrice, quoteCurrency) : null);
    const pnlValue = selectedPnl.value;
    const percent = portfolioPnlPercent(pnlValue, costBasisBase != null ? Math.abs(costBasisBase) : Number.NaN);
    const returnPercent = percent === null ? "—" : formatPercentRaw(percent);
    const unit = metrics.priceBasis === "percent-of-par" ? "" : ticker.metadata.assetCategory === "BOND" ? " units" : metrics.multiplierHint > 1 ? " ct" : " sh";

    return {
      account: compactPositionAccount(position),
      qty: `${formatMarketQuantity(metrics.totalShares, { assetCategory: ticker.metadata.assetCategory, multiplier: position.multiplier, priceBasis: metrics.priceBasis, quantityCurrency: positionCurrency, maxWidth: metrics.priceBasis === "percent-of-par" ? 11 : undefined })}${unit}`,
      quantityUnit: metrics.priceBasis === "percent-of-par" ? "face" : undefined,
      // Avg and Mark sit side by side, so both keep the currency's minor unit ($118.40 beside $224.36).
      avg: formatMarketCostWithCurrency(position.avgCost, positionCurrency, withCurrencyMinorDigits({
        assetCategory: ticker.metadata.assetCategory,
        multiplier: position.multiplier,
        priceBasis: metrics.priceBasis,
        maxWidth: 9,
      }, positionCurrency)),
      mark: fallbackMarkPrice != null && Number.isFinite(fallbackMarkPrice)
        ? formatMarketPriceWithCurrency(fallbackMarkPrice, fallbackMarkCurrency, withCurrencyMinorDigits({
            assetCategory: ticker.metadata.assetCategory,
            multiplier: position.multiplier,
            priceBasis: currentPrice != null ? quote?.priceBasis : metrics.priceBasis,
            maxWidth: 9,
          }, fallbackMarkCurrency))
        : "—",
      cost: costBasisBase != null ? formatCurrency(costBasisBase, baseCurrency) : "—",
      value: marketValueBase != null ? formatCurrency(marketValueBase, baseCurrency) : "—",
      pnl: pnlValue != null ? `${pnlValue >= 0 ? "+" : ""}${formatCurrency(pnlValue, baseCurrency)}` : "—",
      ret: returnPercent,
      pnlValue,
      pnlBasis: selectedPnl.basis,
    };
  });
}

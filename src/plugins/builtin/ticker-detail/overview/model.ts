import { formatPriceEarnings } from "../../../../utils/price-earnings";
import { convertMarketCapitalization } from "../../../../utils/market-capitalization";
import { priceColor } from "../../../../theme/colors";
import type { CompanyProfile, NextEarnings, Quote, TickerFinancials } from "../../../../types/financials";
import type { Portfolio, TickerPosition, TickerRecord } from "../../../../types/ticker";
import type { BrokerInstanceConfig } from "../../../../types/config";
import type { BrokerAccount } from "../../../../types/trading";
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
import { reportedQuoteVolume } from "../../../../market-data/market/index-level";
import type { OverviewFunctionLink, PositionTableRow, StatField } from "./types";
import type { OverviewDividendState } from "./dividend";
import { NO_CURRENT_DIVIDEND } from "../../../../utils/forward-dividend";
import { getPortfolioPositionMetrics, getPortfolioQuoteDisplay, resolvePortfolioMarketValue, resolvePortfolioPositionPnl, portfolioPnlPercent, signedPositionDirection } from "../../../../portfolio/position-metrics";
import { listingDividendYield, liveForwardPE, liveMarketCapitalization, liveTrailingPE } from "../../../../market-data/quotes/live-valuation";
import { atRegularSessionPrice } from "../../../../market-data/quotes/regular-session-valuation";
import { formatReportedMoney } from "../../../../utils/reported-money";
import { enterpriseValueCheck, fundamentalsCurrency, fundamentalsEpsCurrency, reportedEnterpriseValue } from "../../../../utils/fundamentals";
import { formatShortDate } from "../../../../utils/datetime-format";
import { safeExternalUrl } from "../../../../utils/external-url";
import type { FundBondFacts } from "../../../../api-client/fund-facts";
import { bondFigures } from "../../../../market-data/bond-funds";
import { formatRunwayMonths, type CashRunway, type RunwayEstimate } from "../../../../utils/cash-runway";

type CurrencyConverter = (value: number, fromCurrency: string) => number;

const RELATIONSHIP_GRAPH: OverviewFunctionLink = { name: "Relationship Graph", templateId: "relationship-graph-pane" };
const HOLDERS: OverviewFunctionLink = { name: "Holders", tabId: "holders", templateId: "holders-pane" };
const SHORT_INTEREST: OverviewFunctionLink = { name: "Short Interest", tabId: "short-interest", templateId: "short-interest-pane" };
const EARNINGS: OverviewFunctionLink = { name: "Earnings", templateId: "earnings-calendar-pane" };
const DIVIDENDS: OverviewFunctionLink = { name: "Dividends", tabId: "dividend-yield", templateId: "dividend-yield-pane" };
const FUND_FACTS: OverviewFunctionLink = { name: "Fund Facts", templateId: "sec-etf-pane" };
const FINANCIALS: OverviewFunctionLink = { name: "Financials", tabId: "financials", templateId: "financial-analysis-pane" };

/** A bond fund's sponsor figures in a narrow grid: `SEC Yield 4.04% 2026-10-15`. */
const BOND_STAT_LABELS = { secYield: "SEC Yield", yieldToWorst: "Yld to Worst" } as const;

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

/** What the Account column reads names from: the portfolios, the brokers' accounts and their profiles. */
export interface PositionAccountNames {
  portfolios: readonly Pick<Portfolio, "id" | "name" | "brokerAccountId" | "brokerInstanceId">[];
  /** Accounts each broker profile reported, by profile id. */
  brokerAccounts?: Readonly<Record<string, readonly Pick<BrokerAccount, "accountId" | "name">[]>>;
  brokerInstances?: readonly Pick<BrokerInstanceConfig, "id" | "label">[];
}

const NO_ACCOUNT_NAMES: PositionAccountNames = { portfolios: [] };

/**
 * The account a position is held in, by the name the Portfolio pane gives its
 * portfolio ("Aries individual (simulation)"), never the broker's raw account
 * id: a portfolio still named by its id takes the name the broker reports for
 * the account, then the broker profile's.
 */
function positionAccountName(position: TickerPosition, names: PositionAccountNames): string {
  const portfolio = names.portfolios.find((entry) => entry.id === position.portfolio);
  const brokerPortfolio = position.portfolio.startsWith("broker:");
  const accountId = position.brokerAccountId || portfolio?.brokerAccountId
    || (brokerPortfolio ? position.portfolio.split(":").slice(2).join(":") : "");
  const named = (name: string | undefined) => {
    const text = name?.trim();
    return text && text !== accountId && text !== position.portfolio ? text : null;
  };
  const portfolioName = named(portfolio?.name);
  if (portfolioName) return portfolioName;
  const instanceId = position.brokerInstanceId || portfolio?.brokerInstanceId;
  if (!accountId && !brokerPortfolio && !instanceId) return portfolio?.name.trim() || position.portfolio;
  const accounts = instanceId ? names.brokerAccounts?.[instanceId] ?? [] : [];
  const accountName = named(accounts.find((account) => account.accountId === accountId)?.name);
  if (accountName) return accountName;
  const profileName = named(names.brokerInstances?.find((instance) => instance.id === instanceId)?.label);
  return profileName ?? position.broker;
}

function positionAccountLabel(position: TickerPosition, names: PositionAccountNames): string {
  const suffix = signedPositionDirection(position) < 0 ? " SHORT" : "";
  return `${positionAccountName(position, names)}${suffix}`;
}

/** A runway measure as the grid reads it: `12.0 mo`, or `no burn`. */
function runwayText(estimate: RunwayEstimate): string {
  return estimate.kind === "no-burn" ? "no burn" : formatRunwayMonths(estimate.months, "mo");
}

/**
 * Months of cash for a company that burns it, at the latest quarter's burn
 * with the trailing year's after it and the balance sheet's date where it
 * fits (`12.0 mo qtr to 06-30 · TTM 14.4 mo`). It opens Financials, whose
 * Liquidity rows show the cash and the monthly burn. A company whose
 * trailing operating cash flow is nonnegative or unavailable has no row.
 */
function runwayStat(runway: CashRunway | null | undefined): StatField | null {
  if (runway?.trailing?.kind !== "months") return null;
  const { quarter, trailing, periodEnd } = runway;
  const dates = [periodEnd, periodEnd.slice(5)];
  if (!quarter) return { label: "Runway", value: runwayText(trailing), detail: [...dates.map((date) => `TTM to ${date}`), "TTM"], link: FINANCIALS };
  const ttm = ` · TTM ${runwayText(trailing)}`;
  return {
    label: "Runway",
    value: runwayText(quarter),
    // "12.0 mo TTM 14.4 mo" would read as one figure: a narrow column keeps "qtr" alone.
    detail: [...dates.map((date) => `qtr to ${date}${ttm}`), `qtr${ttm}`, "qtr"],
    link: FINANCIALS,
  };
}

export function buildOverviewStats({
  quote,
  fundamentals,
  financialCurrency,
  quoteCurrency,
  baseCurrency,
  marketCapExchangeRates = new Map(),
  nextEarnings,
  depositaryReceipt = false,
  today,
  dividend,
  bond = null,
  runway = null,
}: {
  quote: Quote | undefined;
  fundamentals: TickerFinancials["fundamentals"] | undefined;
  /** The currency the statements report in, for fundamentals that declare none. */
  financialCurrency?: TickerFinancials["financialCurrency"];
  quoteCurrency: string;
  baseCurrency: string;
  toBase: CurrencyConverter;
  marketCapExchangeRates?: ReadonlyMap<string, number>;
  nextEarnings?: NextEarnings;
  /** The share count is in depositary receipts, not ordinary shares. */
  depositaryReceipt?: boolean;
  /** The listing's calendar day, YYYY-MM-DD; dates before it are left out. */
  today?: string;
  /** The history the dividend yield reads (useOverviewDividend): a trailing one is measured from its cash, a forward one stops with it; without it the yield stands. */
  dividend?: OverviewDividendState;
  /**
   * A bond fund's SEC yield, yield to worst and duration: its yield is then a
   * distribution yield, not its SEC yield, which follows it with its date.
   */
  bond?: FundBondFacts | null;
  /** Months of cash at the latest balance sheet (utils/cash-runway); shown when the company burns cash. */
  runway?: CashRunway | null;
}): StatField[] {
  const stats: StatField[] = [];
  const money = (value: number, perShare = false) => formatReportedMoney(value, fundamentalsCurrency({ fundamentals, financialCurrency }), perShare);

  // An index's 0 is volume nobody counts, not a quiet session: no Volume row.
  const volume = reportedQuoteVolume(quote);
  if (volume != null) {
    // Live figures keep their decimals (12.30M, not 12.3M) so the digits hold still.
    stats.push({ label: "Volume", value: formatCompact(volume, { fixedDecimals: true }) });
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
    stats.push({ label: "EPS", value: formatReportedMoney(fundamentals.eps, fundamentalsEpsCurrency({ fundamentals, financialCurrency }), true) });
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
  // A trailing yield as DVD measures it from the cash history, once that is read.
  const dividendYield = listingDividendYield(quote, fundamentals, dividend?.actions);
  // A dividend that stopped has no forward yield, and its last ex-date is when it was last paid.
  const lapse = dividend?.lapse ?? null;
  // A bond fund pays distributions, and its yield on them is not the SEC yield after it.
  const kind = bond ? "Dist" : "Div";
  const notSec = bond ? { detail: ["not SEC yield", "not SEC"] } : {};
  if (fundamentals && lapse) {
    stats.push({ label: `Fwd ${kind} Yld`, value: NO_CURRENT_DIVIDEND });
  } else if (fundamentals && dividendYield != null && !dividend?.pending) {
    const basis = fundamentals.dividendYieldBasis;
    const label = basis === "forward" ? `Fwd ${kind} Yld` : basis === "trailing" ? `TTM ${kind} Yld` : `${kind} Yield`;
    stats.push({ label, value: formatLevelPercent(dividendYield), ...notSec });
  }
  if (bond) {
    // Each dated, as the sponsor publishes it; the narrowest column drops the year.
    for (const figure of bondFigures(bond)) {
      const label = figure.key === "duration" ? (bond.duration?.measure === "average" ? "Avg Duration" : "Eff Duration") : BOND_STAT_LABELS[figure.key];
      const forms = figure.date ? [...new Set([figure.date, figure.date.replace(/\b\d{4}-(\d{2}-\d{2})\b/, "$1")])] : undefined;
      stats.push({ label, value: figure.text, ...(forms ? { detail: forms } : {}), link: FUND_FACTS });
    }
  }
  const exDividendDate = lapse?.lastPaid ?? fundamentals?.exDividendDate;
  if (exDividendDate && ISO_DATE.test(exDividendDate)) {
    const days = today ? daysUntil(exDividendDate, today) : -1;
    stats.push({
      label: lapse ? "Last Paid" : "Ex-Dividend",
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
  const runwayField = runwayStat(runway);
  if (runwayField) stats.push(runwayField);
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
  // At the regular session price, as the market cap above it is, with the check moved beside it.
  const priced = atRegularSessionPrice({ quote, fundamentals }).fundamentals;
  const enterpriseValue = reportedEnterpriseValue(priced);
  if (fundamentals?.unavailableFields?.includes("enterpriseValue")) {
    stats.push({ label: "EV", value: "—" });
  } else if (enterpriseValue != null) {
    // More than 5% from market cap + debt - cash: the provider's, with the computed figure where it fits.
    const check = enterpriseValueCheck(priced);
    const computed = check?.status === "differs" && check.computed != null ? formatCompact(check.computed) : undefined;
    stats.push({
      label: "EV",
      value: formatCompactCurrency(enterpriseValue, quoteCurrency),
      detail: computed ? [`provider vs ${computed}`, "provider"] : undefined,
    });
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
  accountNames = NO_ACCOUNT_NAMES,
}: {
  ticker: TickerRecord;
  quote: Quote | undefined;
  quoteCurrency: string;
  baseCurrency: string;
  toBase: CurrencyConverter;
  accountNames?: PositionAccountNames;
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
      account: positionAccountLabel(position, accountNames),
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

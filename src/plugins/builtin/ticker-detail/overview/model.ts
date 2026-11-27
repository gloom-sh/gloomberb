import { forwardFiscalYear, forwardPEAsked, formatPriceEarnings, NOT_MEANINGFUL } from "../../../../utils/price-earnings";
import { formatDay } from "../../../../utils/day-format";
import { convertMarketCapitalization } from "../../../../utils/market-capitalization";
import { priceColor } from "../../../../theme/colors";
import { notMeaningfulColor } from "../../../../components/ui/not-meaningful";
import type { CryptoMarketAsset } from "../../../../api-client/crypto-markets";
import { NOT_MEANINGFUL_TEXT, revenueMargin } from "../../../../utils/growth";
import type { ServedRate } from "../../../../utils/served-rates";
import type { CedearRatio, CompanyProfile, DepositaryPair, NextEarnings, Quote, TickerFinancials } from "../../../../types/financials";
import { adrRatioText } from "../../../../utils/depositary-receipt";
import { cedearRatioText, premiumText, ratioCount } from "../../../../market-data/depositary-pair";
import { ADR_PAIR_TAB_ID, ADR_PAIR_TEMPLATE_ID } from "../adr-pair/model";
import { DEFAULT_RELATIONSHIP_RANGE, DEFAULT_RELATIONSHIP_SECOND_SYMBOL, relationshipBetaBasis, type RelationshipRegressionStats } from "../../correlation/relationship/model";
import { resolveTickerInstrumentKind } from "../../../../tickers/instrument-kind";
import type { Portfolio, TickerPosition, TickerRecord } from "../../../../types/ticker";
import type { BrokerInstanceConfig } from "../../../../types/config";
import type { BrokerAccount } from "../../../../types/trading";
import {
  MISSING_VALUE,
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
import { quoteVolumeCurrency, reportedQuoteVolume } from "../../../../market-data/market/index-level";
import { formatChartLegendValue } from "../../../../components/chart/composite/format";
import type { OverviewFunctionLink, PositionTableRow, StatField } from "./types";
import type { OverviewDividendState } from "./dividend";
import { lapseValue, UNEVEN_REGULAR_PAYMENTS } from "../../../../utils/forward-dividend";
import { getPortfolioPositionMetrics, getPortfolioQuoteDisplay, resolvePortfolioMarketValue, resolvePortfolioPositionPnl, portfolioPnlPercent, signedPositionDirection } from "../../../../portfolio/position-metrics";
import { listingDividendYield, liveForwardPE, liveTrailingPE } from "../../../../market-data/quotes/live-valuation";
import { atRegularSessionPrice, regularSessionMarketCapitalization } from "../../../../market-data/quotes/regular-session-valuation";
import { listingEnterpriseValue, type ListingEnterpriseValue } from "../../../../market-data/quotes/listing-enterprise-value";
import { formatReportedMoney, REPORTING_CURRENCY_NOT_SOURCED } from "../../../../utils/reported-money";
import { enterpriseValueCheck, enterpriseValueComputed, fundamentalsCurrency, financialEnterpriseValue, fundamentalsEpsCurrency } from "../../../../utils/fundamentals";
import { formatShortDate } from "../../../../utils/datetime-format";
import { safeExternalUrl } from "../../../../utils/external-url";
import type { FundBondFacts } from "../../../../api-client/fund-facts";
import { bondFigures } from "../../../../market-data/bond-funds";
import { quoteStatsBasisText } from "../../../../market-data/quotes/export-identity";
import { burnsCash, formatRunwayMonths, type CashRunway, type RunwayEstimate } from "../../../../utils/cash-runway";
import { listingOwnsRow, listingOwnsSeries } from "../../../../utils/statement-scope";
import { hasStatementGap } from "../../../../utils/statement-gaps";
import { financialStatementCurrency, selectFinancialStatements } from "../financials/model";

type CurrencyConverter = (value: number, fromCurrency: string) => number;

const RELATIONSHIP_GRAPH: OverviewFunctionLink = { name: "Relationship Graph", templateId: "relationship-graph-pane" };

// Require about 80% of a trading year for DES's 1Y label, allowing for unmatched holidays and missing sessions.
const MIN_OVERVIEW_BETA_RETURNS = 200;

export function overviewBetaRequest(ticker: TickerRecord, financials: TickerFinancials | null) {
  const kind = resolveTickerInstrumentKind(ticker, financials);
  const symbol = ticker.metadata.ticker;
  const benchmark = DEFAULT_RELATIONSHIP_SECOND_SYMBOL;
  return symbol !== benchmark && (kind === "equity" || kind === "fund")
    ? { pair: [symbol, benchmark] as [string, string], range: DEFAULT_RELATIONSHIP_RANGE }
    : null;
}

export function buildOverviewBeta(stats: Pick<RelationshipRegressionStats, "beta" | "sampleSize"> | null) {
  if (!stats || stats.sampleSize < MIN_OVERVIEW_BETA_RETURNS || !finite(stats.beta)) return null;
  return {
    label: "Beta", value: formatNumber(stats.beta, 3),
    detail: relationshipBetaBasis(DEFAULT_RELATIONSHIP_RANGE, DEFAULT_RELATIONSHIP_SECOND_SYMBOL),
    link: RELATIONSHIP_GRAPH,
  };
}
const HOLDERS: OverviewFunctionLink = { name: "Holders", tabId: "holders", templateId: "holders-pane" };
const SHORT_INTEREST: OverviewFunctionLink = { name: "Short Interest", tabId: "short-interest", templateId: "short-interest-pane" };
const EARNINGS: OverviewFunctionLink = { name: "Earnings", templateId: "earnings-calendar-pane" };
const DIVIDENDS: OverviewFunctionLink = { name: "Dividends", tabId: "dividend-yield", templateId: "dividend-yield-pane" };
const FUND_FACTS: OverviewFunctionLink = { name: "Fund Facts", templateId: "sec-etf-pane" };
/** The company's statements: Financials' first view in this pane, otherwise FA. */
export const FINANCIALS: OverviewFunctionLink = { name: "Financials", tabId: "financials", templateId: "financial-analysis-pane" };
const ADR_PAIR: OverviewFunctionLink = { name: "ADR vs Home", tabId: ADR_PAIR_TAB_ID, templateId: ADR_PAIR_TEMPLATE_ID };

/** A bond fund's sponsor figures in a narrow grid: `SEC Yield 4.04% 2026-10-15`. */
const BOND_STAT_LABELS = { secYield: "SEC Yield", yieldToWorst: "Yld to Worst" } as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const finite = (value: number | undefined): value is number => value != null && Number.isFinite(value);

/** Whole calendar days from `today` to `date`, both YYYY-MM-DD. */
function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** "10 Sep", or "12 Dec '25" in another year. */
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
  if (!burnsCash(runway)) return null;
  const { periodEnd } = runway;
  const quarter = runway.quarter?.kind === "months" ? runway.quarter : null;
  const trailing = runway.trailing?.kind === "months" ? runway.trailing : null;
  const dates = [formatDay(periodEnd), formatDay(periodEnd, "no-year")];
  if (!quarter) return trailing ? { label: "Runway", value: runwayText(trailing), detail: [...dates.map((date) => `TTM to ${date}`), "TTM"], link: FINANCIALS } : null;
  const ttm = trailing ? ` · TTM ${runwayText(trailing)}` : "";
  return {
    label: "Runway",
    value: runwayText(quarter),
    // "12.0 mo TTM 14.4 mo" would read as one figure: a narrow column keeps "qtr" alone.
    detail: [...dates.map((date) => `qtr to ${date}${ttm}`), `qtr${ttm}`, "qtr"],
    link: FINANCIALS,
  };
}

type OverviewStatements = Pick<TickerFinancials, "annualStatements" | "quarterlyStatements" | "financialCurrency" | "statementScope" | "trailingStatement">;

function overviewTrailingIncome(statements: OverviewStatements, fundamentals: TickerFinancials["fundamentals"], currency: string | undefined) {
  const { statements: [trailing] } = selectFinancialStatements("annual", "income", statements.annualStatements,
    statements.quarterlyStatements, 1, statements.trailingStatement);
  const end = trailing?.aggregation?.periodEnd;
  if (!end || !trailing) return {};
  if (!listingOwnsSeries(statements) || trailing.aggregation?.kind === "annual-plus-interim" && !listingOwnsRow(statements.statementScope, trailing)) {
    return { difference: ["Different scope from Financials", "Different scope"] };
  }
  const summaryEnd = fundamentals?.trailingPeriodEnd;
  if (summaryEnd && summaryEnd !== end) {
    return { difference: ["Different period from Financials", "Different period"] };
  }
  if (!summaryEnd && statements.quarterlyStatements.some((quarter) => quarter.date > end)) {
    return { difference: ["Overview period unverified", "Period unverified"] };
  }
  const reportingCurrency = financialStatementCurrency(statements, [trailing])?.trim();
  if (!currency || !reportingCurrency || currency !== reportingCurrency || fundamentals?.ttmConversion) {
    return { difference: ["Different currency basis from Financials", "Currency basis differs"] };
  }
  const { totalRevenue, netIncome, operatingIncome } = trailing;
  if (!finite(totalRevenue) || !finite(netIncome) || hasStatementGap(trailing, "totalRevenue") || hasStatementGap(trailing, "netIncome")) {
    return { difference: ["Financials TTM income incomplete", "Incomplete TTM"] };
  }
  return { income: { end, revenue: totalRevenue, netIncome, profitMargin: revenueMargin(netIncome, totalRevenue),
    operatingMargin: hasStatementGap(trailing, "operatingIncome") ? undefined : revenueMargin(operatingIncome, totalRevenue) } };
}

export function buildOverviewStats({
  quote,
  fundamentals,
  coin,
  financialCurrency,
  statementFinancials,
  quoteCurrency,
  baseCurrency,
  marketCapExchangeRates = new Map(),
  enterpriseValue = listingEnterpriseValue({ quote, fundamentals, profile: undefined }),
  nextEarnings,
  depositaryReceipt = false,
  depositaryPair = null,
  ahPair = null,
  cedearRatio = null,
  boardLot = null,
  today,
  dividend,
  bond = null,
  runway = null,
  trailingEpsYear,
  notMeaningful = {},
}: {
  quote: Quote | undefined;
  fundamentals: TickerFinancials["fundamentals"] | undefined;
  coin?: CryptoMarketAsset | null;
  /** The currency the statements report in, for fundamentals that declare none on a listing that trades in it. */
  financialCurrency?: TickerFinancials["financialCurrency"];
  statementFinancials?: OverviewStatements | null;
  quoteCurrency: string;
  baseCurrency: string;
  toBase: CurrencyConverter;
  marketCapExchangeRates?: ReadonlyMap<string, number>;
  enterpriseValue?: ListingEnterpriseValue;
  nextEarnings?: NextEarnings;
  /** The share count is in depositary receipts, not ordinary shares. */
  depositaryReceipt?: boolean;
  /** The receipt pair the listing is a side of, as Gloom Cloud serves it; `receiptSide` when the listing is the receipt. */
  depositaryPair?: { pair: DepositaryPair; receiptSide: boolean } | null;
  /**
   * An A+H company's other line (`useAhPair`): the A share on the H line's DES, the H share on the A line's, with
   * the H price over the A price at spot. The row opens that line's DES.
   */
  ahPair?: { other: string; side: "h" | "a"; premiumPercent: number | null } | null;
  /** A Buenos Aires CEDEAR's ratio in its company's shares, as Gloom Cloud serves it. */
  cedearRatio?: CedearRatio | null;
  /** The shares one lot of the listing trades in, as its exchange states it (an HKEX or SGX line). */
  boardLot?: number | null;
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
  /** The fiscal year the trailing EPS is ("FY Mar-26"), when it is a year's a quarter or more old (trailingEpsFiscalYear). */
  trailingEpsYear?: string;
  /** Why a served margin or revenue growth is N/M (servedRatesNotMeaningful): read N/M, as RV and `ticker` read it. */
  notMeaningful?: Partial<Record<ServedRate, string>>;
}): StatField[] {
  const stats: StatField[] = [];
  // Amounts no source names the currency of are bare; the first says so after it, once for all of them.
  let unsourcedSaid = false;
  const reported = (value: number, currency: string | undefined, perShare = false): Pick<StatField, "value" | "detail"> => {
    const text = formatReportedMoney(value, currency, perShare);
    if (currency?.trim() || unsourcedSaid || !Number.isFinite(value)) return { value: text };
    unsourcedSaid = true;
    return { value: text, detail: [REPORTING_CURRENCY_NOT_SOURCED, "currency not sourced"] };
  };
  const incomeCurrency = fundamentalsCurrency({ fundamentals, financialCurrency, quote });
  const money = (value: number) => reported(value, incomeCurrency);

  // An index's 0 is volume nobody counts, not a quiet session: no Volume row.
  const quoteVolume = reportedQuoteVolume(quote);
  const volume = quoteVolume ?? coin?.volume24h;
  if (volume != null) {
    // Live figures keep their decimals (12.30M, not 12.3M) so the digits hold still.
    // A coin's volume is the value it traded in its quote currency, written as the chart's volume reads ($47.94B),
    // and the composite's or one exchange's own day, said beside it as its range's is.
    const basis = quoteVolume == null ? "24h" : quoteStatsBasisText(quote, false);
    const currency = quoteVolume == null ? "USD" : quoteVolumeCurrency(quote);
    const value = currency ? formatChartLegendValue(volume, currency, "volume") : formatCompact(volume, { fixedDecimals: true });
    stats.push({ label: "Volume", value, ...(basis ? { detail: basis } : {}) });
  }
  // Price-derived statistics follow the quote; see live-valuation for when a stored figure is kept.
  // Market cap and EV read in the currency they are reported in, as the revenue and income beside them do, with
  // the base currency's figure after them where it differs and a rate is held: 19.46T JPY 123.05B USD.
  const inBase = (value: number, currency: string) => {
    if (currency === baseCurrency) return undefined;
    const converted = convertMarketCapitalization(value, currency, baseCurrency, marketCapExchangeRates);
    return converted == null ? undefined : formatCompactCurrency(converted, baseCurrency, { fixedDecimals: true });
  };
  const capitalization = regularSessionMarketCapitalization({ quote, fundamentals })
    ?? (coin?.marketCap == null ? null : { value: coin.marketCap, currency: "USD" });
  if (capitalization) {
    stats.push({
      label: "Market Cap",
      value: formatCompactCurrency(capitalization.value, capitalization.currency, { fixedDecimals: true }),
      detail: inBase(capitalization.value, capitalization.currency),
    });
  }
  if (coin?.circulatingSupply != null) stats.push({ label: "Circ Supply", value: formatCompact(coin.circulatingSupply) });
  if (coin?.maxSupply != null) stats.push({ label: "Max Supply", value: formatCompact(coin.maxSupply) });
  if (coin) stats.push({ label: "Rank", value: `#${coin.rank}`, detail: coin.kind === "stablecoin" ? "stablecoins" : ["by market cap", "mkt cap"] });
  // A count read off a 10-K or 10-Q cover says when it was counted; the source's own is undated.
  const counted = (asOf: string | undefined) => (asOf ? { detail: [`as of ${formatDay(asOf)}`, `as of ${formatDay(asOf, "no-year")}`] } : {});
  if (fundamentals?.sharesOutstanding) {
    stats.push({
      label: "Shares Out",
      value: formatCompact(fundamentals.sharesOutstanding),
      ...(depositaryReceipt ? { detail: ["ADR equivalent", "in ADRs"] } : counted(fundamentals.sharesOutstandingAsOf)),
    });
  }
  if (finite(fundamentals?.floatShares) && fundamentals.floatShares > 0) {
    stats.push({ label: "Float", value: formatCompact(fundamentals.floatShares), ...counted(fundamentals.floatSharesAsOf) });
  }
  // The shares one lot trades in, which an order on the venue is sized by.
  if (boardLot != null && Number.isSafeInteger(boardLot) && boardLot > 0) {
    stats.push({ label: "Board Lot", value: boardLot.toLocaleString("en-US"), detail: ["shares", "sh"] });
  }
  // A receipt says how many shares it holds and a home line which receipt holds it, both opening ADR vs Home.
  if (depositaryPair) {
    const { pair, receiptSide } = depositaryPair;
    const count = ratioCount(pair.ratio);
    stats.push(receiptSide
      ? { label: "ADR Ratio", value: `1:${count}`, detail: [adrRatioText(pair.ratio, pair.ordinary[0])!, `${count} sh per ADR`], link: ADR_PAIR }
      : { label: "ADR", value: pair.receipt, detail: [`1 ADR = ${count} of these shares`, `1:${count}`], link: ADR_PAIR });
  }
  // An A+H company's other line, and the H price over the A price at spot, as ADR vs Home shows them; the row opens that line.
  if (ahPair) {
    const premium = ahPair.premiumPercent == null ? null : premiumText(ahPair.premiumPercent);
    stats.push({
      label: ahPair.side === "h" ? "A Share" : "H Share",
      value: ahPair.other,
      ...(premium ? { detail: [`H ${premium} at spot`, `H ${premium.replace(/ (?:premium|discount|at par)$/, "")}`] } : {}),
      opens: ahPair.other,
    });
  }
  if (cedearRatio) {
    const receipts = ratioCount(cedearRatio.receipts);
    const shares = ratioCount(cedearRatio.shares);
    stats.push({ label: "CEDEAR Ratio", value: `${receipts}:${shares}`, detail: [cedearRatioText(cedearRatio), `${receipts} per ${shares} sh`] });
  }
  const trailingPE = liveTrailingPE(quote, fundamentals);
  if (trailingPE != null) {
    stats.push({ label: trailingEpsYear ? `P/E ${trailingEpsYear}` : "P/E (TTM)", value: formatPriceEarnings(trailingPE) });
  }
  // Next fiscal year's consensus, and the year it is for: N/M over a loss, a dash when there is none.
  const forwardPE = liveForwardPE(quote, fundamentals);
  if (forwardPE != null || forwardPEAsked(fundamentals)) {
    const year = forwardFiscalYear(fundamentals?.forwardEpsPeriodEnd);
    stats.push({ label: year ? `Fwd P/E ${year}` : "Fwd P/E", value: formatPriceEarnings(forwardPE) });
  }
  if (fundamentals?.eps != null) {
    stats.push({ label: trailingEpsYear ? `EPS ${trailingEpsYear}` : "EPS", ...reported(fundamentals.eps, fundamentalsEpsCurrency({ fundamentals, financialCurrency, quote }), true) });
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
    // A monthly payer's history that ends early (MUB's at 2026-09-01) says so, beside the last ex-date it holds.
    stats.push({ label: `Fwd ${kind} Yld`, value: lapseValue(lapse) });
  } else if (fundamentals && dividendYield != null && !dividend?.pending) {
    const basis = fundamentals.dividendYieldBasis;
    const label = basis === "forward" ? `Fwd ${kind} Yld` : basis === "trailing" ? `TTM ${kind} Yld` : `${kind} Yield`;
    // A forward yield over the year's uneven regular payments (HSBC's interims beside its final) says so, as DVD does.
    const uneven = basis === "forward" && fundamentals.dividendRateBasis === "uneven-regular-payments"
      ? { detail: [UNEVEN_REGULAR_PAYMENTS, "uneven interims"] } : {};
    stats.push({ label, value: formatLevelPercent(dividendYield), ...notSec, ...uneven });
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
      label: lapse ? (lapse.historyEnds ? "Last Ex" : "Last Paid") : "Ex-Dividend",
      value: calendarDate(exDividendDate, today ?? exDividendDate),
      detail: days >= 0 ? daysAhead(days) : undefined,
      link: DIVIDENDS,
    });
  }
  const { income, difference } = statementFinancials ? overviewTrailingIncome(statementFinancials, fundamentals, incomeCurrency) : {};
  const revenueValue = income?.revenue ?? fundamentals?.revenue;
  const netIncome = income?.netIncome ?? fundamentals?.netIncome;
  if (revenueValue != null) {
    // Which twelve months the revenue, net income and margin are, as Financials' TTM column names them.
    const end = income?.end ?? fundamentals?.trailingPeriodEnd;
    const revenue = money(revenueValue);
    const through = end && ISO_DATE.test(end) && !revenue.detail ? [formatDay(end), formatDay(end, "no-year")] : null;
    stats.push({ label: "Revenue", ...revenue, ...(through ? { detail: [`TTM to ${through[0]}`, ...through.map((day) => `to ${day}`)] } : {}) });
  }
  if (netIncome != null) {
    const net = money(netIncome);
    stats.push({ label: "Net Income", ...net, ...(!net.detail && difference ? { detail: difference } : {}) });
  }
  if (fundamentals?.freeCashFlow != null) {
    const currency = (fundamentals.freeCashFlowCurrency === undefined ? fundamentals.financialCurrency : fundamentals.freeCashFlowCurrency)?.trim();
    stats.push({ label: "FCF", value: formatReportedMoney(fundamentals.freeCashFlow, currency),
      ...(!currency && Number.isFinite(fundamentals.freeCashFlow) ? { detail: ["currency unknown"] } : {}) });
  }
  const runwayField = runwayStat(runway);
  if (runwayField) stats.push(runwayField);
  // A margin over revenue at or below zero, and growth off it, read N/M in N/M's own colour, never a sign's.
  const notMeaningfulStat = (label: string): StatField => ({ label, value: NOT_MEANINGFUL_TEXT, valueColor: notMeaningfulColor() });
  const margin = (label: string, value: number | typeof NOT_MEANINGFUL | undefined, key: "operatingMargin" | "profitMargin") => {
    if (value == null) return;
    stats.push(value === NOT_MEANINGFUL || (!income && notMeaningful[key]) ? notMeaningfulStat(label)
      : { label, value: formatLevelPercent(value) });
  };
  margin("Op Margin", income ? income.operatingMargin : fundamentals?.operatingMargin, "operatingMargin");
  margin("Profit Marg", income ? income.profitMargin : fundamentals?.profitMargin, "profitMargin");
  if (fundamentals?.revenueGrowth != null) {
    stats.push(notMeaningful.revenueGrowth ? notMeaningfulStat("Rev Growth") : {
      label: "Rev Growth",
      value: formatPercent(fundamentals.revenueGrowth),
      valueColor: priceColor(fundamentals.revenueGrowth),
    });
  }
  // At the regular session price, as the market cap above it is, with the check moved beside it.
  const priced = atRegularSessionPrice({ quote, fundamentals }).fundamentals;
  // At or below zero, N/M as a P/E over a loss reads, with why in the space a stat has; valuation gives the full reason.
  if (enterpriseValue.kind === "not-meaningful") {
    // A bank's deposits and an insurer's float are funding, not debt (withFinancialEnterpriseValue);
    // any other's cash exceeds the rest.
    const financial = financialEnterpriseValue(priced);
    stats.push({ label: "EV", value: formatPriceEarnings(NOT_MEANINGFUL),
      detail: financial ? financial.replace(/^n\/m /, "") : ["cash > cap + debt", "cash > cap"] });
  } else if (enterpriseValue.kind === "value") {
    // Market cap + debt - cash (+ minority interest) where the provider's is more than 5% from it, as every view
    // shows it; the notice under the pane gives its inputs where the provider's is far off (enterpriseValueGapIsLarge).
    const check = enterpriseValueCheck(priced);
    const minority = (check?.minorityAndPreferred ?? 0) > 0 ? " + minority" : "";
    const leases = enterpriseValue.bridge?.leases ?? check?.leases ?? 0;
    const computedDetail = leases > 0 ? "computed" : [`cap + debt - cash${minority}`, "computed"];
    stats.push({
      label: "EV",
      value: formatCompactCurrency(enterpriseValue.value, enterpriseValue.currency),
      // An insurer's: its investment book is not netted as cash. How it was reached comes before the base figure.
      detail: enterpriseValue.basis === "computed" || enterpriseValueComputed(priced)
        ? computedDetail
        : check?.investmentsKept ? ["investments in", "inv. in"] : inBase(enterpriseValue.value, enterpriseValue.currency),
    });
  } else if (fundamentals?.unavailableFields?.includes("enterpriseValue")) {
    stats.push({ label: "EV", value: MISSING_VALUE });
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
    const returnPercent = percent === null ? MISSING_VALUE : formatPercentRaw(percent);
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
        : MISSING_VALUE,
      cost: costBasisBase != null ? formatCurrency(costBasisBase, baseCurrency) : MISSING_VALUE,
      value: marketValueBase != null ? formatCurrency(marketValueBase, baseCurrency) : MISSING_VALUE,
      pnl: pnlValue != null ? `${pnlValue >= 0 ? "+" : ""}${formatCurrency(pnlValue, baseCurrency)}` : MISSING_VALUE,
      ret: returnPercent,
      pnlValue,
      pnlBasis: selectedPnl.basis,
    };
  });
}

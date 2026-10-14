import type { PriceBasis } from "./instrument";

export type MarketState = "PRE" | "REGULAR" | "POST" | "PREPRE" | "POSTPOST" | "CLOSED";
export type SessionConfidence = "explicit" | "derived" | "unknown";
export type QuoteDataSource = "live" | "delayed" | "snapshot";
export type QuoteDelivery = "stream" | "poll";

/**
 * The regular sessions an index quote carries, dated by its source: the
 * calendar its publisher's name does not give (SNP, DJI, NASDAQ GIDS). Times
 * are ms.
 */
export interface QuoteIndexSession {
  /** The zone the sessions' dates are read in. */
  timeZone: string;
  /** The regular session the quote's day follows: today's, or the next one while it has not opened. */
  current: { start: number; end: number };
  /** The latest regular sessions, oldest first. */
  regular: Array<{ start: number; end: number }>;
}

export interface QuoteFieldProvenance {
  providerId: string;
  dataSource?: QuoteDataSource;
}

export interface QuoteProvenance {
  price?: QuoteFieldProvenance;
  session?: QuoteFieldProvenance;
  listing?: QuoteFieldProvenance;
  routing?: QuoteFieldProvenance;
  descriptive?: QuoteFieldProvenance;
  fields?: Record<string, QuoteFieldProvenance>;
  rejectedPriceProviders?: string[];
}

/** Static listing facts from a quote observation, without an investable price. */
export interface QuoteMetadataSource {
  providerId?: string;
  lastUpdated?: number;
  stale?: boolean;
  provenance?: QuoteProvenance;
}

export interface QuoteMetadata {
  symbol: string;
  currency?: string;
  instrumentType?: string;
  listingExchangeName?: string;
  source: QuoteMetadataSource;
  /** Overrides only when a missing field was supplied by another observation. */
  fieldSources?: Partial<Record<"currency" | "instrumentType", QuoteMetadataSource>>;
}

/**
 * What a record's share counts count: depositary receipts or the ordinary
 * shares behind them. Gloom Cloud states it only when it established it.
 */
export type ShareBasis = "depositary_receipt" | "ordinary";

/** How a depositary receipt relates to the ordinary shares, as Gloom Cloud states it. */
interface DepositaryReceiptFacts {
  /** Whether the listing is a depositary receipt; absent when unknown. */
  isDepositaryReceipt?: boolean;
  /** Ordinary shares per receipt, on a receipt's own records. */
  adrRatio?: number;
}

export interface Quote extends DepositaryReceiptFacts {
  /** Applies to this price observation; a stored position cannot supply it. */
  priceBasis?: PriceBasis;
  /** Daily fund net asset value; independent of the units used to format its price. */
  priceObservation?: "nav";
  symbol: string;
  /** Provider-reported security type, independent of the company profile. */
  instrumentType?: string;
  providerId?: string;
  price: number;
  currency: string;
  /** Source units per `currency` unit when the venue quotes a sub-unit, such as 100 for a London line in pence. */
  providerPriceDivisor?: number;
  change: number;
  changePercent: number;
  previousClose?: number;
  /** Official close of a completed regular session, in this quote's currency. */
  regularClose?: number;
  /** Exchange-local date of regularClose; separate from the daily previous-close reference. */
  regularCloseSessionDate?: string;
  /** Move of that completed regular session from the one before it, in this quote's currency; set and cleared together with regularClose. */
  regularChange?: number;
  regularChangePercent?: number;
  /** Provider's exchange-local session date for the daily quote reference. */
  changeSessionDate?: string;
  high52w?: number;
  low52w?: number;
  marketCap?: number;
  volume?: number;
  name?: string;
  lastUpdated: number; // timestamp ms
  receivedAt?: number; // local receipt timestamp ms for streamed/display freshness
  delivery?: QuoteDelivery;
  stale?: boolean;
  exchangeName?: string;
  fullExchangeName?: string;
  listingExchangeName?: string;
  listingExchangeFullName?: string;
  /**
   * The board whose line priced the quote, when Gloom Cloud read another one
   * than the listing asked for: a KOSDAQ code saved as 247540:KRX is quoted
   * from KOSDAQ and still named KRX in the listing fields (quoteTradingExchange).
   */
  tradingExchangeName?: string;
  routingExchangeName?: string;
  routingExchangeFullName?: string;
  marketState?: MarketState;
  sessionConfidence?: SessionConfidence;
  /** An index's own regular sessions, for the open its pre-market waits for and the close its last print was. */
  indexSession?: QuoteIndexSession;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
  postMarketPrice?: number;
  postMarketChange?: number;
  postMarketChangePercent?: number;
  /**
   * Whether the quote holds a trade from the pre-market or after-hours
   * session in progress (marketState PRE or POST). False when nothing has
   * traded in it yet: the extended fields, or the price, are then the regular
   * price carried forward, and their flat move is no move. Absent in the other
   * sessions and when the source does not say.
   */
  extendedSessionPrint?: boolean;
  /**
   * The overnight session's price (a US listing trading 20:00 to 04:00 New
   * York, Sunday night to Friday morning, while its exchange is closed): set
   * only while that session is in progress and `price` is an observation from
   * it, beside the closed exchange's marketState. Like an after-hours print,
   * the quote keeps the last regular session's close, move and range.
   */
  overnightPrice?: number;
  /** overnightPrice against the completed regular session's close, as postMarketChange is. */
  overnightChange?: number;
  overnightChangePercent?: number;
  /** A trade printed in the session, or the midpoint of its bid and ask while nothing has traded in it. */
  overnightPriceKind?: "trade" | "mark";
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  open?: number;
  high?: number;
  low?: number;
  mark?: number;
  /** Executed trade, separate from a midpoint or indicative mark. */
  lastTradePrice?: number;
  /** Timestamp of that trade in milliseconds. */
  lastTradeTime?: number;
  provenance?: QuoteProvenance;
  /** Freshness class for the quote data. Provider identity lives in providerId/provenance. */
  dataSource?: QuoteDataSource;
}

export interface QuoteContribution extends Quote {
  providerId: string;
}

export type QuoteContributionMap = Record<string, QuoteContribution>;

/** How a fundamentals block's trailing figures were converted from the currency the company reports in. */
export interface TtmConversion {
  /** The reporting currency the figures were converted from. */
  from: string;
  /** Units of `financialCurrency` per unit of `from` for revenue, income and cash flow; absent when not measured. */
  rate?: number;
  /** YYYY-MM-DD the converted figures were fetched. */
  asOf?: string;
  /** EPS is converted at the rate of each report date, so a P/E on it divides a spot price by EPS at older rates. */
  eps?: "report_date";
}

/**
 * How a served enterprise value ties to market cap + total debt - cash from the latest balance sheet served beside it.
 * `matches` within 5%; `differs` beyond it (or beyond 2% on the other side of the market cap from net debt), within
 * 0.7x to 1.5x, shown labelled as the provider's; `withdrawn` outside that band, with no EV or EV/revenue; `unchecked`
 * without a recent balance sheet carrying both lines.
 */
export interface EnterpriseValueCheck {
  status: "matches" | "differs" | "withdrawn" | "unchecked";
  /** The provider's enterprise value, served as `enterpriseValue` unless withdrawn. */
  source: number;
  currency: string;
  marketCap: number;
  totalDebt?: number;
  cash?: number;
  /** YYYY-MM-DD of the balance sheet the debt and cash come from. */
  balanceSheetDate?: string;
  /** marketCap + totalDebt - cash. */
  computed?: number;
}

/** How a trailing P/E converts the EPS it divides by, when that EPS is in another currency than the price. */
export interface TrailingPEConversion {
  /** The currency of the trailing EPS. */
  from: string;
  /** Units of the quote's (major) currency per unit of `from`. */
  rate: number;
}

export interface Fundamentals extends DepositaryReceiptFacts {
  /** Every share count here is on this basis, the basis of the listing's price and market cap; absent when unproven. */
  shareBasis?: ShareBasis;
  /** On a receipt, the ordinary shares behind `sharesOutstanding`. */
  underlyingOrdinaryShares?: number;
  source?: "gloom";
  fetchedAt?: string;
  stale?: boolean;
  /** Currency of the trailing revenue, income, cash flows and EPS (EPS unless `epsCurrency` says otherwise); may differ from the listing and the statements. */
  financialCurrency?: string;
  /** Set when the trailing figures were converted from the reporting currency into `financialCurrency`. */
  ttmConversion?: TtmConversion;
  /** Set when the trailing EPS is in another currency than `financialCurrency`: the listing's, converted from the reporting currency at each report date's rate. */
  epsCurrency?: string;
  /** Set when `trailingPE` divides the price by the trailing EPS converted from another currency. */
  trailingPEConversion?: TrailingPEConversion;
  /** Provider-reported issuer market cap; marketCapCurrency identifies its units when known. */
  marketCap?: number;
  marketCapCurrency?: string;
  trailingPE?: number;
  forwardPE?: number;
  /**
   * Forward EPS behind `forwardPE`, per share in the listing's major currency
   * unit. Served only when its basis matches the multiple, so the multiple can
   * be repriced from a live quote; absent otherwise.
   */
  forwardEps?: number;
  pegRatio?: number;
  enterpriseValue?: number;
  enterpriseToRevenue?: number;
  /** Set where Gloom Cloud checked `enterpriseValue` against market cap + total debt - cash; pairs with that value only. */
  enterpriseValueCheck?: EnterpriseValueCheck;
  /** Explicit provider retractions; omitted fields alone remain eligible for fallback. */
  unavailableFields?: Array<"enterpriseValue" | "enterpriseToRevenue">;
  operatingCashFlow?: number;
  freeCashFlow?: number;
  dividendYield?: number;
  dividendYieldBasis?: "forward" | "trailing";
  dividendYieldSource?: "gloom";
  /**
   * Annual dividend per share behind `dividendYield`, in the listing's major
   * currency unit. Served only when its basis matches the yield, so the yield
   * can be repriced from a live quote; absent otherwise.
   */
  dividendRate?: number;
  revenue?: number;
  netIncome?: number;
  eps?: number;
  operatingMargin?: number;
  profitMargin?: number;
  revenueGrowth?: number;
  return1Y?: number;
  return3Y?: number;
  lastQuarterGrowth?: number;
  sharesOutstanding?: number;
  /** Free float: shares outstanding less insider and strategic holdings, never above `sharesOutstanding`. */
  floatShares?: number;
  beta?: number;
  /** Shares short at the latest FINRA settlement, the one `SI` and `SIW` show; dated by `shortInterestDate`. */
  sharesShort?: number;
  /** `sharesShort` over `floatShares`, as a fraction (0.0127 for 1.27%). */
  shortPercentOfFloat?: number;
  /** Days to cover as FINRA states it for the settlement: shares short over the period's average daily volume. */
  shortRatio?: number;
  /** The settlement date (YYYY-MM-DD) of `sharesShort`, `shortPercentOfFloat` and `shortRatio`. */
  shortInterestDate?: string;
  /** Fractions of shares outstanding. */
  insiderPercentHeld?: number;
  institutionPercentHeld?: number;
  /** The latest ex-dividend date (YYYY-MM-DD) while the dividend is being paid. */
  exDividendDate?: string;
}

type HolderOwnerType = "institution" | "fund" | "direct" | "insider";

export interface HolderRecord {
  providerId?: string;
  ownerType: HolderOwnerType;
  name: string;
  reportDate?: string;
  shares?: number;
  value?: number;
  percentHeld?: number;
  changeShares?: number;
  changePercent?: number;
  /** Set when the position's filing ties it to the receipts or to the ordinary shares. */
  shareBasis?: ShareBasis;
}

interface HolderSummary {
  insidersPercentHeld?: number;
  institutionsPercentHeld?: number;
  institutionsFloatPercentHeld?: number;
  institutionsCount?: number;
}

export interface HolderData extends DepositaryReceiptFacts {
  providerId?: string;
  symbol: string;
  name?: string;
  /** The listing's price currency. */
  currency?: string;
  /** The currency of `value`, which can differ from the listing's (USD on a London line priced from 13F filings). */
  valueCurrency?: string;
  /** Reported shares times the latest price, or times the price at the report date. */
  valueBasis?: "latest_price" | "period_end_price";
  /** Set when every row is on one basis. */
  shareBasis?: ShareBasis;
  exchange?: string;
  asOf?: string;
  summary?: HolderSummary;
  holders: HolderRecord[];
}

interface AnalystPriceTarget {
  high?: number;
  median?: number;
  low?: number;
  average?: number;
  current?: number;
  currency?: string;
}

interface AnalystRecommendationTrend {
  period: string;
  strongBuy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strongSell?: number;
}

export interface AnalystRatingRecord {
  date: string;
  firm: string;
  action?: string;
  current?: string;
  prior?: string;
  currentPriceTarget?: number;
  priorPriceTarget?: number;
}

export interface AnalystEstimateRecord {
  date: string;
  period: string;
  /** Explicit currency for these estimates; independent of the listing currency. */
  currency?: string;
  analysts?: number;
  average?: number;
  low?: number;
  high?: number;
  yearAgo?: number;
  growth?: number;
}

export interface AnalystResearchData {
  providerId?: string;
  fetchedAt?: string;
  stale?: boolean;
  symbol: string;
  name?: string;
  currency?: string;
  exchange?: string;
  micCode?: string;
  exchangeTimezone?: string;
  priceTarget?: AnalystPriceTarget;
  recommendationRating?: number;
  recommendations: AnalystRecommendationTrend[];
  ratings: AnalystRatingRecord[];
  earningsEstimates: AnalystEstimateRecord[];
  revenueEstimates: AnalystEstimateRecord[];
}

export interface DividendAction {
  exDate: string;
  amount: number;
}

/**
 * A distribution the issuer has declared and not yet paid, as the source
 * states it. Kept apart from the paid `dividends`: no history, yield or growth
 * figure takes it.
 */
export interface DeclaredDividendAction {
  exDate: string;
  /** Per share, in the listing's dividend currency (`currency`). */
  amount: number;
  declarationDate?: string;
  recordDate?: string;
  payDate?: string;
}

export interface SplitAction {
  date: string;
  description?: string;
  /** Provider adjustment ratio; may represent a split or a spinoff price adjustment, not verified share terms. */
  ratio?: number;
  /** Denominator of the provider adjustment factor. */
  fromFactor?: number;
  /** Numerator of the provider adjustment factor. */
  toFactor?: number;
}

/**
 * How a reported EPS relates to the company's statements: `gaap` is the
 * quarter's diluted EPS as the statements report it; `adjusted` is the
 * consensus-basis figure, which leaves out items the statements include.
 */
export type EarningsEpsBasis = "gaap" | "adjusted";

/** A report that is out, a date the company announced, or a date projected from its past reports. */
export type EarningsDateStatus = "reported" | "confirmed" | "projected";

export interface EarningsAction {
  date: string;
  dateType?: "announcement" | "fiscal-period-end";
  currency?: string;
  time?: string;
  epsEstimate?: number;
  epsActual?: number;
  difference?: number;
  surprisePercent?: number;
  /** Fiscal quarter end month, YYYY-MM, when the report's quarter is known. */
  fiscalPeriod?: string;
  /** Analysts behind `epsEstimate`, when known. */
  epsAnalysts?: number;
  /** Null when the basis cannot be determined; absent from sources that do not say. */
  epsBasis?: EarningsEpsBasis | null;
  dateStatus?: EarningsDateStatus;
}

export interface CorporateActionsData {
  providerId?: string;
  fetchedAt?: string;
  stale?: boolean;
  coverage?: Partial<Record<"dividends" | "splits" | "earnings", "available" | "unavailable">>;
  symbol: string;
  name?: string;
  currency?: string;
  exchange?: string;
  micCode?: string;
  exchangeTimezone?: string;
  dividends: DividendAction[];
  /** Declared and unpaid, for the listings Gloom Cloud has them for; absent elsewhere and from older servers. */
  declaredDividends?: DeclaredDividendAction[];
  splits: SplitAction[];
  earnings: EarningsAction[];
}

export interface CompanyProfile {
  description?: string;
  sector?: string;
  industry?: string;
  employees?: number;
  website?: string;
  /** SEC Standard Industrial Classification, four digits (US filers). */
  sic?: string;
  sicDescription?: string;
  /** Fiscal year end as MM-DD (US filers). */
  fiscalYearEnd?: string;
}

/** A company's next report from the earnings calendar. */
export interface NextEarnings {
  date: string;
  /** Before the open, during market hours, after the close. */
  timing: "bmo" | "dmh" | "amc" | null;
  /** "history" when the timing is predicted from the last two reports. */
  timingSource: "filing" | "calendar" | "history" | null;
}

export type IncomeStatementField = "netIncome" | "netIncomeIncludingNoncontrollingInterests" | "netIncomeCommonStockholders";

export interface IncomeStatementSource {
  source: "sec";
  concept: string;
  accessionNumber?: string;
  filed?: string;
  startDate?: string;
  endDate: string;
  unit: string;
  basis: "parent" | "consolidated" | "common";
}

/**
 * Statement lines a source can declare unavailable for one period. A declared
 * gap survives merges and caches, and charts never recompute it, for example
 * as the full year minus the other quarters.
 */
export type StatementGapField = IncomeStatementField | "totalRevenue" | "operatingRevenue" | "pretaxIncome" | "taxProvision";

/** Per-share earnings lines that can be declared unavailable. */
export type EarningsField = "basicEps" | "eps";

/** @deprecated Operating results no longer carry filing or provider provenance. */
export type ReportedOperatingField = "grossProfit" | "operatingExpense" | "operatingIncome";
/** @deprecated Operating results no longer carry filing or provider provenance. */
export type ProviderOperatingField = ReportedOperatingField | "totalExpenses" | "ebitda";

/** @deprecated No longer populated. Operating income follows the provider's as-reported figure. */
export interface ReportedOperatingCohort {
  cik: string;
  period: "annual" | "quarterly";
  startDate: string;
  endDate: string;
  currency: "USD";
  accessionNumber: string;
  filed: string;
  form: string;
  values: Record<ReportedOperatingField, number>;
  anchors?: { totalRevenue?: number; costOfRevenue?: number };
  origin: { kind: "companyfacts" } | {
    kind: "filing-table";
    documentUrl: string;
    documentSha256: string;
    table: "summary-quarterly-results";
    unitScale: 1000000;
  };
}

/** @deprecated No longer populated. */
export interface ProviderOperatingObservation {
  provider: "gloom";
  sourceField: string;
  period: "annual" | "quarterly";
  endDate: string;
  currency: string;
  value: number;
}

/** @deprecated No longer populated. */
export interface OperatingResult {
  version: 1;
  reported?: ReportedOperatingCohort;
  provider?: Partial<Record<ProviderOperatingField, ProviderOperatingObservation>>;
  derived?: { ebitda?: DerivedOperatingObservation };
}

/** @deprecated No longer populated. */
export interface DerivedOperatingObservation {
  definition: "operating-income-plus-depreciation-amortization";
  period: "annual" | "quarterly";
  endDate: string;
  currency: string;
  value: number;
  inputs: { operatingIncome: number; depreciationAndAmortization: number };
}

/** @deprecated No longer populated. */
export interface OperatingResultAggregation {
  kind: "trailing-four-quarters";
  sourcePeriods: Array<Pick<FinancialStatement, "date" | "currency" | "operatingResult" | "depreciationAndAmortization" | ProviderOperatingField>>;
  unavailableFields: ProviderOperatingField[];
}

/** @deprecated No longer populated. EPS that disagrees with its row's income and shares is listed in `unavailableEarnings` instead. */
export interface ReportedEarningsCohort {
  cik: string;
  basis: "us-gaap";
  shareBasis: "ordinary";
  period: "annual";
  startDate: string;
  endDate: string;
  currency: "EUR";
  accessionNumber: string;
  filed: string;
  form: "20-F" | "20-F/A";
  values: Record<EarningsField, number>;
  anchors: Record<"netIncome" | "totalRevenue" | "operatingIncome" | "basicShares" | "dilutedShares", number> & { grossProfit?: number };
  concepts: Record<EarningsField | "netIncome" | "totalRevenue" | "operatingIncome" | "basicShares" | "dilutedShares", { concept: string; unit: string }>
    & { grossProfit?: { concept: string; unit: string } };
}

/** @deprecated No longer populated. */
export interface EarningsResultProvenance { version: 1; reported: ReportedEarningsCohort }

export interface FinancialStatement {
  /** The basis of this row's share counts and per-share earnings; absent when unproven. */
  shareBasis?: ShareBasis;
  /** @deprecated No longer populated. */
  earningsResult?: EarningsResultProvenance;
  /** EPS lines unavailable for this period, for example because they disagree with the row's own income and shares. */
  unavailableEarnings?: EarningsField[];
  /** @deprecated No longer populated. */
  operatingResult?: OperatingResult;
  /** @deprecated No longer populated. */
  operatingResultAggregation?: OperatingResultAggregation;
  /**
   * @deprecated No longer populated. Gloom Cloud withdrawal ids are read into
   * `unavailableFields` and `unavailableEarnings` when a response arrives.
   */
  withdrawnObservations?: string[];
  /** SEC EPS share basis; raw source values remain available in the evidence. */
  epsBasis?: import("../utils/sec-eps-basis").SecEpsBasis;
  date: string;
  /** Source of the fiscal period date; does not establish metric publication dates. */
  dateSource?: "sec" | "provider";
  /** Original vendor period date when independent filing evidence changes it. */
  providerDate?: string;
  /** Filing evidence for the period identity only, not availability of every field. */
  dateEvidence?: {
    accessionNumber: string;
    filed: string;
    startDate: string;
  };
  /** Reporting currency for monetary statement fields (per-share values use reported shares). */
  currency?: string;
  /** Earliest date on which the complete row was publicly available, when known. */
  availableAt?: string;
  /** Per-field publication dates used by point-in-time charts and calculations. */
  fieldAvailability?: Record<string, string>;
  /** Income attribution belongs to each field, not to the row's date evidence. */
  fieldSources?: Partial<Record<IncomeStatementField, IncomeStatementSource>>;
  /** Lines unavailable for this period; another source or income basis must not fill them. */
  unavailableFields?: StatementGapField[];
  // Income Statement
  totalRevenue?: number;
  costOfRevenue?: number;
  grossProfit?: number;
  sellingGeneralAndAdministration?: number;
  researchAndDevelopment?: number;
  operatingExpense?: number;
  operatingIncome?: number;
  operatingRevenue?: number;
  totalExpenses?: number;
  pretaxIncome?: number;
  normalizedIncome?: number;
  netIncomeCommonStockholders?: number;
  netIncomeContinuousOperations?: number;
  otherIncomeExpense?: number;
  otherNonOperatingIncomeExpenses?: number;
  depreciationAmortizationDepletionIncomeStatement?: number;
  depreciationAndAmortizationInIncomeStatement?: number;
  interestExpense?: number;
  taxProvision?: number;
  netIncome?: number;
  netIncomeIncludingNoncontrollingInterests?: number;
  ebitda?: number;
  basicEps?: number;
  eps?: number; // diluted
  basicShares?: number;
  dilutedShares?: number;
  // Cash Flow
  operatingCashFlow?: number;
  depreciationAndAmortization?: number;
  depreciationAmortizationDepletion?: number;
  depreciation?: number;
  deferredIncomeTax?: number;
  deferredTax?: number;
  stockBasedCompensation?: number;
  otherNonCashItems?: number;
  changeInWorkingCapital?: number;
  changeInReceivables?: number;
  changeInInventory?: number;
  changeInPayable?: number;
  changeInAccountPayable?: number;
  changeInOtherWorkingCapital?: number;
  capitalExpenditure?: number;
  cashFlowFromContinuingOperatingActivities?: number;
  interestPaidSupplementalData?: number;
  incomeTaxPaidSupplementalData?: number;
  purchaseOfPPE?: number;
  saleOfPPE?: number;
  netPPEPurchaseAndSale?: number;
  freeCashFlow?: number;
  investingCashFlow?: number;
  cashFlowFromContinuingInvestingActivities?: number;
  purchaseOfBusiness?: number;
  saleOfBusiness?: number;
  netBusinessPurchaseAndSale?: number;
  purchaseOfInvestment?: number;
  saleOfInvestment?: number;
  netInvestmentPurchaseAndSale?: number;
  netOtherInvestingChanges?: number;
  financingCashFlow?: number;
  cashFlowFromContinuingFinancingActivities?: number;
  issuanceOfDebt?: number;
  repaymentOfDebt?: number;
  netIssuancePaymentsOfDebt?: number;
  longTermDebtIssuance?: number;
  longTermDebtPayments?: number;
  netLongTermDebtIssuance?: number;
  shortTermDebtIssuance?: number;
  shortTermDebtPayments?: number;
  netShortTermDebtIssuance?: number;
  repurchaseOfCapitalStock?: number;
  commonStockIssuance?: number;
  commonStockPayments?: number;
  netCommonStockIssuance?: number;
  cashDividendsPaid?: number;
  commonStockDividendPaid?: number;
  netOtherFinancingCharges?: number;
  beginningCashPosition?: number;
  endCashPosition?: number;
  changesInCash?: number;
  effectOfExchangeRateChanges?: number;
  // Balance Sheet
  totalAssets?: number;
  currentAssets?: number;
  cashAndCashEquivalents?: number;
  cashCashEquivalentsAndShortTermInvestments?: number;
  otherShortTermInvestments?: number;
  receivables?: number;
  accountsReceivable?: number;
  inventory?: number;
  prepaidAssets?: number;
  otherCurrentAssets?: number;
  totalNonCurrentAssets?: number;
  netPPE?: number;
  grossPPE?: number;
  accumulatedDepreciation?: number;
  goodwill?: number;
  otherIntangibleAssets?: number;
  goodwillAndOtherIntangibleAssets?: number;
  investmentsAndAdvances?: number;
  otherNonCurrentAssets?: number;
  totalLiabilities?: number;
  currentLiabilities?: number;
  currentDebt?: number;
  currentDebtAndCapitalLeaseObligation?: number;
  payablesAndAccruedExpenses?: number;
  currentAccruedExpenses?: number;
  payables?: number;
  accountsPayable?: number;
  currentDeferredRevenue?: number;
  currentDeferredLiabilities?: number;
  otherCurrentLiabilities?: number;
  totalNonCurrentLiabilities?: number;
  longTermDebt?: number;
  longTermDebtAndCapitalLeaseObligation?: number;
  longTermCapitalLeaseObligation?: number;
  nonCurrentDeferredLiabilities?: number;
  nonCurrentDeferredTaxesLiabilities?: number;
  otherNonCurrentLiabilities?: number;
  totalDebt?: number;
  capitalLeaseObligations?: number;
  totalCapitalization?: number;
  totalEquity?: number;
  totalEquityGrossMinorityInterest?: number;
  commonStockEquity?: number;
  commonStock?: number;
  capitalStock?: number;
  additionalPaidInCapital?: number;
  treasuryStock?: number;
  gainsLossesNotAffectingRetainedEarnings?: number;
  otherEquityAdjustments?: number;
  retainedEarnings?: number;
  longTermEquityInvestment?: number;
  workingCapital?: number;
  netTangibleAssets?: number;
  investedCapital?: number;
  tangibleBookValue?: number;
  shareIssued?: number;
  ordinarySharesNumber?: number;
  treasurySharesNumber?: number;
}

/**
 * Provider identity once attached to individual observations.
 * @deprecated No longer populated. A source's coverage boundary is the
 * `coverageStart` of the result `getPriceHistoryWithMetadata` and its
 * siblings return.
 */
export interface PriceHistorySource {
  provider: string;
  symbol: string;
  exchange: string;
  currency: string;
  /** Source coverage restriction, not security inception or an adjustment ratio. */
  verifiedLineageStart?: string;
}

export interface PricePoint {
  /** @deprecated No longer populated; read the history result's `coverageStart` instead. */
  historySource?: PriceHistorySource;
  date: Date;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
  /** The bar's period had not ended when it was served: its close is the latest price, and it may have no volume yet. */
  partial?: boolean;
  /** The bar's prices were rebuilt from shorter bars where the source left it empty or too coarse. */
  filled?: boolean;
}

export interface StatementHistoryAttempt {
  mode: "extended";
  source: "sec";
  status: "available" | "unsupported" | "retryable-failure";
  fetchedAt: string;
  attemptedAt?: string;
  cik?: string;
  reason?: string;
}

/** Consensus EPS for one reported quarter as it stood at the report. */
export interface ReportedEpsEstimate {
  /** Announcement date. A row without an actual is an upcoming report. */
  date: string;
  epsEstimate?: number;
  epsActual?: number;
}

export type ConsensusPeriod = "current quarter" | "next quarter" | "current year" | "next year";

/** Today's consensus for a period still open. */
export interface ConsensusEpsEstimate {
  period: ConsensusPeriod | string;
  /** Fiscal period end. */
  date: string;
  average?: number;
  analysts?: number;
  currency?: string;
}

/** One day's observation of the consensus for a period, recorded by the cloud. */
export interface ConsensusEpsSnapshot {
  observedOn: string;
  period: ConsensusPeriod | string;
  periodEnd?: string;
  epsAverage?: number;
  analysts?: number;
  source: string;
}

/**
 * The inputs behind a forward multiple history. Providers only serve today's
 * consensus, so the past is the pre-report consensus per quarter plus whatever
 * the cloud has recorded day by day since it started observing the listing.
 */
export interface EpsEstimateHistory {
  fetchedAt?: string;
  currency?: string;
  reported: ReportedEpsEstimate[];
  consensus: ConsensusEpsEstimate[];
  snapshots: ConsensusEpsSnapshot[];
}

export interface TickerFinancials {
  statementHistory?: StatementHistoryAttempt;
  /** @deprecated No longer populated. */
  operatingHistoryRetryAt?: number;
  /** @deprecated No longer populated. */
  earningsHistoryRetryAt?: number;
  financialCurrency?: string;
  quote?: Quote;
  quoteMetadata?: QuoteMetadata;
  quoteContributions?: QuoteContributionMap;
  fundamentals?: Fundamentals;
  profile?: CompanyProfile;
  nextEarnings?: NextEarnings;
  annualStatements: FinancialStatement[];
  quarterlyStatements: FinancialStatement[];
  priceHistory: PricePoint[];
  /** Acquired history cadence. Null explicitly marks an opaque provider default; absent on legacy snapshots. */
  priceHistoryResolution?: import("../time-series/resolution").ManualChartResolution | null;
  /** Stable original acquisition identity, used to replay distinct opaque history windows. */
  priceHistoryRequestKey?: string;
  priceHistorySession?: import("./price-history").HistorySession;
  priceHistorySourceKey?: string;
  /** Present on extended statement history from the cloud. */
  epsEstimates?: EpsEstimateHistory;
}

export interface OptionContract {
  contractSymbol: string;
  strike: number;
  currency: string;
  lastPrice: number;
  change: number;
  percentChange: number;
  /** Missing activity is unknown; an explicitly reported zero remains zero. */
  volume?: number;
  openInterest?: number;
  bid: number;
  ask: number;
  impliedVolatility: number;
  inTheMoney: boolean;
  expiration: number;
  lastTradeDate: number;
  /** Millisecond timestamp for the latest streamed quote applied to this snapshot. */
  lastUpdated?: number;
}

export interface OptionsChain {
  underlyingSymbol: string;
  expirationDates: number[];
  calls: OptionContract[];
  puts: OptionContract[];
  providerId?: string;
  dataSource?: "live" | "delayed";
  feed?: "opra" | "gloom";
  delayMinutes?: number;
  realtimeEligible?: boolean;
  /** ISO timestamp for the upstream options snapshot. */
  asOf?: string;
  /**
   * The session the chain's open interest counts, YYYY-MM-DD, as Gloom Cloud
   * states it; null when none of its counts is dated. Absent from a source
   * that does not say (an older server, another provider).
   */
  openInterestAsOf?: string | null;
}

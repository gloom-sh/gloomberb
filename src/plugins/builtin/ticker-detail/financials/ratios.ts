import { createValuationCurrencyContext } from "../../../../time-series/valuation-currency";
import type { FinancialStatement, PricePoint, TickerFinancials } from "../../../../types/financials";
import { formatNumber, pickUnit } from "../../../../utils/format";
import { pricePointIntegrity } from "../../../../utils/price-history-integrity";
import { formatPerShareNumber } from "../../../../utils/reported-money";
import { hasStatementGap } from "../../../../utils/statement-gaps";
import {
  buildPreviousStatementMap,
  type FinancialPeriod,
  type FinancialTableStatement,
} from "./aggregation";
import {
  FINANCIAL_SUB_TABS,
  resolveFinancialSubTabKey,
  selectFinancialStatements,
  type FinancialSubTab,
} from "./model";

/**
 * Why a ratio or one of its inputs has no number: a line the statements do
 * not carry for the period, a ratio whose denominator makes it meaningless
 * (a loss under P/E, negative equity under ROE), no close at the period end,
 * or a close still loading.
 */
export type RatioGap = "not-reported" | "not-meaningful" | "no-price" | "loading";
export type RatioAmount = number | RatioGap;

export const RATIO_GAP_TEXT: Record<RatioGap, string> = {
  "not-reported": "not reported",
  "not-meaningful": "N/M",
  "no-price": "no price",
  loading: "--",
};

export type RatioFormat = "percent" | "multiple" | "days";
export type RatioInputFormat = "money" | "perShare" | "days";

/** One column of a ratio tab: a period's statement and what its ratios also need. */
export interface RatioPeriod {
  statement: FinancialTableStatement;
  /** The balance sheet at the start of the period, for averages. */
  opening: FinancialStatement | undefined;
  /** Flows cover one quarter and are annualized. */
  quarterly: boolean;
  /** The close at the period end in the statement's currency. */
  price: RatioAmount;
}

interface RatioInputDef {
  label: string;
  /** How the input joins the formula: `÷`, `+` or `−`. The first input has none. */
  operator?: "÷" | "+" | "−";
  format: RatioInputFormat;
  /** A flow over the period. Quarterly columns multiply it by four. */
  annualized?: boolean;
  value: (period: RatioPeriod) => RatioAmount;
}

export interface RatioDef {
  id: string;
  label: string;
  format: RatioFormat;
  /** The sign carries meaning (a loss, a negative return), so the value takes the sign colour. */
  signed?: boolean;
  inputs: RatioInputDef[];
  /** From the inputs after annualization. */
  compute: (values: number[]) => RatioAmount;
}

export interface RatioTabDef {
  name: string;
  key: string;
  ratios: RatioDef[];
}

export interface RatioCell {
  value: RatioAmount;
  /** Each input as reported for the period, before annualization. */
  inputs: RatioAmount[];
}

const QUARTERS_PER_YEAR = 4;
const DAYS_PER_YEAR = 365;
/** A close more than this many days before the period end is not its price. */
const MAX_PRICE_LAG_DAYS = 7;

const isGap = (amount: RatioAmount): amount is RatioGap => typeof amount === "string";
const finite = (value: unknown): number | undefined => (
  typeof value === "number" && Number.isFinite(value) ? value : undefined
);
const reported = (value: number | undefined): RatioAmount => value ?? "not-reported";

/** A ratio over a positive denominator; anything else is not meaningful. */
const over = (numerator: number, denominator: number): RatioAmount => (
  denominator > 0 ? numerator / denominator : "not-meaningful"
);

type BalanceLine = (statement: FinancialStatement) => number | undefined;

const line = (...keys: (keyof FinancialStatement)[]): BalanceLine => (statement) => {
  for (const key of keys) {
    const value = finite(statement[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

/**
 * The mean of the opening and closing balance. Both ends must come from the
 * same definition, so a line is only used when both statements carry it.
 */
const average = (...lines: BalanceLine[]) => ({ statement, opening }: RatioPeriod): RatioAmount => {
  if (!opening) return "not-reported";
  for (const read of lines) {
    const close = read(statement);
    const open = read(opening);
    if (close !== undefined && open !== undefined) return (close + open) / 2;
  }
  return "not-reported";
};

const closing = (read: BalanceLine) => ({ statement }: RatioPeriod): RatioAmount => reported(read(statement));

const equity = line("totalEquity", "commonStockEquity");
const cashAndShortTerm = line("cashCashEquivalentsAndShortTermInvestments", "cashAndCashEquivalents");
const receivables = line("accountsReceivable", "receivables");
/** Total debt plus equity, the definition of reported invested capital. */
const debtPlusEquity: BalanceLine = (statement) => {
  const debt = finite(statement.totalDebt);
  const common = equity(statement);
  return debt !== undefined && common !== undefined ? debt + common : undefined;
};
const freeCashFlow: BalanceLine = (statement) => {
  const reportedFlow = finite(statement.freeCashFlow);
  if (reportedFlow !== undefined) return reportedFlow;
  const operating = finite(statement.operatingCashFlow);
  const capex = finite(statement.capitalExpenditure);
  return operating !== undefined && capex !== undefined ? operating + capex : undefined;
};

const periodDays = (period: RatioPeriod) => (period.quarterly ? DAYS_PER_YEAR / QUARTERS_PER_YEAR : DAYS_PER_YEAR);

const flow = (label: string, read: BalanceLine, operator?: RatioInputDef["operator"]): RatioInputDef => ({
  label, operator, format: "money", annualized: true, value: ({ statement }) => reported(read(statement)),
});

const perDay = (label: string, read: BalanceLine): RatioInputDef => ({
  label,
  operator: "÷",
  format: "money",
  value: (period) => {
    const value = read(period.statement);
    return value === undefined ? "not-reported" : value / periodDays(period);
  },
});

const netIncome = flow("Net Income", line("netIncome"));
const revenue = line("totalRevenue");
const costOfRevenue = line("costOfRevenue");

/** Operating income after tax at the period's effective rate; a pretax loss pays no tax. */
function nopat({ statement }: RatioPeriod): RatioAmount {
  const operating = finite(statement.operatingIncome);
  const tax = finite(statement.taxProvision);
  const pretax = finite(statement.pretaxIncome);
  if (operating === undefined || tax === undefined || pretax === undefined) return "not-reported";
  const rate = pretax > 0 ? Math.min(1, Math.max(0, tax / pretax)) : 0;
  return operating * (1 - rate);
}

function dilutedEps({ statement }: RatioPeriod): RatioAmount {
  if (hasStatementGap(statement, "eps") || statement.epsBasis?.status === "unresolved") return "not-reported";
  return reported(finite(statement.eps));
}

/** Period-end close times period-end shares outstanding, never weighted-average shares. */
function marketCap(period: RatioPeriod): RatioAmount {
  const shares = finite(period.statement.ordinarySharesNumber);
  if (shares === undefined) return "not-reported";
  if (isGap(period.price)) return period.price;
  return period.price * shares;
}

function enterpriseValue(period: RatioPeriod): RatioAmount {
  const debt = finite(period.statement.totalDebt);
  const cash = cashAndShortTerm(period.statement);
  if (debt === undefined || cash === undefined) return "not-reported";
  const cap = marketCap(period);
  return isGap(cap) ? cap : cap + debt - cash;
}

const DSO: RatioDef = {
  id: "dso",
  label: "DSO (days)",
  format: "days",
  inputs: [
    { label: "Avg Receivables", format: "money", value: average(line("accountsReceivable"), line("receivables")) },
    perDay("Revenue per Day", revenue),
  ],
  compute: ([balance, daily]) => over(balance!, daily!),
};
const DIO: RatioDef = {
  id: "dio",
  label: "DIO (days)",
  format: "days",
  inputs: [
    { label: "Avg Inventory", format: "money", value: average(line("inventory")) },
    perDay("COGS per Day", costOfRevenue),
  ],
  compute: ([balance, daily]) => over(balance!, daily!),
};
const DPO: RatioDef = {
  id: "dpo",
  label: "DPO (days)",
  format: "days",
  inputs: [
    { label: "Avg Payables", format: "money", value: average(line("accountsPayable"), line("payables")) },
    perDay("COGS per Day", costOfRevenue),
  ],
  compute: ([balance, daily]) => over(balance!, daily!),
};

const dayCount = (label: string, def: RatioDef, operator?: RatioInputDef["operator"]): RatioInputDef => ({
  label, operator, format: "days", value: (period) => evaluateRatio(def, period).value,
});

export const RATIO_TABS: RatioTabDef[] = [
  {
    name: "Profitability",
    key: "profitability",
    ratios: [
      {
        id: "roe",
        label: "ROE",
        format: "percent",
        signed: true,
        inputs: [netIncome, { label: "Avg Equity", operator: "÷", format: "money", value: average(line("totalEquity"), line("commonStockEquity")) }],
        compute: ([income, base]) => over(income!, base!),
      },
      {
        id: "roa",
        label: "ROA",
        format: "percent",
        signed: true,
        inputs: [netIncome, { label: "Avg Total Assets", operator: "÷", format: "money", value: average(line("totalAssets")) }],
        compute: ([income, base]) => over(income!, base!),
      },
      {
        id: "roic",
        label: "ROIC",
        format: "percent",
        signed: true,
        inputs: [
          { label: "NOPAT", format: "money", annualized: true, value: nopat },
          { label: "Avg Invested Capital", operator: "÷", format: "money", value: average(line("investedCapital"), debtPlusEquity) },
        ],
        compute: ([income, base]) => over(income!, base!),
      },
      {
        id: "gross-margin",
        label: "Gross Margin",
        format: "percent",
        signed: true,
        inputs: [flow("Gross Profit", line("grossProfit")), flow("Revenue", revenue, "÷")],
        compute: ([profit, sales]) => over(profit!, sales!),
      },
      {
        id: "operating-margin",
        label: "Operating Margin",
        format: "percent",
        signed: true,
        inputs: [flow("Operating Income", line("operatingIncome")), flow("Revenue", revenue, "÷")],
        compute: ([profit, sales]) => over(profit!, sales!),
      },
      {
        id: "net-margin",
        label: "Net Margin",
        format: "percent",
        signed: true,
        inputs: [netIncome, flow("Revenue", revenue, "÷")],
        compute: ([profit, sales]) => over(profit!, sales!),
      },
    ],
  },
  {
    name: "Leverage",
    key: "leverage",
    ratios: [
      {
        id: "net-debt-ebitda",
        label: "Net Debt / EBITDA",
        format: "multiple",
        inputs: [
          {
            label: "Net Debt",
            format: "money",
            value: ({ statement }) => {
              const debt = finite(statement.totalDebt);
              const cash = cashAndShortTerm(statement);
              return debt === undefined || cash === undefined ? "not-reported" : debt - cash;
            },
          },
          flow("EBITDA", line("ebitda"), "÷"),
        ],
        compute: ([debt, ebitda]) => over(debt!, ebitda!),
      },
      {
        id: "debt-equity",
        label: "Debt / Equity",
        format: "multiple",
        inputs: [
          { label: "Total Debt", format: "money", value: closing(line("totalDebt")) },
          { label: "Equity", operator: "÷", format: "money", value: closing(equity) },
        ],
        compute: ([debt, base]) => over(debt!, base!),
      },
      {
        id: "interest-coverage",
        label: "Interest Coverage",
        format: "multiple",
        // A ratio of two flows over the same period needs no annualization.
        inputs: [
          { label: "EBIT", format: "money", value: ({ statement }) => reported(finite(statement.operatingIncome)) },
          { label: "Interest Expense", operator: "÷", format: "money", value: ({ statement }) => reported(finite(statement.interestExpense)) },
        ],
        compute: ([ebit, interest]) => over(ebit!, interest!),
      },
      {
        id: "fcf-debt",
        label: "FCF / Debt",
        format: "percent",
        signed: true,
        inputs: [
          flow("Free Cash Flow", freeCashFlow),
          { label: "Total Debt", operator: "÷", format: "money", value: closing(line("totalDebt")) },
        ],
        compute: ([cash, debt]) => over(cash!, debt!),
      },
    ],
  },
  {
    name: "Liquidity",
    key: "liquidity",
    ratios: [
      {
        id: "current-ratio",
        label: "Current Ratio",
        format: "multiple",
        inputs: [
          { label: "Current Assets", format: "money", value: closing(line("currentAssets")) },
          { label: "Current Liab", operator: "÷", format: "money", value: closing(line("currentLiabilities")) },
        ],
        compute: ([assets, liabilities]) => over(assets!, liabilities!),
      },
      {
        id: "quick-ratio",
        label: "Quick Ratio",
        format: "multiple",
        inputs: [
          {
            label: "Cash + ST Inv + Rec",
            format: "money",
            value: ({ statement }) => {
              const cash = cashAndShortTerm(statement);
              const owed = receivables(statement);
              return cash === undefined || owed === undefined ? "not-reported" : cash + owed;
            },
          },
          { label: "Current Liab", operator: "÷", format: "money", value: closing(line("currentLiabilities")) },
        ],
        compute: ([assets, liabilities]) => over(assets!, liabilities!),
      },
      {
        id: "cash-ratio",
        label: "Cash Ratio",
        format: "multiple",
        inputs: [
          { label: "Cash + ST Inv", format: "money", value: closing(cashAndShortTerm) },
          { label: "Current Liab", operator: "÷", format: "money", value: closing(line("currentLiabilities")) },
        ],
        compute: ([cash, liabilities]) => over(cash!, liabilities!),
      },
    ],
  },
  {
    name: "Efficiency",
    key: "efficiency",
    ratios: [
      DSO,
      DIO,
      DPO,
      {
        id: "cash-conversion",
        label: "Cash Conversion (days)",
        format: "days",
        inputs: [dayCount("DSO", DSO), dayCount("DIO", DIO, "+"), dayCount("DPO", DPO, "−")],
        compute: ([sales, inventory, payable]) => sales! + inventory! - payable!,
      },
      {
        id: "asset-turnover",
        label: "Asset Turnover",
        format: "multiple",
        inputs: [flow("Revenue", revenue), { label: "Avg Total Assets", operator: "÷", format: "money", value: average(line("totalAssets")) }],
        compute: ([sales, assets]) => over(sales!, assets!),
      },
    ],
  },
  {
    name: "Valuation",
    key: "valuation",
    ratios: [
      {
        id: "pe",
        label: "P/E",
        format: "multiple",
        inputs: [
          { label: "Price", format: "perShare", value: ({ price }) => price },
          { label: "Diluted EPS", operator: "÷", format: "perShare", annualized: true, value: dilutedEps },
        ],
        compute: ([price, eps]) => over(price!, eps!),
      },
      {
        id: "ev-ebitda",
        label: "EV / EBITDA",
        format: "multiple",
        inputs: [
          { label: "Enterprise Value", format: "money", value: enterpriseValue },
          flow("EBITDA", line("ebitda"), "÷"),
        ],
        // A negative enterprise value makes the multiple meaningless too.
        compute: ([value, ebitda]) => (value! > 0 ? over(value!, ebitda!) : "not-meaningful"),
      },
      {
        id: "ps",
        label: "P/S",
        format: "multiple",
        inputs: [{ label: "Market Cap", format: "money", value: marketCap }, flow("Revenue", revenue, "÷")],
        compute: ([cap, sales]) => over(cap!, sales!),
      },
      {
        id: "pb",
        label: "P/B",
        format: "multiple",
        inputs: [
          { label: "Market Cap", format: "money", value: marketCap },
          { label: "Equity", operator: "÷", format: "money", value: closing(equity) },
        ],
        compute: ([cap, book]) => over(cap!, book!),
      },
      {
        id: "fcf-yield",
        label: "FCF Yield",
        format: "percent",
        signed: true,
        inputs: [flow("Free Cash Flow", freeCashFlow), { label: "Market Cap", operator: "÷", format: "money", value: marketCap }],
        compute: ([cash, cap]) => over(cash!, cap!),
      },
    ],
  },
];

export const RATIO_TAB_KEYS = new Set(RATIO_TABS.map((tab) => tab.key));

/**
 * Which gap a ratio shows when inputs are missing: a line the filer did not
 * report explains more than a missing close, and a close still loading may
 * yet arrive.
 */
const GAP_ORDER: RatioGap[] = ["not-reported", "not-meaningful", "no-price", "loading"];

export function evaluateRatio(def: RatioDef, period: RatioPeriod): RatioCell {
  const inputs = def.inputs.map((input) => input.value(period));
  const gap = GAP_ORDER.find((candidate) => inputs.includes(candidate));
  if (gap) return { value: gap, inputs };
  const values = inputs.map((amount, index) => (
    def.inputs[index]!.annualized && period.quarterly ? (amount as number) * QUARTERS_PER_YEAR : amount as number
  ));
  const value = def.compute(values);
  return { value: isGap(value) || Number.isFinite(value) ? value : "not-meaningful", inputs };
}

/** The label an input row shows: the operator that joins it and the quarterly annualization. */
function ratioInputLabel(input: RatioInputDef, quarterly: boolean): string {
  const label = input.annualized && quarterly ? `${input.label} × ${QUARTERS_PER_YEAR}` : input.label;
  return input.operator ? `${input.operator} ${label}` : label;
}

export function formatRatioValue(format: RatioFormat, amount: RatioAmount): string {
  if (isGap(amount)) return RATIO_GAP_TEXT[amount];
  if (format === "percent") return `${formatNumber(amount * 100, 1)}%`;
  if (format === "days") return formatNumber(amount, 1);
  return `${formatNumber(amount, Math.abs(amount) < 10 ? 2 : 1)}x`;
}

export function formatRatioInput(format: RatioInputFormat, amount: RatioAmount, divisor: number): string {
  if (isGap(amount)) return RATIO_GAP_TEXT[amount];
  if (format === "perShare") return formatPerShareNumber(amount);
  if (format === "days") return formatNumber(amount, 1);
  const scaled = amount / divisor;
  return scaled.toFixed(Math.abs(scaled) >= 100 ? 1 : 2);
}

const dayOf = (value: Date | string) => {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
};

/** The last close on or within a week before the period end, or none. */
export function periodEndClose(history: readonly PricePoint[], periodEnd: string): number | undefined {
  const end = periodEnd.slice(0, 10);
  const earliest = new Date(Date.parse(`${end}T00:00:00Z`) - MAX_PRICE_LAG_DAYS * 86_400_000).toISOString().slice(0, 10);
  let best: { day: string; point: PricePoint } | null = null;
  for (const point of history) {
    const day = dayOf(point.date);
    if (!day || day > end || day < earliest || (best && day <= best.day)) continue;
    best = { day, point };
  }
  if (!best || pricePointIntegrity(best.point)) return undefined;
  return finite(best.point.close) !== undefined && best.point.close > 0 ? best.point.close : undefined;
}

/** A column's period end: the statement date, or the last quarter a TTM column runs to. */
export function ratioPeriodEnd(statement: FinancialTableStatement): string {
  return statement.date === "TTM" ? statement.aggregation?.periodEnd ?? statement.date : statement.date.slice(0, 10);
}

/**
 * Opening balance sheets: the prior year for a year, the prior quarter for a
 * quarter, and the quarter a year before the last one for TTM.
 */
export function ratioOpenings(
  period: FinancialPeriod,
  annualStatements: FinancialStatement[],
  quarterlyStatements: FinancialStatement[],
): Map<string, FinancialStatement> {
  const openings = buildPreviousStatementMap(period, annualStatements, quarterlyStatements, null);
  const latest = quarterlyStatements.at(-1);
  const yearBefore = quarterlyStatements.at(-5);
  if (period === "annual" && latest && yearBefore) {
    const days = (Date.parse(latest.date) - Date.parse(yearBefore.date)) / 86_400_000;
    if (days >= 350 && days <= 380) openings.set("TTM", yearBefore);
  }
  return openings;
}

/** Statements and ratio tabs in the order the section strip shows them. */
export type FinancialSection =
  | { kind: "statement"; name: string; key: string; tab: FinancialSubTab }
  | { kind: "ratio"; name: string; key: string; tab: RatioTabDef };

export const FINANCIAL_SECTIONS: FinancialSection[] = [
  ...FINANCIAL_SUB_TABS.map((tab): FinancialSection => ({ kind: "statement", name: tab.name, key: tab.key, tab })),
  ...RATIO_TABS.map((tab): FinancialSection => ({ kind: "ratio", name: tab.name, key: tab.key, tab })),
];

const RATIO_ALIASES: Record<string, string> = {
  ratios: "profitability",
  returns: "profitability",
  profit: "profitability",
  coverage: "leverage",
  credit: "leverage",
  workingcapital: "efficiency",
  multiples: "valuation",
};

/** A statement or ratio tab key from a stored value or a report option. */
export function resolveFinancialSectionKey(value: string | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  const ratio = RATIO_ALIASES[normalized] ?? RATIO_TABS.find((tab) => tab.key === normalized)?.key;
  return ratio ?? resolveFinancialSubTabKey(value);
}

export function ratioPeriods(
  statements: readonly FinancialTableStatement[],
  openings: ReadonlyMap<string, FinancialStatement>,
  period: FinancialPeriod,
  price: (statement: FinancialTableStatement) => RatioAmount,
): RatioPeriod[] {
  return statements.map((statement) => ({
    statement,
    opening: openings.get(statement.date),
    quarterly: period === "quarterly" && statement.date !== "TTM",
    price: price(statement),
  }));
}

export type RatioTableRow =
  | {
    kind: "ratio";
    id: string;
    def: RatioDef;
    label: string;
    expanded: boolean;
  }
  | {
    kind: "input";
    id: string;
    def: RatioDef;
    index: number;
    label: string;
    unitLabel: string;
    divisor: number;
  };

export interface RatioTableModel {
  tab: RatioTabDef;
  periods: RatioPeriod[];
  /** Each ratio's cell per period, by ratio id. */
  cells: Map<string, RatioCell[]>;
  rows: RatioTableRow[];
}

const UNIT_WORDS: Record<string, string> = { K: "k", M: "mn", B: "bn", T: "tn" };

export function buildRatioTableModel(
  tab: RatioTabDef,
  periods: RatioPeriod[],
  expandedRatioIds: ReadonlySet<string> | "all",
): RatioTableModel {
  const quarterly = periods.some((period) => period.quarterly);
  const cells = new Map(tab.ratios.map((def) => [def.id, periods.map((period) => evaluateRatio(def, period))]));
  const inputs = tab.ratios.flatMap((def) => def.inputs.map((input, index) => {
    const values = cells.get(def.id)!.map((cell) => cell.inputs[index]).filter((value) => typeof value === "number");
    const { suffix, divisor } = input.format === "money" ? pickUnit(values) : { suffix: "", divisor: 1 };
    const unit = UNIT_WORDS[suffix] ?? suffix;
    const label = ratioInputLabel(input, quarterly);
    return {
      kind: "input" as const,
      id: `${def.id}:${index}`,
      def,
      index,
      label,
      unitLabel: unit ? `${label} (${unit})` : label,
      divisor,
    };
  }));
  // Each money input names its unit: a ratio tab has few of them, and a unit
  // stated once in the query bar is the first thing a narrow pane cuts.
  const rows: RatioTableRow[] = [];
  for (const def of tab.ratios) {
    const expanded = expandedRatioIds === "all" || expandedRatioIds.has(def.id);
    rows.push({ kind: "ratio", id: def.id, def, label: def.label, expanded });
    if (expanded) rows.push(...inputs.filter((row) => row.def === def));
  }
  return { tab, periods, cells, rows };
}

export const findRatioTab = (key: string) => RATIO_TABS.find((tab) => tab.key === key);

/**
 * A ratio tab for reports: the pane's columns and math, every ratio expanded.
 * Without a price history, valuation ratios read "no price".
 */
export function ratioTableForFinancials(
  financials: TickerFinancials,
  tab: RatioTabDef,
  period: FinancialPeriod,
  history?: readonly PricePoint[] | null,
): RatioTableModel {
  const annual = [...financials.annualStatements].sort((a, b) => a.date.localeCompare(b.date));
  const quarterly = [...financials.quarterlyStatements].sort((a, b) => a.date.localeCompare(b.date));
  const { statements } = selectFinancialStatements(period, "income", annual, quarterly);
  const currencies = createValuationCurrencyContext(financials);
  const price = (statement: FinancialTableStatement): RatioAmount => {
    const close = history ? periodEndClose(history, ratioPeriodEnd(statement)) : undefined;
    return (close === undefined ? null : currencies.priceInStatementUnits(statement, close)) ?? "no-price";
  };
  return buildRatioTableModel(tab, ratioPeriods(statements, ratioOpenings(period, annual, quarterly), period, price), "all");
}

import type {
  HeadlessBundleResult,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { fetchDividendData, type DividendData } from "./client";
import type { DividendPayment } from "./types";
import { toDividendRows } from "./view";

const PAYMENT_COLUMNS = [
  { key: "exDate", header: "Ex-date" },
  { key: "amount", header: "Amount", align: "right" as const },
  { key: "currency", header: "CCY" },
  { key: "type", header: "Type" },
];

export interface DividendYieldHeadlessDependencies {
  loadData(symbol: string, context: HeadlessPaneContext): Promise<DividendData>;
}

const defaultDependencies: DividendYieldHeadlessDependencies = {
  async loadData(symbol, context) {
    let currentPrice: number | null = null;
    try {
      currentPrice = (await context.marketData.getQuote(symbol, "")).price ?? null;
    } catch {
      currentPrice = null;
    }
    return fetchDividendData(symbol, currentPrice);
  },
};

function matchesType(payment: DividendPayment, type: string): boolean {
  return type === "all" || payment.type === type;
}

export function projectDividendYieldHeadless(
  data: DividendData,
  args: HeadlessPaneLoadArgs,
): HeadlessBundleResult {
  const type = String(args.options.type ?? "all");
  const limit = Number(args.options.limit ?? 40);
  const matching = data.payments.filter((payment) => matchesType(payment, type));
  const selectedPayments = matching.slice(0, limit);
  const rows = toDividendRows(selectedPayments).map((row, index) => {
    const payment = selectedPayments[index];
    return {
      ...row,
      recordDate: payment?.recordDate?.toISOString() ?? null,
      paymentDate: payment?.paymentDate?.toISOString() ?? null,
      declarationDate: payment?.declarationDate?.toISOString() ?? null,
      type: payment?.type ?? null,
    };
  });
  const metrics = data.metrics;

  return {
    sections: [
      {
        title: "Dividend metrics",
        entries: [
          { label: "Price", value: data.price },
          { label: "Trailing yield", value: metrics.trailingYield },
          { label: "Forward yield", value: metrics.forwardYield },
          { label: "Trailing rate", value: metrics.trailingRate },
          { label: "Forward rate", value: metrics.forwardRate },
          { label: "Payout ratio", value: metrics.payoutRatio },
          { label: "1Y growth", value: metrics.growth1Y },
          { label: "3Y growth", value: metrics.growth3Y },
          { label: "Frequency", value: metrics.paymentFrequency },
          { label: "Ex-dividend", value: metrics.exDividendDate },
          { label: "Next pay", value: metrics.nextPayDate },
        ],
      },
      {
        title: "Dividend history",
        columns: PAYMENT_COLUMNS,
        rows,
      },
    ],
    metadata: {
      totalPayments: matching.length,
      returnedPayments: rows.length,
      truncated: rows.length < matching.length,
      type,
    },
  };
}

export function createDividendYieldHeadless(
  dependencies: DividendYieldHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "Company symbol.",
    },
    options: [
      {
        key: "type",
        description: "Dividend payment type to include.",
        type: "enum",
        values: [
          { value: "all" },
          { value: "cash" },
          { value: "special" },
          { value: "stock" },
          { value: "unknown" },
        ],
        defaultValue: "all",
      },
      {
        key: "limit",
        description: "Maximum historical payments to return.",
        type: "integer",
        defaultValue: 40,
        minimum: 1,
        maximum: 200,
      },
    ],
    describe: (args) => `Dividend Yield | ${String(args.argument)}`,
    async load(args, context) {
      const symbol = String(args.argument);
      return projectDividendYieldHeadless(
        await dependencies.loadData(symbol, context),
        args,
      );
    },
  };
}

export const dividendYieldHeadless = createDividendYieldHeadless();

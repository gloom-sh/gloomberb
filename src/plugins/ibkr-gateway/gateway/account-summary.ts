import type { BrokerAccount, BrokerCashBalance } from "../../../types/trading";

type AccountSummaryValueMap = ReadonlyMap<string, { value: string }>;
export type AccountSummaryTags = ReadonlyMap<string, AccountSummaryValueMap>;

export interface AccountPnlSnapshot {
  dailyPnl?: number;
  unrealizedPnl?: number;
  realizedPnl?: number;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getAccountSummaryEntry(
  values: AccountSummaryValueMap | undefined,
  preferredCurrency?: string,
): { currency: string; value: number } | null {
  if (!values) return null;

  if (preferredCurrency) {
    const preferred = values.get(preferredCurrency);
    if (preferred?.value) {
      const numeric = parseFloat(preferred.value);
      if (Number.isFinite(numeric)) {
        return { currency: preferredCurrency, value: numeric };
      }
    }
  }

  for (const [currency, entry] of values.entries()) {
    const numeric = parseFloat(entry?.value ?? "");
    if (Number.isFinite(numeric)) {
      return { currency, value: numeric };
    }
  }
  return null;
}

function getAccountSummaryNumber(
  tags: AccountSummaryTags | undefined,
  tagName: string,
  preferredCurrency?: string,
): number | undefined {
  return getAccountSummaryEntry(tags?.get(tagName), preferredCurrency)?.value;
}

function getAccountSummaryNumberWithAggregateFallback(
  tags: AccountSummaryTags | undefined,
  aggregateTags: AccountSummaryTags | undefined,
  tagName: string,
  preferredCurrency: string | undefined,
  allowAggregateFallback: boolean,
): number | undefined {
  const direct = getAccountSummaryNumber(tags, tagName, preferredCurrency);
  if (direct != null) return direct;
  if (!allowAggregateFallback) return undefined;
  return getAccountSummaryNumber(aggregateTags, tagName, preferredCurrency);
}

function inferAccountCurrency(tags: AccountSummaryTags | undefined): string | undefined {
  if (!tags) return undefined;
  for (const tagName of ["NetLiquidation", "TotalCashValue", "SettledCash", "AvailableFunds"]) {
    const entry = getAccountSummaryEntry(tags.get(tagName));
    if (entry?.currency) return entry.currency;
  }
  return undefined;
}

function getSummaryMap(
  tags: AccountSummaryTags | undefined,
  tagName: string,
): AccountSummaryValueMap | undefined {
  const values = tags?.get(tagName);
  return values && values.size > 0 ? values : undefined;
}

function buildCashBalancesFromSummary(
  cashBalanceMap: AccountSummaryValueMap | undefined,
  exchangeRateMap: AccountSummaryValueMap | undefined,
  baseCurrency?: string,
): BrokerCashBalance[] | undefined {
  const balances: BrokerCashBalance[] = [];
  for (const [currency, entry] of cashBalanceMap?.entries() ?? []) {
    if (!currency || currency === "BASE") continue;
    const numeric = parseFloat(entry?.value ?? "");
    if (!Number.isFinite(numeric)) continue;

    const exchangeRate = currency === baseCurrency
      ? 1
      : parseFloat(exchangeRateMap?.get(currency)?.value ?? "");
    const baseValue = Number.isFinite(exchangeRate) ? numeric * exchangeRate : undefined;

    balances.push({
      currency,
      quantity: numeric,
      baseValue,
      baseCurrency,
    });
  }

  return balances.length > 0 ? balances : undefined;
}

function buildCashBalances(
  tags: AccountSummaryTags | undefined,
  aggregateTags: AccountSummaryTags | undefined,
  baseCurrency: string | undefined,
  allowAggregateFallback: boolean,
): BrokerCashBalance[] | undefined {
  const directLedger = buildCashBalancesFromSummary(
    getSummaryMap(tags, "$LEDGER:ALL"),
    undefined,
    baseCurrency,
  );
  if (directLedger) return directLedger;

  const directSummary = buildCashBalancesFromSummary(
    getSummaryMap(tags, "CashBalance") ?? getSummaryMap(tags, "TotalCashBalance"),
    getSummaryMap(tags, "ExchangeRate"),
    baseCurrency,
  );
  if (directSummary) return directSummary;

  if (!allowAggregateFallback) return undefined;

  return buildCashBalancesFromSummary(
    getSummaryMap(aggregateTags, "CashBalance") ?? getSummaryMap(aggregateTags, "TotalCashBalance"),
    getSummaryMap(aggregateTags, "ExchangeRate"),
    baseCurrency,
  );
}

export function summarizeBrokerAccount(
  accountId: string,
  tags: AccountSummaryTags | undefined,
  updatedAt: number,
  aggregateTags?: AccountSummaryTags,
  allowAggregateCashBalances = false,
  pnl?: AccountPnlSnapshot,
): BrokerAccount {
  const currency = inferAccountCurrency(tags) ?? (allowAggregateCashBalances ? inferAccountCurrency(aggregateTags) : undefined);
  return {
    accountId,
    name: accountId,
    currency,
    source: "gateway",
    updatedAt,
    netLiquidation: getAccountSummaryNumberWithAggregateFallback(tags, aggregateTags, "NetLiquidation", currency, allowAggregateCashBalances),
    grossPositionValue: getAccountSummaryNumberWithAggregateFallback(tags, aggregateTags, "GrossPositionValue", currency, allowAggregateCashBalances),
    totalCashValue: getAccountSummaryNumberWithAggregateFallback(tags, aggregateTags, "TotalCashValue", currency, allowAggregateCashBalances),
    settledCash: getAccountSummaryNumberWithAggregateFallback(tags, aggregateTags, "SettledCash", currency, allowAggregateCashBalances),
    availableFunds: getAccountSummaryNumberWithAggregateFallback(tags, aggregateTags, "AvailableFunds", currency, allowAggregateCashBalances),
    buyingPower: getAccountSummaryNumberWithAggregateFallback(tags, aggregateTags, "BuyingPower", currency, allowAggregateCashBalances),
    excessLiquidity: getAccountSummaryNumberWithAggregateFallback(tags, aggregateTags, "ExcessLiquidity", currency, allowAggregateCashBalances),
    initMarginReq: getAccountSummaryNumberWithAggregateFallback(tags, aggregateTags, "InitMarginReq", currency, allowAggregateCashBalances),
    maintMarginReq: getAccountSummaryNumberWithAggregateFallback(tags, aggregateTags, "MaintMarginReq", currency, allowAggregateCashBalances),
    dailyPnl: pnl?.dailyPnl,
    unrealizedPnl: pnl?.unrealizedPnl,
    realizedPnl: pnl?.realizedPnl,
    cashBalances: buildCashBalances(tags, aggregateTags, currency, allowAggregateCashBalances),
  };
}

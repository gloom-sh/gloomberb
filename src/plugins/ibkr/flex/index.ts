import type { BrokerPosition } from "../../../types/broker";
import type { BrokerContractRef } from "../../../types/instrument";
import type {
  BrokerAccount,
  BrokerCashBalance,
  BrokerPortfolioPerformance,
  BrokerPortfolioPerformancePoint,
} from "../../../types/trading";

export {
  loadFlexStatement,
  requestFlexStatement,
} from "./statement-client";

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [, key, value] of raw.matchAll(/([a-zA-Z0-9]+)="([^"]*)"/g)) {
    if (!key) continue;
    attributes[key] = value ?? "";
  }
  return attributes;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFlexTimestamp(raw: string | undefined, fallbackDate: string | undefined): number | undefined {
  if (raw) {
    const match = raw.match(/^(\d{4})(\d{2})(\d{2});(\d{2})(\d{2})(\d{2})$/);
    if (match) {
      const [, year, month, day, hour, minute, second] = match;
      return new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ).getTime();
    }
  }

  if (!fallbackDate) return undefined;
  const match = fallbackDate.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return undefined;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day)).getTime();
}

function parseFlexDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) {
    const [, year, month, day] = match;
    return `${year}-${month}-${day}`;
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function parseFlexGrossPositionValue(
  body: string,
  statementAccountId: string,
  baseCurrency: string | undefined,
): number | undefined {
  let total = 0;
  let hasValue = false;

  for (const entry of body.matchAll(/<OpenPosition\b([^>]*)\/?>/g)) {
    const attributes = parseAttributes(entry[1] ?? "");
    const accountId = attributes.accountId || statementAccountId;
    if (!accountId || (statementAccountId && accountId !== statementAccountId)) continue;

    const marketValue = parseNumber(attributes.positionValue);
    if (marketValue == null) continue;

    const positionCurrency = attributes.currency || baseCurrency;
    const fxRateToBase = parseNumber(attributes.fxRateToBase)
      ?? (baseCurrency && positionCurrency === baseCurrency ? 1 : undefined);
    if (fxRateToBase == null) continue;

    total += Math.abs(marketValue * fxRateToBase);
    hasValue = true;
  }

  return hasValue ? total : undefined;
}

function buildContractRef(attributes: Record<string, string>, symbol: string, assetCategory: string): BrokerContractRef | undefined {
  const conIdRaw = attributes.conid || attributes.conId;
  const strikeRaw = attributes.strike;
  const multiplierRaw = attributes.multiplier;
  const lastTrade = attributes.expiry || attributes.lastTradeDate;
  const right = attributes.putCall?.toUpperCase() === "CALL"
    ? "C"
    : attributes.putCall?.toUpperCase() === "PUT"
      ? "P"
      : undefined;

  const conId = conIdRaw ? Number(conIdRaw) : undefined;
  const strike = strikeRaw ? Number(strikeRaw) : undefined;
  const multiplier = multiplierRaw || undefined;

  if (!conId && !assetCategory && !lastTrade && !right && !strike) return undefined;

  return {
    brokerId: "ibkr",
    conId: Number.isFinite(conId) ? conId : undefined,
    symbol,
    localSymbol: attributes.localSymbol || symbol,
    secType: assetCategory || undefined,
    exchange: attributes.exchange || attributes.listingExchange || undefined,
    primaryExchange: attributes.listingExchange || undefined,
    currency: attributes.currency || undefined,
    lastTradeDateOrContractMonth: lastTrade || undefined,
    right,
    strike: Number.isFinite(strike) ? strike : undefined,
    multiplier,
    tradingClass: attributes.tradingClass || undefined,
  };
}

export function parseFlexPositions(xml: string): BrokerPosition[] {
  const positions: BrokerPosition[] = [];
  const posRegex = /<OpenPosition[^>]*>/g;
  let match: RegExpExecArray | null;

  while ((match = posRegex.exec(xml)) !== null) {
    const attributes = parseAttributes(match[0]);

    const attr = (name: string) => attributes[name] || "";
    const numAttr = (name: string) => {
      return parseNumber(attr(name));
    };

    const symbol = attr("symbol");
    const quantity = Number(attr("position") || attr("quantity") || "0");
    const costBasis = Number(attr("costBasisPrice") || attr("costPrice") || "0");
    const currency = attr("currency") || "USD";
    const exchange = attr("listingExchange") || attr("exchange") || "";
    const accountId = attr("accountId");
    const description = attr("description");
    const assetCategory = attr("assetCategory");
    const isin = attr("isin") || attr("securityID");
    const side = attr("side")?.toLowerCase();
    const contract = buildContractRef(attributes, symbol, assetCategory);

    if (!symbol || quantity === 0) continue;

    positions.push({
      ticker: symbol,
      exchange,
      shares: Math.abs(quantity),
      avgCost: costBasis,
      currency,
      accountId: accountId || undefined,
      name: description || undefined,
      assetCategory: assetCategory || undefined,
      isin: isin || undefined,
      side: side === "long" || side === "short" ? side : quantity < 0 ? "short" : "long",
      markPrice: numAttr("markPrice"),
      marketValue: numAttr("positionValue"),
      unrealizedPnl: numAttr("fifoPnlUnrealized") ?? numAttr("unrealizedCapitalGainsPnl"),
      fxRateToBase: numAttr("fxRateToBase"),
      multiplier: numAttr("multiplier"),
      percentOfNav: numAttr("percentOfNAV"),
      brokerContract: contract,
    });
  }

  return positions;
}

export function parseFlexAccounts(xml: string): BrokerAccount[] {
  const accounts: BrokerAccount[] = [];
  const statementRegex = /<FlexStatement\b([^>]*)>([\s\S]*?)<\/FlexStatement>/g;

  for (const match of xml.matchAll(statementRegex)) {
    const statementAttrs = parseAttributes(match[1] ?? "");
    const body = match[2] ?? "";
    const statementAccountId = statementAttrs.accountId || "";

    const changeInNavAttrs = [...body.matchAll(/<ChangeInNAV\b([^>]*)\/>/g)]
      .map((entry) => parseAttributes(entry[1] ?? ""))
      .find((attributes) => !statementAccountId || !attributes.accountId || attributes.accountId === statementAccountId);
    const baseCashAttrs = [...body.matchAll(/<CashReportCurrency\b([^>]*)\/>/g)]
      .map((entry) => parseAttributes(entry[1] ?? ""))
      .find((attributes) =>
        attributes.currency === "BASE_SUMMARY"
        && (!statementAccountId || !attributes.accountId || attributes.accountId === statementAccountId),
      );
    const fallbackCurrencyAttrs = [...body.matchAll(/<CashReportCurrency\b([^>]*)\/>/g)]
      .map((entry) => parseAttributes(entry[1] ?? ""))
      .find((attributes) =>
        attributes.currency !== "BASE_SUMMARY"
        && (!statementAccountId || !attributes.accountId || attributes.accountId === statementAccountId),
      );

    const balancesByCurrency = new Map<string, BrokerCashBalance>();
    for (const entry of body.matchAll(/<FxPosition\b([^>]*)\/>/g)) {
      const attributes = parseAttributes(entry[1] ?? "");
      const accountId = attributes.accountId || statementAccountId;
      if (!accountId || (statementAccountId && accountId !== statementAccountId)) continue;
      if (attributes.assetCategory !== "CASH") continue;

      const currency = attributes.fxCurrency || "";
      if (!currency) continue;

      const existing = balancesByCurrency.get(currency);
      const quantity = parseNumber(attributes.quantity) ?? 0;
      const baseValue = parseNumber(attributes.value);
      balancesByCurrency.set(currency, {
        currency,
        quantity: (existing?.quantity ?? 0) + quantity,
        baseValue: existing?.baseValue != null || baseValue != null
          ? (existing?.baseValue ?? 0) + (baseValue ?? 0)
          : undefined,
        baseCurrency: attributes.functionalCurrency || existing?.baseCurrency,
      });
    }

    const accountId = statementAccountId || changeInNavAttrs?.accountId;
    if (!accountId) continue;

    const cashBalances = [...balancesByCurrency.values()];
    const accountCurrency = changeInNavAttrs?.currency
      || cashBalances[0]?.baseCurrency
      || fallbackCurrencyAttrs?.currency
      || undefined;

    accounts.push({
      accountId,
      name: changeInNavAttrs?.acctAlias || statementAttrs.acctAlias || accountId,
      currency: accountCurrency,
      source: "flex",
      updatedAt: parseFlexTimestamp(statementAttrs.whenGenerated, statementAttrs.toDate || statementAttrs.fromDate),
      asOfDate: parseFlexDate(statementAttrs.toDate || statementAttrs.fromDate) ?? undefined,
      netLiquidation: parseNumber(changeInNavAttrs?.endingValue),
      grossPositionValue: parseFlexGrossPositionValue(body, accountId, accountCurrency),
      totalCashValue: parseNumber(baseCashAttrs?.endingCash),
      settledCash: parseNumber(baseCashAttrs?.endingSettledCash),
      cashBalances: cashBalances.length > 0 ? cashBalances : undefined,
    });
  }

  return accounts;
}

function firstNumberAttribute(
  attributes: Record<string, string>,
  names: string[],
): number | undefined {
  for (const name of names) {
    const value = parseNumber(attributes[name]);
    if (value != null) return value;
  }
  return undefined;
}

function firstStringAttribute(
  attributes: Record<string, string>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = attributes[name];
    if (value) return value;
  }
  return undefined;
}

function parseFlexReturn(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  return Math.abs(value) > 1 ? value / 100 : value;
}

function flexAccountTokens(attributes: Record<string, string>): Set<string> {
  return new Set([
    attributes.accountId,
    attributes.acctAlias,
    attributes.accountAlias,
    attributes.alias,
    attributes.name,
  ].filter((value): value is string => !!value));
}

export function parseFlexPortfolioPerformance(
  xml: string,
  accountId: string,
  fetchedAt = Date.now(),
): BrokerPortfolioPerformance | null {
  const points: BrokerPortfolioPerformancePoint[] = [];
  let currency: string | undefined;

  const statementRegex = /<FlexStatement\b([^>]*)>([\s\S]*?)<\/FlexStatement>/g;
  const statements = [...xml.matchAll(statementRegex)].map((statementMatch) => ({
    attributes: parseAttributes(statementMatch[1] ?? ""),
    body: statementMatch[2] ?? "",
  }));

  for (const statement of statements) {
    const statementAttrs = statement.attributes;
    const body = statement.body;
    const statementAccountId = statementAttrs.accountId || "";
    const statementTokens = flexAccountTokens(statementAttrs);
    const statementMatchesAccount = statementTokens.has(accountId);
    if (statementAccountId && !statementMatchesAccount && statements.length !== 1) continue;

    for (const entry of body.matchAll(/<ChangeInNAV\b([^>]*)\/>/g)) {
      const attributes = parseAttributes(entry[1] ?? "");
      const entryAccountId = attributes.accountId || statementAccountId;
      const entryTokens = flexAccountTokens(attributes);
      const entryMatchesAccount = entryTokens.has(accountId)
        || (statementMatchesAccount && (!entryAccountId || entryAccountId === statementAccountId));
      if (entryAccountId && !entryMatchesAccount && statements.length !== 1) continue;

      const date = parseFlexDate(firstStringAttribute(attributes, [
        "reportDate",
        "date",
        "toDate",
        "asOfDate",
      ]) ?? statementAttrs.toDate ?? statementAttrs.fromDate);
      if (!date) continue;

      const value = firstNumberAttribute(attributes, [
        "endingValue",
        "endingNAV",
        "nav",
        "netAssetValue",
      ]);
      const cumulativeReturn = parseFlexReturn(firstNumberAttribute(attributes, [
        "cumulativeReturn",
        "timeWeightedReturnCumulative",
        "twrCumulative",
        "twr",
        "mwr",
      ]));
      if (value == null && cumulativeReturn == null) continue;

      currency = currency ?? attributes.currency;
      points.push({ date, value, cumulativeReturn });
    }
  }

  const uniquePoints = [...new Map(
    points
      .sort((left, right) => left.date.localeCompare(right.date))
      .map((point) => [point.date, point] as const),
  ).values()];

  if (uniquePoints.length === 0) return null;

  return {
    accountId,
    source: "flex",
    period: "FLEX",
    currency,
    fetchedAt,
    startDate: uniquePoints[0]?.date,
    endDate: uniquePoints.at(-1)?.date,
    points: uniquePoints,
  };
}

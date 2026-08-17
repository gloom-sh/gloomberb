import type { BrokerPosition } from "../../types/broker";
import type { BrokerAccount } from "../../types/trading";

export interface BrokerPortfolioSnapshot {
  accounts: BrokerAccount[];
  positions: BrokerPosition[];
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function text(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replaceAll(",", ""))
        : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function nested(source: UnknownRecord, key: string): UnknownRecord {
  return record(source[key]) ?? {};
}

function allRecords(value: unknown, output: UnknownRecord[] = [], seen = new Set<object>()): UnknownRecord[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) allRecords(item, output, seen);
    return output;
  }
  const item = value as UnknownRecord;
  output.push(item);
  for (const child of Object.values(item)) allRecords(child, output, seen);
  return output;
}

function accountId(source: UnknownRecord): string {
  return text(
    source.accountId,
    source.account_id,
    source.accountNumber,
    source.account_number,
    source.brokerageAccountId,
    source.brokerage_account_id,
  );
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/(^|[_\s-])([a-z])/g, (_match, prefix: string, letter: string) => (
    `${prefix === "_" ? " " : prefix}${letter.toUpperCase()}`
  ));
}

function uniqueSnapshot(accounts: BrokerAccount[], positions: BrokerPosition[]): BrokerPortfolioSnapshot {
  const uniqueAccounts = [...new Map(accounts.map((account) => [account.accountId, account])).values()];
  const knownAccounts = new Set(uniqueAccounts.map((account) => account.accountId));
  for (const position of positions) {
    if (!position.accountId || knownAccounts.has(position.accountId)) continue;
    knownAccounts.add(position.accountId);
    uniqueAccounts.push({
      accountId: position.accountId,
      name: position.accountId,
      currency: position.currency,
    });
  }
  const uniquePositions = [...new Map(positions.map((position) => [
    `${position.accountId ?? ""}:${position.ticker}:${position.assetCategory ?? ""}`,
    position,
  ])).values()];
  return { accounts: uniqueAccounts, positions: uniquePositions };
}

export function normalizeRobinhoodSnapshot(accountsPayload: unknown, positionsPayload: unknown): BrokerPortfolioSnapshot {
  const accounts = allRecords(accountsPayload).flatMap((item): BrokerAccount[] => {
    const id = accountId(item);
    if (!id) return [];
    const type = text(item.accountType, item.account_type, item.type);
    const currency = text(item.currency, item.baseCurrency, item.base_currency, "USD").toUpperCase();
    return [{
      accountId: id,
      name: text(item.name, item.accountName, item.account_name, type && titleCase(type), id),
      currency,
      netLiquidation: numberValue(item.totalValue, item.total_value, item.portfolioValue, item.portfolio_value),
      buyingPower: numberValue(item.buyingPower, item.buying_power),
    }];
  });

  const positions = allRecords(positionsPayload).flatMap((item): BrokerPosition[] => {
    const instrument = nested(item, "instrument");
    const account = nested(item, "account");
    const costBasis = record(item.costBasis) ?? record(item.cost_basis) ?? {};
    const lastPrice = record(item.lastPrice) ?? record(item.last_price) ?? {};
    const symbol = text(item.symbol, item.ticker, instrument.symbol).toUpperCase();
    const shares = numberValue(item.quantity, item.shares, item.qty);
    if (!symbol || shares == null || shares === 0) return [];
    const totalCost = numberValue(
      item.totalCost,
      item.total_cost,
      typeof item.costBasis === "object" ? undefined : item.costBasis,
      typeof item.cost_basis === "object" ? undefined : item.cost_basis,
      costBasis.totalCost,
      costBasis.total_cost,
    );
    const avgCost = numberValue(
      item.averageCost,
      item.average_cost,
      item.averageBuyPrice,
      item.average_buy_price,
      item.costBasisPerShare,
      item.cost_basis_per_share,
      costBasis.unitCost,
      costBasis.unit_cost,
      totalCost != null ? totalCost / Math.abs(shares) : undefined,
    );
    const marketValue = numberValue(item.marketValue, item.market_value, item.currentValue, item.current_value);
    const markPrice = numberValue(
      item.markPrice,
      item.mark_price,
      item.price,
      item.lastPrice,
      item.last_price,
      lastPrice.lastPrice,
      lastPrice.last_price,
      lastPrice.price,
      marketValue != null ? marketValue / Math.abs(shares) : undefined,
    );
    return [{
      ticker: symbol,
      exchange: text(item.exchange, instrument.exchange, "SMART").toUpperCase(),
      shares,
      avgCost,
      currency: text(item.currency, instrument.currency, "USD").toUpperCase(),
      accountId: accountId(item) || accountId(account) || undefined,
      name: text(item.name, item.description, instrument.name, symbol),
      assetCategory: "STK",
      markPrice,
      marketValue,
      unrealizedPnl: numberValue(item.unrealizedPnl, item.unrealized_pnl, item.unrealizedGain, item.unrealized_gain),
      side: shares < 0 ? "short" : "long",
    }];
  });

  return uniqueSnapshot(accounts, positions);
}

export function normalizePublicSnapshot(accountsPayload: unknown, portfolioPayloads: unknown[]): BrokerPortfolioSnapshot {
  const accountRecords = record(accountsPayload)?.accounts;
  const accounts = (Array.isArray(accountRecords) ? accountRecords : []).flatMap((value): BrokerAccount[] => {
    const item = record(value);
    if (!item) return [];
    const id = accountId(item);
    if (!id) return [];
    const type = text(item.accountType, item.account_type);
    return [{ accountId: id, name: type ? `Public ${titleCase(type)}` : `Public ${id}`, currency: "USD" }];
  });

  const positions: BrokerPosition[] = [];
  for (const value of portfolioPayloads) {
    const portfolio = record(value);
    if (!portfolio) continue;
    const id = accountId(portfolio);
    const knownAccount = accounts.find((account) => account.accountId === id);
    if (knownAccount) {
      knownAccount.netLiquidation = numberValue(portfolio.totalAccountValue, portfolio.total_account_value);
      knownAccount.totalCashValue = numberValue(portfolio.cash);
      knownAccount.buyingPower = numberValue(nested(portfolio, "buyingPower").buyingPower);
    }
    const rawPositions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
    for (const rawPosition of rawPositions) {
      const item = record(rawPosition);
      if (!item) continue;
      const instrument = nested(item, "instrument");
      const lastPrice = nested(item, "lastPrice");
      const costBasis = nested(item, "costBasis");
      const symbol = text(instrument.symbol, item.symbol).toUpperCase();
      const shares = numberValue(item.quantity);
      if (!symbol || shares == null || shares === 0) continue;
      positions.push({
        ticker: symbol,
        exchange: "SMART",
        shares,
        avgCost: numberValue(costBasis.unitCost, costBasis.unit_cost),
        currency: "USD",
        accountId: id || undefined,
        name: text(instrument.name, symbol),
        assetCategory: text(instrument.type, "STK").toUpperCase() === "EQUITY" ? "STK" : text(instrument.type, "STK").toUpperCase(),
        markPrice: numberValue(lastPrice.lastPrice, lastPrice.last_price),
        marketValue: numberValue(item.currentValue, item.current_value),
        unrealizedPnl: numberValue(costBasis.gainValue, costBasis.gain_value),
        percentOfNav: numberValue(item.percentOfPortfolio, item.percent_of_portfolio),
        dateAcquired: text(item.openedAt, item.opened_at) || undefined,
        side: shares < 0 ? "short" : "long",
      });
    }
  }
  return uniqueSnapshot(accounts, positions);
}

export function normalizeSimpleFinSnapshot(payload: unknown): BrokerPortfolioSnapshot {
  const root = record(payload);
  const rawAccounts = Array.isArray(root?.accounts) ? root.accounts : [];
  const accounts: BrokerAccount[] = [];
  const positions: BrokerPosition[] = [];
  for (const rawAccount of rawAccounts) {
    const account = record(rawAccount);
    if (!account) continue;
    const id = text(account.id);
    const holdings = Array.isArray(account.holdings) ? account.holdings : [];
    if (!id || holdings.length === 0) continue;
    const currency = text(account.currency, "USD").toUpperCase();
    accounts.push({
      accountId: `${text(account.conn_id)}:${id}`,
      name: text(account.name, id),
      currency,
      netLiquidation: numberValue(account.balance),
      updatedAt: (numberValue(account["balance-date"]) ?? 0) * 1000 || undefined,
    });
    const normalizedAccountId = accounts.at(-1)!.accountId;
    for (const rawHolding of holdings) {
      const holding = record(rawHolding);
      if (!holding) continue;
      const symbol = text(holding.symbol, holding.ticker, holding.code).toUpperCase();
      const shares = numberValue(holding.shares, holding.quantity, holding.units);
      const marketValue = numberValue(holding.market_value, holding.marketValue, holding.value);
      if (!symbol || shares == null || shares === 0) continue;
      const costBasis = numberValue(holding.cost_basis, holding.costBasis);
      const avgCost = numberValue(
        holding.purchase_price,
        holding.average_price,
        holding.average_cost,
        costBasis != null ? costBasis / Math.abs(shares) : undefined,
      );
      positions.push({
        ticker: symbol,
        exchange: text(holding.exchange, "SMART").toUpperCase(),
        shares,
        avgCost,
        currency: text(holding.currency, currency).toUpperCase(),
        accountId: normalizedAccountId,
        name: text(holding.description, holding.name, symbol),
        assetCategory: text(holding.type, holding.asset_type, "STK").toUpperCase(),
        markPrice: numberValue(
          holding.price,
          holding.current_price,
          holding.market_price,
          marketValue != null ? marketValue / Math.abs(shares) : undefined,
        ),
        marketValue,
        side: shares < 0 ? "short" : "long",
      });
    }
  }
  return uniqueSnapshot(accounts, positions);
}

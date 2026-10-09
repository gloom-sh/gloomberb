import type { PaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import type { BrokerAdapter, BrokerPosition } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { BrokerContractRef } from "../../../types/instrument";
import type { Quote } from "../../../types/financials";
import type { BrokerAccount, BrokerOrderRequest, BrokerTradingCapabilities } from "../../../types/trading";
import type { BrokerAccountChoice } from "./account-picker";

/** Successful broker reads may publish status heartbeats. They must not schedule another read. */
export function subscribeTradingStatus(broker: BrokerAdapter, profile: BrokerInstanceConfig, onChange: () => void): () => void {
  const key = () => {
    const status = broker.getStatus?.(profile);
    return JSON.stringify([status?.state, status?.mode, status?.quoteData]);
  };
  let previous = key();
  return broker.subscribeStatus?.(profile, () => {
    const next = key();
    if (next === previous) return;
    previous = next;
    onChange();
  }) ?? (() => {});
}

export interface ProfileAccountChoice extends BrokerAccountChoice { profileId: string; accountId: string }

export function ticketAccountChoiceKey(profileId: string, accountId: string): string { return JSON.stringify([profileId, accountId]); }

export function buildTicketAccountChoices(profiles: { profile: BrokerInstanceConfig; accounts: BrokerAccount[] }[]): ProfileAccountChoice[] {
  return profiles.flatMap(({ profile, accounts }) => accounts.map((account, index) => ({ value: ticketAccountChoiceKey(profile.id, account.accountId), label: account.name || `Account ${index + 1}`, profileLabel: profile.label, tradingMode: account.tradingMode, profileId: profile.id, accountId: account.accountId })));
}

export interface TicketPositionSnapshot {
  profile: BrokerInstanceConfig;
  positions: BrokerPosition[];
  fetchedAt: number;
}

/** A missing or expired snapshot is unknown, while a successful empty snapshot means zero. */
export function ticketPositionContext(snapshot: TicketPositionSnapshot | undefined, profile: BrokerInstanceConfig, accountId: string | undefined, contract: BrokerContractRef, now = Date.now()): { quantity: number; avgCost?: number; pnl?: number } | undefined {
  if (!snapshot || !accountId || snapshot.profile.id !== profile.id || snapshot.profile.config !== profile.config || now - snapshot.fetchedAt > 60_000 || !contract.symbol) return undefined;
  const normalize = (symbol: string) => symbol.replace(/^O:/, "").replace(/\s+/g, "").toUpperCase();
  const stock = (type: string | undefined) => !type || type === "STK" || type === "ETF";
  const matched = snapshot.positions.filter((position) => {
    if (position.accountId !== accountId) return false;
    const held = position.brokerContract;
    if (!held) return stock(contract.secType) && stock(position.assetCategory) && normalize(position.ticker) === normalize(contract.symbol);
    if (held.brokerId !== contract.brokerId || (held.brokerInstanceId && held.brokerInstanceId !== profile.id)) return false;
    if (held.conId !== undefined && contract.conId !== undefined) return held.conId === contract.conId;
    if (!(stock(held.secType) && stock(contract.secType)) && held.secType !== contract.secType) return false;
    if (held.localSymbol && contract.localSymbol && normalize(held.localSymbol) === normalize(contract.localSymbol) && (stock(contract.secType) || normalize(contract.localSymbol) !== normalize(contract.symbol))) return true;
    if (normalize(held.symbol) !== normalize(contract.symbol)) return false;
    if (stock(contract.secType)) return true;
    return !!contract.lastTradeDateOrContractMonth && held.lastTradeDateOrContractMonth === contract.lastTradeDateOrContractMonth && held.right === contract.right && held.strike === contract.strike && held.multiplier === contract.multiplier;
  });
  if (matched.some((position) => !Number.isFinite(position.shares))) return undefined;
  const quantity = matched.reduce((total, position) => total + (position.side === "short" ? -Math.abs(position.shares) : position.shares), 0);
  const weight = matched.reduce((total, position) => total + Math.abs(position.shares), 0);
  const avgCost = weight > 0 && matched.every((position) => position.avgCost !== undefined && Number.isFinite(position.avgCost)) ? matched.reduce((total, position) => total + position.avgCost! * Math.abs(position.shares), 0) / weight : undefined;
  const pnl = matched.length && matched.every((position) => position.unrealizedPnl !== undefined && Number.isFinite(position.unrealizedPnl)) ? matched.reduce((total, position) => total + position.unrealizedPnl!, 0) : undefined;
  return { quantity, avgCost, pnl };
}

export function availableTicketPosition(snapshot: TicketPositionSnapshot | undefined, profile: BrokerInstanceConfig, accountId: string | undefined, contract: BrokerContractRef, now = Date.now()): number | undefined {
  return ticketPositionContext(snapshot, profile, accountId, contract, now)?.quantity;
}

/** Quick sizing rounds down to the broker's allowed increment and never assumes margin. */
export function quickTicketQuantity(draft: BrokerOrderRequest, capabilities: BrokerTradingCapabilities, quote: Quote | undefined, account: BrokerAccount | undefined, held: number | undefined, fraction: number): number {
  let maximum: number;
  if (draft.action === "SELL") {
    if (held === undefined || !Number.isFinite(held) || held <= 0) throw new Error("Refresh the held position before choosing a sell quantity.");
    maximum = held;
  } else {
    const brokerPrice = quote?.ask ?? quote?.price;
    const multiplier = Number(draft.contract.multiplier ?? 1);
    const price = Math.max(brokerPrice ?? NaN, draft.limitPrice ?? 0, draft.stopPrice ?? 0);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(multiplier) || multiplier <= 0 || account?.buyingPower === undefined || !Number.isFinite(account.buyingPower) || account.buyingPower <= 0) throw new Error("Load the broker quote and buying power before choosing a buy quantity.");
    maximum = account.buyingPower / (price * multiplier);
  }
  const step = capabilities.quantityStep ?? (capabilities.fractionalQuantity ? 0.000001 : 1);
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) throw new Error("This broker cannot calculate a valid quick quantity.");
  const target = maximum * fraction;
  let quantity = Number((Math.floor(target / step + 1e-10) * step).toFixed(8));
  if (!capabilities.fractionalQuantity && !Number.isInteger(quantity)) {
    quantity = Math.floor(quantity);
    for (let count = 0; count < 1000 && quantity > 0 && Math.abs(quantity / step - Math.round(quantity / step)) > 1e-8; count++) quantity--;
  }
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity < (capabilities.minQuantity ?? 0) || quantity > maximum + 1e-8 || Math.abs(quantity / step - Math.round(quantity / step)) > 1e-8) throw new Error("The available amount is below the broker's minimum order quantity.");
  return quantity;
}

/** Broker contract IDs are meaningful only inside their original broker profile. */
export function resolveTicketContract(identity: PaneTickerIdentity, broker: BrokerAdapter, instance: BrokerInstanceConfig): { contract?: BrokerContractRef; error?: string } {
  if (identity.error) return { error: identity.error };
  if (!identity.symbol) return { error: "Choose a ticker to trade." };
  if (identity.contract) {
    if (identity.contract.brokerId !== broker.id || (identity.contract.brokerInstanceId && identity.contract.brokerInstanceId !== instance.id)) {
      return { error: "Choose the broker profile that owns this instrument, or select a listing from the intended broker." };
    }
    return { contract: { ...identity.contract, brokerInstanceId: instance.id } };
  }
  return { contract: { brokerId: broker.id, brokerInstanceId: instance.id, symbol: identity.symbol, localSymbol: identity.symbol,
    secType: identity.ticker?.metadata.assetCategory ?? "STK", currency: identity.ticker?.metadata.currency ?? "USD", exchange: identity.ticker?.metadata.exchange } };
}

export function chooseTicketAccount(accounts: BrokerAccount[], previous?: string): string | undefined {
  if (accounts.some((account) => account.accountId === previous)) return previous;
  return accounts.length === 1 && accounts[0]?.tradingMode === "simulation" ? accounts[0].accountId : undefined;
}

function defaultQuantity(capabilities: BrokerTradingCapabilities | undefined): number {
  const minimum = capabilities?.minQuantity;
  const start = Math.max(1, minimum && Number.isFinite(minimum) ? minimum : 1);
  const step = capabilities?.quantityStep;
  if (!step || !Number.isFinite(step) || step <= 0) return capabilities?.fractionalQuantity ? start : Math.ceil(start);
  const quantity = Number((Math.ceil(start / step - 1e-10) * step).toFixed(8));
  if (capabilities?.fractionalQuantity || Number.isInteger(quantity)) return quantity;
  // Some brokers combine a fractional increment with whole-quantity instruments.
  // Never prefill an invalid amount if those constraints cannot be reconciled.
  for (let integer = Math.ceil(start); integer <= Math.ceil(start) + 1000; integer++) {
    if (Math.abs(integer / step - Math.round(integer / step)) < 1e-8) return integer;
  }
  return NaN;
}

export function newTicketDraft(broker: BrokerAdapter, instance: BrokerInstanceConfig, contract: BrokerContractRef, accountId?: string, action: "BUY" | "SELL" = "BUY"): BrokerOrderRequest {
  const initial = broker.getTradingCapabilities?.(instance, contract);
  const orderType = initial?.orderTypes.includes("LMT") ? "LMT" : initial?.orderTypes[0] ?? "LMT";
  const capabilities = broker.getTradingCapabilities?.(instance, contract, orderType) ?? initial;
  const tif = capabilities?.tif.includes("DAY") ? "DAY" : capabilities?.tif[0];
  return { brokerInstanceId: instance.id, accountId, contract, action, orderType, quantity: defaultQuantity(capabilities), tif };
}

export function editTicketDraft(broker: BrokerAdapter, instance: BrokerInstanceConfig, draft: BrokerOrderRequest, field: string, value: string | boolean): BrokerOrderRequest {
  const numeric = ["quantity", "limitPrice", "stopPrice"].includes(field);
  const next = { ...draft, [field]: numeric ? value === "" ? field === "quantity" ? NaN : undefined : Number(value) : value };
  if (field === "orderType") {
    if (next.orderType !== "LMT" && next.orderType !== "STP LMT") delete next.limitPrice;
    if (next.orderType !== "STP" && next.orderType !== "STP LMT") delete next.stopPrice;
  }
  const capabilities = broker.getTradingCapabilities?.(instance, next.contract, next.orderType);
  if (capabilities && !capabilities.tif.includes(next.tif ?? "DAY")) next.tif = capabilities.tif[0];
  if (!capabilities?.extendedHours || (capabilities.extendedHoursTif && !capabilities.extendedHoursTif.includes(next.tif ?? "DAY"))) next.outsideRth = false;
  return next;
}

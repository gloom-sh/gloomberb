import type { BrokerContractRef } from "../types/instrument";
import { deliveryMonthLabel } from "../utils/contract-month";

/** Identifying contract terms belong in the existing title, never in a new toolbar. */
export function tickerInstrumentLabel(symbol: string, contract?: BrokerContractRef | null): string {
  if (!contract) return symbol;
  const label = contract.localSymbol || symbol;
  // Brokers report strike 0 (and no expiry) on stocks; only a real strike identifies a derivative.
  const strike = typeof contract.strike === "number" && Number.isFinite(contract.strike) && contract.strike > 0 ? String(contract.strike) : undefined;
  // A future's month (IBKR's "202612") reads as every contract month does, "Dec 2026"; a dated expiry stays as the broker writes it.
  const month = contract.secType === "FUT" && /^\d{6}$/.test(contract.lastTradeDateOrContractMonth ?? "")
    ? deliveryMonthLabel(contract.lastTradeDateOrContractMonth) : null;
  const terms = [month ?? contract.lastTradeDateOrContractMonth, contract.right, strike].filter(Boolean);
  return terms.length ? [label, ...terms].join(" ") : label;
}

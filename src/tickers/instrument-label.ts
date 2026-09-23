import type { BrokerContractRef } from "../types/instrument";

/** Identifying contract terms belong in the existing title, never in a new toolbar. */
export function tickerInstrumentLabel(symbol: string, contract?: BrokerContractRef | null): string {
  if (!contract) return symbol;
  const label = contract.localSymbol || symbol;
  // Brokers report strike 0 (and no expiry) on stocks; only a real strike identifies a derivative.
  const strike = typeof contract.strike === "number" && Number.isFinite(contract.strike) && contract.strike > 0 ? String(contract.strike) : undefined;
  const terms = [contract.lastTradeDateOrContractMonth, contract.right, strike].filter(Boolean);
  return terms.length ? [label, ...terms].join(" ") : label;
}

import {
  OptionType,
  SecType,
  type Contract,
  type ContractDescription,
  type ContractDetails,
} from "@stoqey/ib";
import type { BrokerContractRef, InstrumentSearchResult } from "../../../types/instrument";

export function buildInstrumentSearchKey(result: InstrumentSearchResult): string {
  return `${result.symbol}|${result.exchange}|${result.type}`;
}

export function contractToBrokerRef(
  contract: Contract,
  brokerInstanceId: string | undefined,
): BrokerContractRef {
  return {
    brokerId: "ibkr",
    brokerInstanceId,
    conId: contract.conId,
    symbol: contract.symbol || "",
    localSymbol: contract.localSymbol,
    secType: contract.secType,
    exchange: contract.exchange,
    primaryExchange: contract.primaryExch,
    currency: contract.currency,
    lastTradeDateOrContractMonth: contract.lastTradeDateOrContractMonth,
    right: contract.right === OptionType.Call ? "C" : contract.right === OptionType.Put ? "P" : undefined,
    strike: contract.strike,
    multiplier: contract.multiplier != null ? String(contract.multiplier) : undefined,
    tradingClass: contract.tradingClass,
  };
}

export function brokerRefToContract(ref: BrokerContractRef): Contract {
  return {
    conId: ref.conId,
    symbol: ref.symbol,
    localSymbol: ref.localSymbol,
    secType: (ref.secType as SecType | undefined) ?? SecType.STK,
    exchange: "SMART",
    primaryExch: ref.primaryExchange || ref.exchange || undefined,
    currency: ref.currency || "USD",
    lastTradeDateOrContractMonth: ref.lastTradeDateOrContractMonth,
    right: ref.right === "C" ? OptionType.Call : ref.right === "P" ? OptionType.Put : undefined,
    strike: ref.strike,
    multiplier: ref.multiplier ? parseFloat(ref.multiplier) : undefined,
    tradingClass: ref.tradingClass,
  };
}

export function contractDescriptionToSearchResult(
  description: ContractDescription,
  brokerInstanceId: string | undefined,
): InstrumentSearchResult | null {
  const contract = description.contract;
  if (!contract?.symbol) return null;
  return {
    providerId: "ibkr",
    brokerInstanceId,
    symbol: contract.localSymbol || contract.symbol,
    name: contract.description || contract.symbol,
    exchange: contract.primaryExch || contract.exchange || "",
    type: contract.secType || "",
    currency: contract.currency,
    primaryExchange: contract.primaryExch,
    brokerContract: contractToBrokerRef(contract, brokerInstanceId),
  };
}

export function contractDetailsToSearchResult(
  detail: ContractDetails,
  fallbackSymbol: string,
  brokerInstanceId: string | undefined,
): InstrumentSearchResult {
  const contract = detail.contract;
  return {
    providerId: "ibkr",
    brokerInstanceId,
    symbol: contract.localSymbol || contract.symbol || fallbackSymbol,
    name: detail.longName || detail.marketName || contract.description || contract.symbol || fallbackSymbol,
    exchange: contract.primaryExch || contract.exchange || "",
    type: contract.secType || "",
    currency: contract.currency,
    primaryExchange: contract.primaryExch,
    brokerContract: contractToBrokerRef(contract, brokerInstanceId),
  };
}

export function findExactSymbolMatch(
  results: InstrumentSearchResult[],
  ticker: string,
): InstrumentSearchResult | undefined {
  const upperTicker = ticker.toUpperCase();
  return results.find((result) => {
    const symbol = result.symbol.toUpperCase();
    return symbol === upperTicker || symbol === ticker;
  });
}

export function buildDirectContractCandidates(query: string): Contract[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const candidates: Contract[] = [];
  const optionLike = /^\S+\s+\d{6}[CP]\d{8}$/i.test(trimmed);

  if (optionLike) {
    candidates.push({
      localSymbol: trimmed,
      secType: SecType.OPT,
      exchange: "SMART",
    });
  }

  candidates.push({
    localSymbol: trimmed,
    exchange: "SMART",
  });

  return candidates;
}

export function buildFallbackStockContract(ticker: string, exchange: string): Contract {
  return {
    symbol: ticker,
    exchange: exchange || "SMART",
    currency: "USD",
    secType: SecType.STK,
  };
}

import type { Contract, ContractDetails, IBApiNext } from "@stoqey/ib";
import type { BrokerContractRef, InstrumentSearchResult } from "../../../types/instrument";
import {
  brokerRefToContract,
  buildDirectContractCandidates,
  buildFallbackStockContract,
  buildInstrumentSearchKey,
  contractDescriptionToSearchResult,
  contractDetailsToSearchResult,
  findExactSymbolMatch,
} from "./contracts";
import { IBKR_DATA_TIMEOUT, withTimeout } from "./timeouts";

export interface IbkrInstrumentLookupContext {
  api: IBApiNext;
  instanceId?: string;
}

export async function searchIbkrInstruments(
  context: IbkrInstrumentLookupContext,
  query: string,
): Promise<InstrumentSearchResult[]> {
  const [descriptions, directMatches] = await Promise.all([
    withTimeout(context.api.getMatchingSymbols(query), IBKR_DATA_TIMEOUT, "getMatchingSymbols").catch(() => []),
    withTimeout(getIbkrDirectContractMatches(context, query), IBKR_DATA_TIMEOUT, "getDirectContractMatches")
      .catch(() => [] as InstrumentSearchResult[]),
  ]);
  const merged = new Map<string, InstrumentSearchResult>();

  for (const result of descriptions
    .map((description) => contractDescriptionToSearchResult(description, context.instanceId))
    .filter((value): value is InstrumentSearchResult => value != null)) {
    merged.set(buildInstrumentSearchKey(result), result);
  }

  for (const result of directMatches) {
    merged.set(buildInstrumentSearchKey(result), result);
  }

  return [...merged.values()];
}

export async function resolveIbkrContract(
  context: IbkrInstrumentLookupContext,
  ticker: string,
  exchange: string,
  instrument: BrokerContractRef | null,
): Promise<Contract> {
  if (instrument) {
    if (instrument.conId) {
      return brokerRefToContract(instrument);
    }
    return getIbkrPrimaryContractDetails(context.api, brokerRefToContract(instrument))
      .then((detail) => detail.contract);
  }

  const directMatches = await withTimeout(
    getIbkrDirectContractMatches(context, ticker),
    IBKR_DATA_TIMEOUT,
    "getDirectContractMatches",
  );
  const direct = findExactSymbolMatch(directMatches, ticker);
  if (direct?.brokerContract) {
    return brokerRefToContract(direct.brokerContract);
  }

  const symbolResults = (await withTimeout(context.api.getMatchingSymbols(ticker), IBKR_DATA_TIMEOUT, "getMatchingSymbols"))
    .map((description) => contractDescriptionToSearchResult(description, context.instanceId))
    .filter((value): value is InstrumentSearchResult => value != null);
  const matched = findExactSymbolMatch(symbolResults, ticker);
  if (matched?.brokerContract) {
    return brokerRefToContract(matched.brokerContract);
  }

  const fallbackContract = buildFallbackStockContract(ticker, exchange);
  const details = await getIbkrPrimaryContractDetails(context.api, fallbackContract);
  return details.contract;
}

export async function getIbkrPrimaryContractDetails(
  api: IBApiNext,
  contract: Contract,
): Promise<ContractDetails> {
  const details = await withTimeout(api.getContractDetails(contract), IBKR_DATA_TIMEOUT, "getContractDetails");
  if (!details.length) {
    throw new Error(`Unable to resolve contract ${contract.symbol || contract.localSymbol || contract.conId}`);
  }
  return details[0]!;
}

async function getIbkrDirectContractMatches(
  context: IbkrInstrumentLookupContext,
  query: string,
): Promise<InstrumentSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const seen = new Set<string>();
  const results: InstrumentSearchResult[] = [];

  for (const candidate of buildDirectContractCandidates(trimmed)) {
    try {
      const details = await withTimeout(context.api.getContractDetails(candidate), IBKR_DATA_TIMEOUT, "getDirectContractDetails");
      for (const detail of details) {
        const result = contractDetailsToSearchResult(detail, trimmed, context.instanceId);
        const key = buildInstrumentSearchKey(result);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(result);
      }
    } catch {
      // Ignore exact-match lookup failures and fall back to symbol search.
    }
  }

  return results;
}

import { useMemo } from "react";
import { useOptionsQuery, useResolvedEntryValue } from "../../../../market-data/hooks";
import { formatMarketPriceWithCurrency } from "../../../../market-data/market/format";
import type { OptionContract } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { formatCompact, formatNumber } from "../../../../utils/format";
import { expiryIsoDate, formatDaysToExpiry } from "../../../../utils/option-expiry";
import { resolveOptionsTarget, type ResolvedOptionsTarget } from "../../../../utils/options";
import type { StatField } from "./types";

const contractKey = (symbol: string) => symbol.replace(/\s+/g, "").toUpperCase();

/**
 * An option contract's own row of its chain, the same query OMON reads: it
 * carries the open interest and implied volatility a contract quote leaves out.
 * Null for anything that is not an option, and until the chain answers.
 */
export function useOptionContractRow(ticker: TickerRecord | null | undefined): OptionContract | null {
  const target = resolveOptionsTarget(ticker);
  const option = target?.isOptionTicker && target.parsedOption ? target : null;
  const entry = useOptionsQuery(option ? {
    instrument: {
      symbol: option.effectiveTicker, exchange: option.effectiveExchange,
      brokerId: option.instrument?.brokerId, brokerInstanceId: option.instrument?.brokerInstanceId, instrument: option.instrument,
    },
    expirationDate: option.parsedOption!.expTs,
  } : null);
  const chain = useResolvedEntryValue(entry);
  const symbol = ticker?.metadata.ticker;
  return useMemo(() => {
    if (!chain || !symbol || !option) return null;
    const key = contractKey(symbol);
    return [...chain.calls, ...chain.puts].find((contract) => contractKey(contract.contractSymbol) === key) ?? null;
  }, [chain, option !== null, symbol]);
}

/**
 * What a contract is, then what its market says about it: underlying, side,
 * strike, expiry and deliverable, with the open interest, implied volatility
 * and volume the broker's chain gives. A figure the broker leaves out is left out.
 */
export function optionContractFields(
  target: Pick<ResolvedOptionsTarget, "parsedOption" | "effectiveTicker" | "instrument"> | null,
  row: OptionContract | null,
  currency: string,
  now = Date.now(),
): StatField[] {
  const parsed = target?.parsedOption;
  if (!target || !parsed) return [];
  const fields: StatField[] = [
    { label: "Underlying", value: target.effectiveTicker },
    { label: "Type", value: parsed.side === "C" ? "Call" : "Put" },
    { label: "Strike", value: formatMarketPriceWithCurrency(parsed.strike, currency) },
    { label: "Expiry", value: expiryIsoDate(parsed.expTs), detail: formatDaysToExpiry(parsed.expTs, now) },
  ];
  const multiplier = Number(target.instrument?.multiplier);
  if (Number.isFinite(multiplier) && multiplier > 0) fields.push({ label: "Multiplier", value: formatNumber(multiplier, 0) });
  if (row?.openInterest != null && Number.isFinite(row.openInterest)) fields.push({ label: "Open Int", value: formatCompact(row.openInterest) });
  if (Number.isFinite(row?.impliedVolatility) && row!.impliedVolatility > 0) {
    fields.push({ label: "Implied Vol", value: `${(row!.impliedVolatility * 100).toFixed(1)}%` });
  }
  if (row?.volume != null && Number.isFinite(row.volume)) fields.push({ label: "Volume", value: formatCompact(row.volume) });
  return fields;
}

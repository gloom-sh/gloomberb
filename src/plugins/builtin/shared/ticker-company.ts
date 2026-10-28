import { useCallback, useEffect, useRef, useState } from "react";
import { isNoSourceAnswer } from "../../../sources/provider-errors";
import type { DataProvider } from "../../../types/data-provider";
import { shortCompanyName } from "../../../tickers/company-name";
import { classifyInstrumentKind } from "../../../tickers/search/ranking";

/**
 * A search typed as a ticker (`TRIAL VKTX`, `FDA AZN`): one to five letters,
 * with a share class. Registries know companies by name, so a symbol no record
 * mentions is looked up as its company.
 */
export function looksLikeTicker(term: string): boolean {
  return /^[A-Za-z]{1,5}(?:[.-][A-Za-z])?$/.test(term.trim());
}

/**
 * The company a ticker is, by the name a registry files its records under:
 * VKTX is "Viking Therapeutics", AZN "AstraZeneca". Read from the listing's
 * quote, which names it; a fund or a contract is no company. Null when no
 * share trades under it. A quote that could not be read (unreachable, busy,
 * timed out) rejects: it says nothing about the company.
 */
export async function tickerCompanyName(dataProvider: Pick<DataProvider, "getQuote"> | null, ticker: string): Promise<string | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!dataProvider || !symbol) return null;
  const quote = await dataProvider.getQuote(symbol).catch((error: unknown) => {
    if (isNoSourceAnswer(error)) return null;
    throw error;
  });
  const name = quote?.name?.trim();
  const kind = classifyInstrumentKind(quote?.instrumentType);
  return name && kind !== "fund" && kind !== "derivative" ? shortCompanyName(name) : null;
}

export interface TickerCompanySearch {
  /** The company is being looked up: the pane shows it loading. */
  resolving: boolean;
  /** The lookup failed, for the pane's unavailable state; null otherwise. */
  error: string | null;
  /** Looks again after a failure: the pane's refresh calls it. */
  retry: () => void;
}

/**
 * A search for a ticker that found nothing is searched again as its company's
 * name: `onCompany` runs with it, once per `key` (the term as the pane compares
 * it). `eligible` is true once the search has finished empty and the term reads
 * as a ticker. A lookup that failed is no answer: it reports `error` until
 * `retry`, or until the term changes and comes back.
 */
export function useTickerCompanySearch(
  dataProvider: Pick<DataProvider, "getQuote"> | null,
  term: string,
  { eligible, key, onCompany }: { eligible: boolean; key: string; onCompany: (name: string) => void },
): TickerCompanySearch {
  const [looked, setLooked] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<string | null>(null);
  // A failure belongs to its term: another search clears it, so coming back looks again.
  if (failed !== null && failed !== key) setFailed(null);
  const onCompanyRef = useRef(onCompany);
  onCompanyRef.current = onCompany;
  const resolving = eligible && !looked.has(key) && failed !== key;
  useEffect(() => {
    if (!resolving) return;
    let live = true;
    tickerCompanyName(dataProvider, term).then((name) => {
      if (!live) return;
      setLooked((current) => new Set([...current, key]));
      if (name) onCompanyRef.current(name);
    }, () => {
      if (live) setFailed(key);
    });
    return () => { live = false; };
  }, [dataProvider, key, resolving, term]);
  const retry = useCallback(() => setFailed(null), []);
  return { resolving, error: eligible && failed === key ? `Couldn't look up ${term}'s company.` : null, retry };
}

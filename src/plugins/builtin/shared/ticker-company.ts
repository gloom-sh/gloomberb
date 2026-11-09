import { useCallback, useEffect, useRef, useState } from "react";
import { isNoSourceAnswer } from "../../../sources/provider-errors";
import type { DataProvider } from "../../../types/data-provider";
import type { CompanyProfile } from "../../../types/financials";
import { shortCompanyName } from "../../../tickers/company-name";
import { classifyInstrumentKind } from "../../../tickers/search/ranking";
import { logFailure } from "../../../utils/log-failure";

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

/** A company a ticker is, as a registry search reads it. */
export interface ListedCompany {
  /** Its name as the pane shows it: CorMedix. */
  name: string;
  /** Its name in full as its listing gives it: Merck & Co., Inc. and Merck KGaA are both "Merck" shortened. */
  legalName: string;
  /** A drug, biotech, device or health services company, the kind that sponsors trials. */
  healthcare: boolean;
}

/** SEC codes of drug makers (2833-2836), lab and medical instruments (3826, 3841-3845, 3851), drug wholesale (5122), health services (8000-8099) and biological research (8731). */
function healthcareSic(sic: string | undefined): boolean {
  const code = Number(sic);
  if (!Number.isInteger(code)) return false;
  return (code >= 2833 && code <= 2836) || code === 3826 || (code >= 3841 && code <= 3845) || code === 3851
    || code === 5122 || (code >= 8000 && code <= 8099) || code === 8731;
}

/** Words of a drug or device maker's name, for a listing whose profile was not read. */
const HEALTHCARE_NAME = /\b(?:therapeutics|pharma\w*|bio\w*|medic\w*|oncology|genomics|health\w*|clinical|vaccines?|diagnostics|surgical|dental)\b/i;

/**
 * Whether a listing is a healthcare company: its sector (Healthcare), its
 * industry (Biotechnology, Drug Manufacturers, Medical Devices), its SEC code,
 * and with no profile its name. AMD, Morgan Stanley, Home Depot, CF Industries
 * and PagerDuty are not, so `TRIAL AMD` is the eye disease.
 */
export function isHealthcareCompany(profile: Pick<CompanyProfile, "sector" | "industry" | "sic"> | null | undefined, name: string): boolean {
  if (/health/i.test(profile?.sector ?? "")) return true;
  if (/biotech|pharma|drug|medical|diagnost|health|life sciences/i.test(profile?.industry ?? "")) return true;
  if (healthcareSic(profile?.sic)) return true;
  if (profile?.sector?.trim() || profile?.industry?.trim()) return false;
  return HEALTHCARE_NAME.test(name);
}

/**
 * The company a ticker is, with whether it is a healthcare company: the
 * quote names it (tickerCompanyName), its profile says what it does. A profile
 * that could not be read leaves the name to tell. Null when no company trades
 * under it; a quote that could not be read rejects.
 */
async function tickerListedCompany(
  dataProvider: Pick<DataProvider, "getQuote" | "getTickerFinancials"> | null,
  ticker: string,
): Promise<ListedCompany | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!dataProvider || !symbol) return null;
  const [quote, financials] = await Promise.all([
    dataProvider.getQuote(symbol).catch((error: unknown) => {
      if (isNoSourceAnswer(error)) return null;
      throw error;
    }),
    // What it does is a detail: a profile that could not be read leaves the name to tell.
    Promise.resolve().then(() => dataProvider.getTickerFinancials(symbol, "")).catch(logFailure("ticker-company", `Read ${symbol}'s profile failed`, null)),
  ]);
  const legalName = quote?.name?.trim();
  const kind = classifyInstrumentKind(quote?.instrumentType);
  if (!legalName || kind === "fund" || kind === "derivative") return null;
  return { name: shortCompanyName(legalName), legalName, healthcare: isHealthcareCompany(financials?.profile, legalName) };
}

export interface TickerCompany {
  /** The company; null when no company trades under the term; undefined until looked up. */
  company: ListedCompany | null | undefined;
  /** The company is being looked up: the pane shows it loading. */
  resolving: boolean;
  /** The lookup failed, for the pane's unavailable state; null otherwise. */
  error: string | null;
  /** Looks again after a failure: the pane's refresh calls it. */
  retry: () => void;
}

/**
 * The company a term written as a ticker is (`TRIAL CRMD` is CorMedix), once
 * `eligible`, looked up once per `key` (the term as the pane compares it) and
 * kept: the answer stands while the pane shows that term, whatever made it
 * eligible. A lookup that failed is no answer: it reports `error` until
 * `retry`, or until the term changes and comes back.
 */
export function useTickerCompany(
  dataProvider: Pick<DataProvider, "getQuote" | "getTickerFinancials"> | null,
  term: string,
  { eligible, key }: { eligible: boolean; key: string },
): TickerCompany {
  const [answers, setAnswers] = useState<ReadonlyMap<string, ListedCompany | null>>(() => new Map());
  const [failed, setFailed] = useState<string | null>(null);
  // A failure belongs to its term: another search clears it, so coming back looks again.
  if (failed !== null && failed !== key) setFailed(null);
  const known = answers.has(key);
  const resolving = eligible && !known && failed !== key;
  useEffect(() => {
    if (!resolving) return;
    let live = true;
    tickerListedCompany(dataProvider, term).then((company) => {
      if (live) setAnswers((current) => new Map(current).set(key, company));
    }, () => {
      if (live) setFailed(key);
    });
    return () => { live = false; };
  }, [dataProvider, key, resolving, term]);
  const retry = useCallback(() => setFailed(null), []);
  return {
    company: known ? answers.get(key) ?? null : undefined,
    resolving,
    error: eligible && failed === key ? `Couldn't look up ${term}'s company.` : null,
    retry,
  };
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

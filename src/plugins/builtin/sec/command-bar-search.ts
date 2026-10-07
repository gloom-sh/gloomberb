import { useEffect, useState } from "react";
import { getSharedMarketDataCoordinator, type MarketDataCoordinator } from "../../../market-data/coordinator";
import type { SecFilingItem } from "../../../types/data-provider";
import type {
  CommandBarResultDef,
  CommandBarSearchProvider,
  GloomPluginContext,
} from "../../../types/plugin";
import { formatShortDate } from "../../../utils/datetime-format";
import { secFilingItemCodes } from "../../../utils/sec";
import { getFilingColumnText } from "./model";

const SEC_TEMPLATE_ID = "sec-pane";
const FILING_ROW_LIMIT = 4;
/**
 * The issuer's most recent filings, one page of Gloom Cloud's list. Enough to
 * reach the latest annual and quarterly reports of most companies; an issuer
 * that files hundreds of notes a month may not have its 10-K in it, and then
 * the lookup shows nothing rather than an older one. `SEC <ticker>` lists all.
 */
const RECENT_FILING_COUNT = 200;

const TICKER_TOKEN = /^[A-Z][A-Z0-9.-]{0,5}$/;
const FORM_TOKEN = /^(10-?K|10-?Q|8-?K|20-?F|40-?F|6-?K|S-?1|DEF14A)(\/A)?$/;
const FILING_WORDS = new Set(["FILING", "FILINGS", "EDGAR"]);
/** What a lookup without a form lists: the reports people open, not the ownership and sale notices around them. */
const NARRATIVE_FORMS = ["10-K", "10-Q", "8-K", "20-F", "40-F", "6-K", "S-1", "DEF 14A"];

export interface FilingLookup {
  ticker: string;
  /** The form asked for ("10-K"); null lists the narrative forms. */
  form: string | null;
}

function compactForm(form: string): string {
  return form.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function canonicalForm(token: string): string {
  const compact = compactForm(token);
  return NARRATIVE_FORMS.find((form) => compactForm(form) === compact) ?? token;
}

/**
 * A query that asks for an issuer's filings: one ticker plus a form or the word
 * filings ("AAPL 10-K", "10-q msft", "nvda filings"). A bare ticker is not
 * one; it would ask for every issuer anyone types.
 */
export function parseFilingLookup(query: string): FilingLookup | null {
  const tokens = query.trim().toUpperCase().replace(/\bDEF\s+14A\b/g, "DEF14A").split(/\s+/).filter(Boolean);
  let form: string | null = null;
  let asked = false;
  const tickers: string[] = [];
  for (const token of tokens) {
    const formMatch = FORM_TOKEN.exec(token);
    if (formMatch) {
      if (form) return null;
      form = canonicalForm(formMatch[1]!);
      asked = true;
    } else if (FILING_WORDS.has(token)) {
      asked = true;
    } else if (TICKER_TOKEN.test(token)) {
      tickers.push(token);
    } else {
      return null;
    }
  }
  if (!asked || tickers.length !== 1) return null;
  return { ticker: tickers[0]!, form };
}

/** A filing restored from the on-disk cache carries its date as the JSON string. */
function filedAt(filing: SecFilingItem): Date {
  return filing.filingDate instanceof Date ? filing.filingDate : new Date(String(filing.filingDate));
}

/** The filings a lookup lists, newest first. A form matches its amendments (10-K/A). */
export function selectLookupFilings(
  filings: readonly SecFilingItem[],
  lookup: FilingLookup,
  limit = FILING_ROW_LIMIT,
): SecFilingItem[] {
  const wanted = (lookup.form ? [lookup.form] : NARRATIVE_FORMS).map(compactForm);
  return filings
    .filter((filing) => {
      const form = compactForm(filing.form);
      return wanted.some((target) => form === target || form === `${target}A`);
    })
    .sort((left, right) => filedAt(right).getTime() - filedAt(left).getTime())
    .slice(0, limit);
}

type FocusListener = (accessionNumber: string) => void;
interface FocusRequest {
  accessionNumber: string;
  at: number;
  /** Views told when the request was made; they must not take the copy left for the pane being created. */
  told: Set<object>;
}
/** Long enough for the pane created for the request to mount; a stale one is dropped. */
const PENDING_FOCUS_MS = 15_000;
const pendingFocus = new Map<string, FocusRequest>();
const focusListeners = new Map<string, Map<object, FocusListener>>();

/**
 * Names the filing the SEC pane about to open for `symbol` should show. Pane
 * creation is async and may reuse an open pane, so views already on the
 * symbol are told at once and the request also waits briefly for the pane
 * being created. Another view on the same symbol (a Ticker Research tab)
 * cannot take it away from that pane.
 */
function requestSecFilingFocus(symbol: string, accessionNumber: string): void {
  const key = symbol.toUpperCase();
  const listeners = focusListeners.get(key) ?? new Map<object, FocusListener>();
  pendingFocus.set(key, { accessionNumber, at: Date.now(), told: new Set(listeners.keys()) });
  for (const listener of listeners.values()) listener(accessionNumber);
}

export function useSecFilingFocusRequest(symbol: string | null | undefined, onFocus: FocusListener): void {
  const [view] = useState(() => ({}));
  useEffect(() => {
    if (!symbol) return;
    const key = symbol.toUpperCase();
    const listeners = focusListeners.get(key) ?? new Map<object, FocusListener>();
    listeners.set(view, onFocus);
    focusListeners.set(key, listeners);
    const pending = pendingFocus.get(key);
    if (pending && !pending.told.has(view)) {
      pendingFocus.delete(key);
      if (Date.now() - pending.at < PENDING_FOCUS_MS) onFocus(pending.accessionNumber);
    }
    return () => {
      listeners.delete(view);
      if (listeners.size === 0) focusListeners.delete(key);
    };
  }, [onFocus, symbol, view]);
}

export function resetSecFilingFocusRequests(): void {
  pendingFocus.clear();
  focusListeners.clear();
}

interface FilingSearchDeps {
  getCoordinator(): Pick<MarketDataCoordinator, "loadSecFilings"> | null;
  now(): number;
}

const defaultDeps: FilingSearchDeps = {
  getCoordinator: getSharedMarketDataCoordinator,
  now: Date.now,
};

/** As the Documents rows date a filing: "Sep 3" this year, "Oct 2025" before. */
function filingDateLabel(date: Date, now: number): string {
  if (date.getUTCFullYear() === new Date(now).getUTCFullYear()) {
    return formatShortDate(date, { year: false, utc: true });
  }
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function filingRow(
  filing: SecFilingItem,
  ticker: string,
  ctx: Pick<GloomPluginContext, "createPaneFromTemplate">,
  now: number,
): CommandBarResultDef {
  const items = secFilingItemCodes(filing.items);
  return {
    id: filing.accessionNumber,
    label: [getFilingColumnText(filing), items ? `Items ${items}` : ""].filter(Boolean).join(" · "),
    detail: filing.companyName || ticker,
    badge: filing.form.replace(/\s+/g, "").slice(0, 6),
    right: filingDateLabel(filedAt(filing), now),
    keywords: [ticker, filing.form],
    execute: () => {
      requestSecFilingFocus(ticker, filing.accessionNumber);
      void ctx.createPaneFromTemplate(SEC_TEMPLATE_ID, { symbol: ticker });
    },
  };
}

/**
 * "AAPL 10-K" lists the issuer's latest matching filings from the same Gloom
 * Cloud SEC list the SEC pane reads, through the shared cache, and opens the
 * chosen one in that pane. An unknown ticker or a failed request adds no rows.
 */
export function createSecFilingSearchProvider(
  ctx: Pick<GloomPluginContext, "createPaneFromTemplate">,
  deps: FilingSearchDeps = defaultDeps,
): CommandBarSearchProvider {
  return {
    id: "sec:filings",
    category: "Filings",
    // Between the News (190) and Documents (200) sections the corpus search adds.
    priority: 195,
    minQueryLength: 4,
    async provide(query, _context, signal): Promise<CommandBarResultDef[]> {
      const lookup = parseFilingLookup(query);
      const coordinator = deps.getCoordinator();
      if (!lookup || !coordinator) return [];
      let filings: SecFilingItem[];
      try {
        const entry = await coordinator.loadSecFilings({
          instrument: { symbol: lookup.ticker },
          count: RECENT_FILING_COUNT,
        });
        filings = entry.data ?? entry.lastGoodData ?? [];
      } catch {
        return [];
      }
      if (signal.aborted) return [];
      const now = deps.now();
      return selectLookupFilings(filings, lookup).map((filing) => filingRow(filing, lookup.ticker, ctx, now));
    },
  };
}

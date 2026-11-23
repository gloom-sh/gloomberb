import type { CloudAccountPlan } from "../../api-client";
import type { PlanAccess } from "../../api-client/plan-rules";
import { kindFromListingSyntax, resolveTickerInstrumentKind } from "../../tickers/instrument-kind";
import type { AppConfig } from "../../types/config";
import type { TickerInstrumentKind } from "../../types/instrument";
import type { TickerRecord } from "../../types/ticker";
import { trackedListings } from "../since-last-visit/model";

/**
 * The row someone new to Pro sees, from the first day of their trial through
 * two weeks after their first charge: a few Pro functions they have not
 * opened yet, each on one of their own tickers. The trial is the week that
 * decides whether Pro is kept, so the row is there from its first day.
 * Everything it reads is already on this machine (the command bar's recent
 * runs, the layouts, the portfolios, watchlists and recently viewed tickers)
 * except the first charge's date, which the account's own plan answer
 * carries. Nothing about it is kept per account or sent anywhere.
 */

const DAY_MS = 86_400_000;
/** Days after the first paid charge the row may show: day 0 (the charge) through this one. */
const PRO_WELCOME_LAST_DAY = 14;
/** Fewer unopened functions than this and the row has nothing worth a row. */
const MIN_FUNCTIONS = 2;
const MAX_FUNCTIONS = 3;

/** A Pro function the row can name: its command, what it is, and the tickers it has data for. */
export interface ProWelcomeFunction {
  templateId: string;
  /** The command bar's mnemonic (`CALLS`), which the button's tooltip teaches. */
  shortcut: string;
  /** What it is, ahead of the ticker: "Earnings calls" AAPL. */
  label: string;
  kinds: readonly TickerInstrumentKind[];
}

/**
 * Pro's functions that open on a ticker, in the order the upgrade sheet
 * sells them: earnings calls, then options flow and X, then the rest.
 */
const PRO_WELCOME_FUNCTIONS: readonly ProWelcomeFunction[] = [
  { templateId: "earnings-calls-pane", shortcut: "CALLS", label: "Earnings calls", kinds: ["equity"] },
  { templateId: "scanner-flow-pane", shortcut: "FLOW", label: "Options flow", kinds: ["equity", "fund"] },
  { templateId: "social-mentions-pane", shortcut: "BUZZ", label: "X mentions", kinds: ["equity", "fund", "crypto"] },
  { templateId: "jobs-pane", shortcut: "JOBS", label: "Hiring", kinds: ["equity"] },
  { templateId: "filing-events-pane", shortcut: "EK", label: "8-K events", kinds: ["equity"] },
  { templateId: "risk-factors-pane", shortcut: "RISK", label: "Risk factors", kinds: ["equity"] },
];

/** One button on the row: a function on one of the user's tickers. */
export interface ProWelcomeChip {
  fn: ProWelcomeFunction;
  symbol: string;
  /** The saved ticker, when the symbol is one; the pane opens on it. */
  ticker: TickerRecord | null;
}

export interface ProWelcomeEligibility {
  access: Pick<PlanAccess, "isPayingPro" | "isTrialActive">;
  /** The account's plan answer; null until it came. */
  plan: Pick<CloudAccountPlan, "firstChargeAt" | "proTeam"> | null;
  /** Dismissed for good on this machine. */
  dismissed: boolean;
  now: number;
}

/**
 * Someone on a trial of their own Pro plan, every day of it, and a payer of
 * their own plan from the day of their first paid charge through day 14. Not
 * with Pro through a team seat, not once dismissed, and for a payer not when
 * the server gave no first charge.
 */
export function proWelcomeEligible({ access, plan, dismissed, now }: ProWelcomeEligibility): boolean {
  if (dismissed || !plan || plan.proTeam) return false;
  if (access.isTrialActive) return true;
  if (!access.isPayingPro) return false;
  const firstCharge = Date.parse(plan.firstChargeAt ?? "");
  if (!Number.isFinite(firstCharge)) return false;
  // A charge a moment ahead of this machine's clock is today's.
  const day = Math.floor(Math.max(0, now - firstCharge) / DAY_MS);
  return day <= PRO_WELCOME_LAST_DAY;
}

type LayoutsConfig = Pick<AppConfig, "layout" | "layouts" | "recentCommands">;

/**
 * The pane templates this machine shows the user opened: run from the
 * command bar lately, or open in a layout (saved ones too).
 */
export function openedFunctions(
  config: LayoutsConfig,
  paneIdOf: (templateId: string) => string | null,
  functions: readonly ProWelcomeFunction[] = PRO_WELCOME_FUNCTIONS,
): Set<string> {
  const paneIds = new Set<string>();
  for (const layout of [config.layout, ...config.layouts.map((saved) => saved.layout)]) {
    for (const instance of layout?.instances ?? []) paneIds.add(instance.paneId);
  }
  const ran = new Set((config.recentCommands ?? []).map((command) => command.id));
  const opened = new Set<string>();
  for (const fn of functions) {
    const paneId = paneIdOf(fn.templateId);
    if (ran.has(`pane-template:${fn.templateId}`) || (paneId && paneIds.has(paneId))) opened.add(fn.templateId);
  }
  return opened;
}

interface OwnTicker {
  symbol: string;
  ticker: TickerRecord | null;
  kind: TickerInstrumentKind;
}

/**
 * The user's own tickers, best first: holdings, then watchlists (team
 * collections and imported portfolios are not their own), and with none of
 * those the tickers they viewed most recently.
 */
export function ownTickers(
  config: Pick<AppConfig, "portfolios" | "watchlists">,
  tickers: ReadonlyMap<string, TickerRecord>,
  recentTickers: readonly string[],
): OwnTicker[] {
  const tracked = trackedListings(config, tickers).map(({ symbol }) => symbol);
  const symbols = tracked.length > 0 ? tracked : recentTickers;
  const seen = new Set<string>();
  const own: OwnTicker[] = [];
  for (const symbol of symbols) {
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    const ticker = tickers.get(symbol) ?? null;
    const kind = ticker ? resolveTickerInstrumentKind(ticker) : kindFromListingSyntax(symbol) ?? "equity";
    own.push({ symbol, ticker, kind });
  }
  return own;
}

/**
 * Two or three functions the user has not opened, each on one of their own
 * tickers it has data for, a different one each while there are enough;
 * empty when fewer than two can be named. `available` leaves out a function
 * whose plugin is off or missing.
 */
export function pickProWelcomeChips(
  own: readonly OwnTicker[],
  opened: ReadonlySet<string>,
  available: (templateId: string) => boolean,
  functions: readonly ProWelcomeFunction[] = PRO_WELCOME_FUNCTIONS,
): ProWelcomeChip[] {
  const chips: ProWelcomeChip[] = [];
  const used = new Set<string>();
  for (const fn of functions) {
    if (chips.length >= MAX_FUNCTIONS) break;
    if (opened.has(fn.templateId) || !available(fn.templateId)) continue;
    const fits = own.filter((entry) => fn.kinds.includes(entry.kind));
    const pick = fits.find((entry) => !used.has(entry.symbol)) ?? fits[0];
    if (!pick) continue;
    used.add(pick.symbol);
    chips.push({ fn, symbol: pick.symbol, ticker: pick.ticker });
  }
  return chips.length >= MIN_FUNCTIONS ? chips : [];
}

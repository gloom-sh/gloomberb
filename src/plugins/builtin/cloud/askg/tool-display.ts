import type { ASKGToolRow } from "./model";
import { SCRIPT_TOOL_NAME, type JsonValue } from "./protocol";

/**
 * How a tool call reads in the timeline. A note is written for Gloom as much
 * as for the person reading, so it can name a metadata field, paste a server
 * error or list every symbol it skipped. The row says what happened in plain
 * words, once: a quiet mark, what was read, how much came back, and at most
 * one short line about what is missing. Everything else waits in the detail.
 */

/** The state a row's mark shows. `partial` reads like `ok`: it is a result. */
export type ToolMark = "running" | "waiting" | "ok" | "partial" | "failed" | "stopped" | "declined";

export interface ToolRowView {
  /** What the tool is, in words: "Holdings", "Yield curve". */
  title: string;
  /** What it was about: a portfolio's name, a symbol, a search. Empty when nothing. */
  subject: string;
  /** Result size and duration, "94 rows · 1.2 s". */
  meta: string;
  mark: ToolMark;
  /** At most one short line under the row: the main gap in a partial result, or why it failed. */
  line: string | null;
  /** The full story, for the expanded row. */
  details: string[];
  /** The call's arguments as readable pairs, for the expanded row. */
  arguments: Array<{ label: string; value: string }>;
}

export interface ToolDisplayContext {
  /** Display name of a portfolio or watchlist id, when the profile has it. */
  collectionName?(id: string): string | null;
  /** Name of the pane a client tool reads from. */
  toolTitle?(name: string): string | null;
}

/**
 * Names for the tools the platform runs. A tool missing here still reads as
 * words: `perps.history` becomes "Perps history".
 */
const TOOL_TITLES: Record<string, string> = {
  pf: "Holdings",
  port: "Portfolio risk",
  mars: "Market risk",
  "app.get_resource": "App state",
  "market.quotes": "Quotes",
  "market.history": "Price history",
  "market.search": "Instrument search",
  "market.screener": "Market movers",
  "market.options_chain": "Options chain",
  "market.options_flow": "Options flow",
  "market.short_interest": "Short interest",
  "market.attention": "Research attention",
  "market.hiring_movers": "Hiring movers",
  "company.profile": "Company profile",
  "company.statements": "Financial statements",
  "company.financials": "Financials",
  "company.holders": "Holders",
  "company.analyst_research": "Analyst research",
  "company.corporate_actions": "Corporate actions",
  "company.awards": "Government awards",
  "company.award_evidence": "Award evidence",
  "company.hiring": "Hiring",
  "sec.filings": "SEC filings",
  "sec.insider_transactions": "Insider trades",
  "sec.thirteenf_crowding": "13F crowding",
  "sec.thirteenf_holders": "13F holders",
  "macro.calendar": "Economic calendar",
  "macro.series": "Economic data",
  "macro.yield_curve": "Yield curve",
  "news.stories": "News",
  "social.ticker_posts": "Social posts",
  "social.search_posts": "Social search",
  "portfolio.exposure": "Scenario exposure",
  "equity.diagnostic": "Equity diagnostic",
  "hiring.momentum": "Hiring momentum",
  "apps.rank_history": "App rankings",
  "apps.attention": "App attention",
  [SCRIPT_TOOL_NAME]: "Script",
};

/** What `app.get_resource` read, in words. */
const RESOURCE_SUBJECTS: Record<string, string> = {
  "app://accounts": "broker accounts",
  "app://snapshot": "your layout",
  "app://panes": "open panes",
  "app://config": "settings",
  "app://layout/current": "your layout",
  "app://layouts": "saved layouts",
  "app://auth": "your account",
};

/** Arguments that pick the subject; every other one is a detail. */
const SUBJECT_KEYS = ["symbol", "symbols", "text", "query", "paneId", "resource", "portfolioId", "collectionId"];
/** Options that say which view was read, worth a word next to the subject. */
const QUALIFIER_KEYS = ["view", "range", "period", "component", "series"];

function sentenceCase(text: string): string {
  const spaced = text.replace(/[_.-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
  if (!spaced) return "";
  return spaced[0]!.toUpperCase() + spaced.slice(1).toLowerCase();
}

export function toolTitle(name: string, context: ToolDisplayContext = {}): string {
  const known = TOOL_TITLES[name];
  if (known) return known;
  const fromPane = context.toolTitle?.(name)?.replace(/\s+Pane$/i, "").trim();
  if (fromPane) return fromPane;
  // A remote operation reads as its action: "pane.show" is "Show pane".
  const [scope, action] = name.split(".", 2);
  if (scope && action) return sentenceCase(`${action} ${scope}`);
  return name.length <= 5 ? name.toUpperCase() : sentenceCase(name);
}

function scalarText(value: JsonValue | undefined): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(scalarText).filter(Boolean).join(", ");
  return "";
}

/** "NVDA", "NVDA, AMD and 3 more". */
function symbolList(value: JsonValue | undefined): string {
  const symbols = Array.isArray(value)
    ? value.map(scalarText).filter(Boolean)
    : scalarText(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  if (symbols.length <= 3) return symbols.join(", ");
  return `${symbols.slice(0, 2).join(", ")} and ${symbols.length - 2} more`;
}

/** A broker portfolio id ("broker:ibkr-main:U1234567") as the account it names. */
function readableId(id: string): string {
  const broker = /^broker:[^:]+:(.+)$/.exec(id);
  return broker ? broker[1]! : id;
}

function subjectFromArgs(args: Record<string, JsonValue>, context: ToolDisplayContext): string {
  for (const key of SUBJECT_KEYS) {
    const value = args[key];
    if (value == null || value === "") continue;
    if (key === "symbol" || key === "symbols") return symbolList(value);
    const text = scalarText(value);
    if (!text) continue;
    if (key === "resource") return RESOURCE_SUBJECTS[text] ?? text.replace(/^[a-z]+:\/\//, "");
    if (key === "query") return `"${text}"`;
    if (key === "text" || key === "portfolioId" || key === "collectionId") {
      return context.collectionName?.(text) ?? readableId(text);
    }
    return text;
  }
  return "";
}

function qualifierFromArgs(args: Record<string, JsonValue>): string {
  for (const key of QUALIFIER_KEYS) {
    const text = scalarText(args[key]);
    if (text) return text;
  }
  return "";
}

/** The options the row line leaves out, "equity shift: -10". The subject is already on the line. */
function argumentPairs(args: Record<string, JsonValue> | undefined) {
  if (!args) return [];
  const shown = new Set([...SUBJECT_KEYS, QUALIFIER_KEYS.find((key) => scalarText(args[key])) ?? ""]);
  return Object.keys(args).sort().flatMap((key) => {
    if (shown.has(key)) return [];
    const value = scalarText(args[key]);
    return value ? [{ label: sentenceCase(key).toLowerCase(), value }] : [];
  });
}

/** "340 ms", "1.2 s", "1 min 4 s". */
function formatToolDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1_000) return `${Math.max(1, Math.round(ms / 10) * 10)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1_000)} s`;
}

function countText(count: number | undefined): string {
  if (count === undefined) return "";
  return `${count.toLocaleString("en-US")} ${count === 1 ? "row" : "rows"}`;
}

// --- Notes -----------------------------------------------------------------

/** Words Gloom needs and the reader does not: field paths and pointers for the model. */
const INTERNAL_CLAUSE = /\bmetadata\.[a-z_]+|\blists each with its reason\b|\bsee (?:the )?(?:result|payload|rows)\b/i;
/** A service the app already worked around. Never a warning, only a detail. */
const SERVICE_FAILURE = /internal server error|server error|bad gateway|service unavailable|gateway time-?out|\b(?:http|status)\s*\d{3}\b|\b50[0-9]\b|econn\w+|etimedout|fetch failed|network error|socket hang up|too many requests|rate.?limit|request failed|unexpected token|not valid json|cannot read propert|is not a function|undefined is not/i;
/** What the client did to fit the result through the wire. Gloom's business. */
const TRANSPORT_CLAUSE = /^(?:trimmed to fit|result exceeded the client payload limit|result was too large)/i;
/** Text that is not for people: payloads, identifiers, URIs, stack frames. */
const RAW_TEXT = /[{}[\]<>`]|\b[a-z]+:\/\/|\b[a-z]+_[a-z_]+\b|\b[a-z]+\.[a-z_]{2,}\b|\b[a-z]+[A-Z][a-zA-Z]+\b|\bat \S+:\d+|^\s*error:|"[a-z_.]+"/;

/** Splits a note on the separators `summarizeToolWarnings` joins with, outside parentheses. */
function noteClauses(note: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let current = "";
  for (let index = 0; index < note.length; index += 1) {
    const character = note[index]!;
    if (character === "(") depth += 1;
    if (character === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && character === ";") {
      clauses.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  clauses.push(current);
  return clauses
    .map((clause) => clause.trim().replace(/[.\s]+$/, ""))
    .filter((clause) => clause && !/^and \d+ more$/i.test(clause));
}

function listedItems(list: string): string[] {
  return list
    .replace(/\s+and\s+(\d+)\s+more$/i, (_match, more: string) => `, +${more}`)
    .split(/\s*,\s*/)
    .filter(Boolean);
}

function countListed(list: string): number {
  return listedItems(list).reduce((count, item) => {
    const more = /^\+(\d+)$/.exec(item);
    return count + (more ? Number(more[1]) : 1);
  }, 0);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

interface NoteReading {
  /** The candidate for the one line, best first. */
  headline: string | null;
  details: string[];
}

/**
 * Reads one clause. Known shapes become a counted sentence; a server failure
 * becomes "X unavailable"; anything internal is dropped; the rest is kept as
 * written when it is plain text.
 */
function readClause(clause: string, rowCount: number | undefined): { headline?: string; detail?: string } {
  if (INTERNAL_CLAUSE.test(clause) || TRANSPORT_CLAUSE.test(clause)) return {};

  const unpriced = /^No (?:market value|price|current quote)(?: or P&L)? for (.+?)(?:,? (?:so )?totals and weights leave them out)?$/i.exec(clause);
  if (unpriced) {
    const count = countListed(unpriced[1]!);
    const of = rowCount !== undefined && rowCount >= count ? ` of ${rowCount.toLocaleString("en-US")}` : "";
    return {
      headline: `${count}${of} positions had no price`,
      detail: `No price for ${unpriced[1]}, so totals leave ${count === 1 ? "it" : "them"} out`,
    };
  }

  const coverage = /^Basket covers (at most )?(\d+(?:\.\d+)?%) of market value(?: · (\d+) holdings? left out)?(?: · (.+))?$/i.exec(clause);
  if (coverage) {
    const share = `${coverage[1] ? "up to " : ""}${coverage[2]}`;
    const leftOut = coverage[3] ? ` · ${plural(Number(coverage[3]), "holding")} left out` : "";
    const sentence = `Risk covers ${share} of the portfolio's value${leftOut}`;
    return { headline: sentence, detail: coverage[4] ? `${sentence}; ${coverage[4]}` : sentence };
  }
  if (/^Basket estimates unavailable/i.test(clause)) {
    return { headline: "Too few holdings qualify for a risk estimate", detail: clause.replace(/^Basket estimates unavailable:\s*/i, "") };
  }

  const subject = /^([^:]{1,40}):\s+(.+)$/.exec(clause);
  if (subject && SERVICE_FAILURE.test(subject[2]!)) return { detail: `${subject[1]} unavailable` };
  if (SERVICE_FAILURE.test(clause)) return { detail: "Some data was unavailable" };
  if (subject && /unavailable$/i.test(subject[2]!) && !RAW_TEXT.test(subject[1]!)) {
    return { detail: `${subject[2]!.replace(/\s+unavailable$/i, "")} unavailable for ${subject[1]}` };
  }
  if (RAW_TEXT.test(clause)) return { detail: "Some data could not be read" };

  const grouped = /^(.+?) \(([^()]+)\)$/.exec(clause);
  if (grouped) {
    const count = countListed(grouped[2]!);
    return { detail: `${grouped[1]}: ${listedItems(grouped[2]!).join(", ").replace(/, \+(\d+)$/, " and $1 more")}`, ...(count > 0 ? { headline: `${grouped[1]} (${plural(count, "symbol")})` } : {}) };
  }
  return { headline: clause, detail: clause };
}

function readNote(note: string | undefined, rowCount: number | undefined): NoteReading {
  if (!note?.trim()) return { headline: null, details: [] };
  const headlines: string[] = [];
  const details: string[] = [];
  for (const clause of noteClauses(note)) {
    // The unpriced sentence already says what totals do without them.
    if (/^totals and weights leave (?:it|them) out$/i.test(clause)) continue;
    // A clause in lower case finishes the one before it ("weighted at the latest close").
    if (/^[a-z]/.test(clause) && details.length > 0 && !INTERNAL_CLAUSE.test(clause) && !RAW_TEXT.test(clause)) {
      details[details.length - 1] = `${details[details.length - 1]}, ${clause}`;
      continue;
    }
    const { headline, detail } = readClause(clause, rowCount);
    if (headline) headlines.push(headline);
    if (detail && !details.includes(detail)) details.push(detail);
  }
  // A counted gap ("3 of 94 positions had no price") says the most in the fewest words.
  const counted = headlines.find((line) => /^\d|covers|qualify/i.test(line));
  return { headline: counted ?? headlines[0] ?? null, details };
}

/** Why a call failed, in one line a person can read. */
function failureLine(row: ASKGToolRow): string {
  const note = row.note?.trim() ?? "";
  switch (row.status) {
    case "timeout":
      return /answered without it/i.test(note) ? "Took too long, so Gloom answered without it" : "Took too long to answer";
    case "cancelled":
      return "Stopped";
    case "denied":
      if (/declined/i.test(note)) return "You declined this";
      if (/confirmation/i.test(note)) return "Needs your approval";
      return "Not available in this window";
    default: {
      if (!note) return "Could not load this";
      const clauses = noteClauses(note);
      const first = clauses[0] ?? "";
      if (/could not send this result|no longer has this tool call|too large to send/i.test(first)) return first;
      if (SERVICE_FAILURE.test(first) || RAW_TEXT.test(first) || INTERNAL_CLAUSE.test(first) || first.length > 140) {
        return "Could not load this";
      }
      return first;
    }
  }
}

function markFor(row: ASKGToolRow): ToolMark {
  switch (row.status) {
    case "pending":
    case "running":
      return "running";
    case "awaiting-confirmation":
      return "waiting";
    case "ok":
      return "ok";
    case "partial":
      return "partial";
    case "cancelled":
      return "stopped";
    case "denied":
      return "declined";
    case "error":
    case "timeout":
      return "failed";
  }
}

export function isScriptRow(row: Pick<ASKGToolRow, "name" | "origin">): boolean {
  return row.origin === "server" && row.name === SCRIPT_TOOL_NAME;
}

export function describeToolRow(row: ASKGToolRow, context: ToolDisplayContext = {}): ToolRowView {
  const mark = markFor(row);
  const args = row.args ?? {};
  const script = isScriptRow(row);
  // A server tool's note is a caveat about its result, not what it read, so a
  // live server row has no subject; a stored one keeps its arguments.
  const subject = script ? "" : subjectFromArgs(args, context);
  const qualifier = script ? "" : qualifierFromArgs(args);
  const finished = mark !== "running" && mark !== "waiting";
  // A script counts calls in its note ("3 calls, 1.2 s"), not rows.
  const size = script || mark === "failed" || mark === "stopped" || mark === "declined" ? "" : countText(row.rowCount);
  const meta = finished ? [size, formatToolDuration(row.elapsedMs)].filter(Boolean).join(" · ") : "";

  const reading = mark === "partial" || mark === "ok" ? readNote(script ? undefined : row.note, row.rowCount) : null;
  const line = mark === "failed" || mark === "stopped" || mark === "declined"
    ? failureLine(row)
    : mark === "partial"
      ? reading?.headline ?? null
      : mark === "waiting"
        ? "Waiting for your approval"
        : null;
  const details = reading?.details.length
    ? reading.details
    : line && mark !== "waiting"
      ? [line]
      : [];
  if (row.truncated && mark !== "failed") details.push("Gloom read a shortened copy of this result");

  return {
    title: toolTitle(row.name, context),
    subject: [subject, qualifier].filter(Boolean).join(" · "),
    meta,
    mark,
    line,
    details,
    // A script's argument is its code, which is not a summary of anything.
    arguments: script ? [] : argumentPairs(row.args),
  };
}

export interface ToolGroupView {
  /** "Holdings, Portfolio risk and 3 more". */
  label: string;
  /** "6 calls · 6.3 s". */
  meta: string;
  failed: number;
  running: boolean;
}

/** One line for a turn's calls, for a turn with too many to list. */
export function describeToolGroup(rows: readonly ASKGToolRow[], context: ToolDisplayContext = {}): ToolGroupView {
  const calls = rows.filter((row) => !isScriptRow(row));
  const titles: string[] = [];
  for (const row of calls) {
    const title = toolTitle(row.name, context);
    if (!titles.includes(title)) titles.push(title);
  }
  const named = titles.slice(0, 2).join(", ");
  const label = titles.length > 2 ? `${named} and ${titles.length - 2} more` : named || "Tools";
  const script = rows.find(isScriptRow);
  const elapsed = script?.elapsedMs ?? calls.reduce((total, row) => total + (row.elapsedMs ?? 0), 0);
  const failed = calls.filter((row) => row.status === "error" || row.status === "timeout").length;
  const running = rows.some((row) => row.status === "pending" || row.status === "running" || row.status === "awaiting-confirmation");
  return {
    label,
    meta: [plural(calls.length, "call"), formatToolDuration(elapsed || undefined)].filter(Boolean).join(" · "),
    failed,
    running,
  };
}

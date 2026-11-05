import type { PaneFunctionCatalog } from "../../../../cli/pane-functions/catalog";
import { paneFunctionCode } from "../../../../cli/pane-functions/catalog";
import {
  findCapabilityOption,
  getHeadlessPaneDefinition,
  getPaneFunctionCapability,
  optionChoices,
  optionFlag,
  paneFunctionArgument,
  takesNoArgument,
} from "../../../../cli/pane-functions/capabilities";
import type { PaneDef, PaneTemplateDef } from "../../../../types/plugin";
import { isSourceRef, type ASKGToolRow, type ASKGTurn } from "./model";
import type { JsonValue } from "./protocol";
import { resolveRemoteToolBinding } from "./manifest";

/**
 * Where a figure in an answer came from, as the person can open it: the
 * function, what it was run on and the options it was run with. Opening it is
 * `fn` and `shot` with the same words, in a pane.
 */
export interface ASKGSourceCommand {
  /** The function's code as typed: `HP`. */
  code: string;
  /** Ticker, tickers (comma separated) or text, as the function takes it; empty for none. */
  arg: string;
  /** The function's own option keys and their values. */
  options: Record<string, string>;
}

/** `HP NVDA --range 6M`: the words `gloom fn` takes for it. */
export function formatSourceCommand(command: ASKGSourceCommand): string {
  const options = Object.entries(command.options).map(([key, value]) => (
    `${optionFlag(key)} ${/\s/.test(value) ? JSON.stringify(value) : value}`
  ));
  return [command.code, command.arg, ...options].filter(Boolean).join(" ");
}

function text(value: JsonValue | undefined): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function symbols(value: JsonValue | undefined): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const one = text(value);
  return one ? one.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

/** A symbol on the venue the call named, as the app writes a listing: `SAN:EPA`. */
function listing(symbol: string, exchange: JsonValue | undefined): string {
  const venue = text(exchange);
  return venue && !symbol.includes(":") ? `${symbol}:${venue}` : symbol;
}

function command(code: string, arg = "", options: Record<string, string | undefined> = {}): ASKGSourceCommand {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(options)) if (value) kept[key] = value;
  return { code, arg, options: kept };
}

/** A function run on the call's one ticker; none when the call named no ticker. */
function onTicker(code: string, key = "symbol", options?: (args: Record<string, JsonValue>) => Record<string, string | undefined>) {
  return (args: Record<string, JsonValue>): ASKGSourceCommand | null => {
    const symbol = text(args[key]);
    return symbol ? command(code, listing(symbol.toUpperCase(), args.exchange), options?.(args)) : null;
  };
}

/**
 * HP's window for a call that named no dates: the range whose bars are the
 * call's (5-minute bars are a day, hourly ones a week) and that holds as many
 * daily bars as it asked for.
 */
function historyRange(interval: string, points: number): string {
  if (/^\d+min$/.test(interval)) return "1D";
  if (/^\d+h$/.test(interval)) return "1W";
  if (interval === "1week") return "5Y";
  if (interval === "1month") return "ALL";
  if (points <= 23) return "1M";
  if (points <= 66) return "3M";
  if (points <= 130) return "6M";
  return points <= 260 ? "1Y" : "5Y";
}

const SCREENER_LISTS: Record<string, string> = { gainers: "gainers", losers: "losers", "most-active": "actives" };
const NEWS_FEEDS: Record<string, string> = { latest: "N", top: "TOP", breaking: "FIRST" };

type ServerToolSource = (args: Record<string, JsonValue>) => ASKGSourceCommand | null;

/**
 * The function that shows what each tool the platform runs reads. A tool
 * missing here, or a call these cannot place (a free-text search), has no
 * pane to open, and its source says so rather than pointing near it.
 */
const SERVER_TOOL_SOURCES: Record<string, ServerToolSource> = {
  "market.quotes": (args) => {
    const listed = symbols(args.symbols).map((symbol) => listing(symbol.toUpperCase(), args.exchange));
    return listed.length > 0 ? command("QQ", listed.join(",")) : null;
  },
  "market.history": (args) => {
    const symbol = text(args.symbol);
    if (!symbol) return null;
    const from = text(args.startDate);
    const to = text(args.endDate);
    const points = typeof args.limit === "number" ? args.limit : 120;
    return command("HP", listing(symbol.toUpperCase(), args.exchange), from
      ? { from, to }
      : { range: historyRange(text(args.interval) || "1day", points) });
  },
  "market.screener": (args) => {
    const list = SCREENER_LISTS[text(args.category)];
    return list ? command("MOST", "", { list }) : null;
  },
  "company.profile": onTicker("T"),
  "company.statements": onTicker("FA", "symbol", (args) => ({ period: text(args.period) === "quarterly" ? "quarterly" : undefined })),
  "company.financials": onTicker("FA"),
  "company.holders": onTicker("HDS"),
  "company.analyst_research": onTicker("ANR"),
  "company.corporate_actions": onTicker("EVT"),
  "market.options_chain": onTicker("OMON", "symbol", (args) => ({ expiration: text(args.expiration) || undefined })),
  "sec.filings": onTicker("SEC", "ticker"),
  "sec.insider_transactions": onTicker("INS", "ticker"),
  "sec.thirteenf_holders": onTicker("HDS", "ticker"),
  "macro.calendar": () => command("ECO"),
  "macro.series": (args) => {
    const series = text(args.seriesId).toUpperCase();
    return series ? command("G", `FRED:${series}`) : null;
  },
  "macro.yield_curve": () => command("GC"),
  "congress.house_trades": (args) => command("CG", text(args.ticker).toUpperCase(), { chamber: "house" }),
  "congress.senate_trades": (args) => command("CG", text(args.ticker).toUpperCase(), { chamber: "senate" }),
  "market.short_interest": onTicker("SI"),
  "market.options_flow": onTicker("FLOW"),
  "news.stories": (args) => {
    // A search or a topic reads stories no feed pane lists as such.
    if (text(args.query) || symbols(args.topics).length > 0) return null;
    const tickers = symbols(args.tickers);
    if (tickers.length === 1) return command("CN", tickers[0]!.toUpperCase());
    if (tickers.length > 1) return null;
    const feed = NEWS_FEEDS[text(args.feed) || "latest"];
    return feed ? command(feed) : null;
  },
  "social.ticker_posts": onTicker("BUZZ", "ticker"),
  "equity.diagnostic": onTicker("DIAG"),
  "company.hiring": onTicker("JOBS", "ticker"),
  "hiring.momentum": onTicker("HIRE"),
  "apps.attention": onTicker("APPS"),
};

/** The tool names the table above places, for the test that holds each to a real function. */
export const MAPPED_SERVER_TOOLS: readonly string[] = Object.keys(SERVER_TOOL_SOURCES);

/** The function a tool the platform ran shows its data in, or null when none does. */
export function serverToolCommand(name: string, args: Record<string, JsonValue>): ASKGSourceCommand | null {
  return SERVER_TOOL_SOURCES[name]?.(args) ?? null;
}

interface CatalogFunction {
  template?: PaneTemplateDef;
  pane: PaneDef;
}

/**
 * Functions by the names this client advertises them under: a template's
 * shortcut (or id) lowercased, else the pane's id (manifest.ts). Built once
 * per catalog, since every source of every answer asks.
 */
function functionsByToolName(catalog: PaneFunctionCatalog): Map<string, CatalogFunction> {
  const byName = new Map<string, CatalogFunction>();
  const templated = new Set<string>();
  for (const template of catalog.paneTemplates.values()) {
    const pane = catalog.panes.get(template.paneId);
    if (!pane) continue;
    templated.add(pane.id);
    const name = (template.shortcut?.prefix ?? template.id).toLowerCase();
    if (!byName.has(name)) byName.set(name, { template, pane });
  }
  for (const pane of catalog.panes.values()) {
    if (!templated.has(pane.id) && !byName.has(pane.id)) byName.set(pane.id, { pane });
  }
  return byName;
}

/** Functions by every code the app opens them by, upper case. */
function functionsByCode(catalog: PaneFunctionCatalog): Map<string, CatalogFunction> {
  const byCode = new Map<string, CatalogFunction>();
  for (const template of catalog.paneTemplates.values()) {
    const pane = catalog.panes.get(template.paneId);
    if (!pane) continue;
    for (const code of [template.shortcut?.prefix, ...template.shortcut?.aliases ?? []]) {
      const key = code?.trim().toUpperCase();
      if (key && !byCode.has(key)) byCode.set(key, { template, pane });
    }
  }
  return byCode;
}

/** Arguments a client tool takes as its function's argument; every other one is an option. */
const ARGUMENT_KEYS = new Set(["symbol", "symbols", "text"]);

function clientToolCommand(found: CatalogFunction, args: Record<string, JsonValue>): ASKGSourceCommand | null {
  const { template, pane } = found;
  const headless = getHeadlessPaneDefinition(template, pane);
  if (!headless) return null;
  const arg = headless.argument.kind === "ticker"
    ? text(args.symbol)
    : headless.argument.kind === "tickers" || headless.argument.kind === "symbol-list"
      ? symbols(args.symbols).join(",")
      : headless.argument.kind === "free-text"
        ? text(args.text)
        : "";
  const options: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (ARGUMENT_KEYS.has(key)) continue;
    const option = headless.options.find((entry) => entry.key === key);
    // The app ran no call with an option its function lacks.
    if (!option) return null;
    // Only what the pane draws: `--limit` cuts the rows a report reads, not what the pane shows.
    if (option.shot?.reportOnly) continue;
    const typed = text(value);
    if (typed) options[key] = typed;
  }
  return { code: paneFunctionCode(template, pane), arg, options };
}

/**
 * Whether the app opens this command as written: a function it has, an
 * argument it takes and only options it declares, with a value it lists. A
 * command that fails here is never drawn as a link.
 */
function checkCommand(found: CatalogFunction | undefined, source: ASKGSourceCommand): boolean {
  if (!found) return false;
  if (source.arg && takesNoArgument(paneFunctionArgument(found.template, found.pane))) return false;
  const capability = getPaneFunctionCapability(found.template, found.pane);
  return Object.entries(source.options).every(([key, value]) => {
    const option = findCapabilityOption(capability, key);
    if (!option) return false;
    const choices = optionChoices(option);
    if (option.type !== "enum" || choices.length === 0) return true;
    const wanted = value.toLowerCase();
    return choices.some((choice) => choice.toLowerCase() === wanted)
      || (option.values ?? []).some((entry) => entry.aliases?.some((alias) => alias.toLowerCase() === wanted));
  });
}

/** What a read opens, and what it is called, or why it opens nothing. */
export type ASKGSourceTarget =
  | { kind: "pane"; command: ASKGSourceCommand; label: string }
  | { kind: "none" };

export interface ASKGSourceResolver {
  target(row: ASKGToolRow): ASKGSourceTarget;
}

/**
 * Turns the calls behind an answer into the commands that show their data.
 * A call this client ran is its own function by name, with its argument and
 * options; a call the platform ran goes through the table above. Either is
 * checked against the functions this app has, so a link is only ever one the
 * app opens.
 */
export function createSourceResolver(catalog: PaneFunctionCatalog | null): ASKGSourceResolver {
  const byToolName = catalog ? functionsByToolName(catalog) : new Map<string, CatalogFunction>();
  const byCode = catalog ? functionsByCode(catalog) : new Map<string, CatalogFunction>();
  const none: ASKGSourceTarget = { kind: "none" };
  const cache = new WeakMap<ASKGToolRow, ASKGSourceTarget>();
  const resolve = (row: ASKGToolRow): ASKGSourceTarget => {
    if (!catalog || row.writeTier !== "read") return none;
    const args = row.args ?? {};
    if (row.origin === "server") {
      const source = serverToolCommand(row.name, args);
      const found = source ? byCode.get(source.code) : undefined;
      if (!source || !found || !checkCommand(found, source)) return none;
      return { kind: "pane", command: source, label: found.template?.label ?? found.pane.name };
    }
    // An app action or app state (`app.get_resource`) is no function.
    if (resolveRemoteToolBinding(row.name)) return none;
    const found = byToolName.get(row.name);
    const source = found ? clientToolCommand(found, args) : null;
    if (!found || !source || !checkCommand(found, source)) return none;
    return { kind: "pane", command: source, label: found.template?.label ?? found.pane.name };
  };
  return {
    target(row) {
      const cached = cache.get(row);
      if (cached) return cached;
      const target = resolve(row);
      cache.set(row, target);
      return target;
    },
  };
}

// --- Citations --------------------------------------------------------------

/**
 * `[3]`, `[3][5]` or `[3, 5]` after a figure, never a link's label (`[3](…)`)
 * or a picture. Numbers past three digits are not sources.
 */
const CITATION_RE = /(?<![!\\])\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g;

function citationRefs(group: string): number[] {
  return group.split(",").map((entry) => Number(entry.trim())).filter(isSourceRef);
}

/** The source numbers an answer cites, in the order it first cites each. */
export function citedRefs(answer: string): number[] {
  const refs: number[] = [];
  for (const match of withoutCode(answer).matchAll(CITATION_RE)) {
    for (const ref of citationRefs(match[1]!)) if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/** Code spans blanked to spaces of the same length, so a citation inside one is not read. */
function withoutCode(answer: string): string {
  return answer.replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
}

/** The href a citation link carries; MarkdownText hands it back on a click. */
export const SOURCE_LINK_SCHEME = "gloom-source:";

export function sourceRefFromHref(href: string): number | null {
  if (!href.startsWith(SOURCE_LINK_SCHEME)) return null;
  const ref = Number(href.slice(SOURCE_LINK_SCHEME.length));
  return isSourceRef(ref) ? ref : null;
}

/**
 * The answer with each citation that opens a pane written as a link
 * (`[\[3\]](gloom-source:3)`, drawn `[3]`), so a click opens it. A citation of a
 * source that opens nothing, or of no source at all, stays the text it was.
 */
export function linkCitations(answer: string, openable: ReadonlySet<number>): string {
  if (openable.size === 0) return answer;
  const code = withoutCode(answer);
  let result = "";
  let cursor = 0;
  for (const match of code.matchAll(CITATION_RE)) {
    const refs = citationRefs(match[1]!);
    if (refs.length === 0 || !refs.some((ref) => openable.has(ref))) continue;
    const index = match.index!;
    result += answer.slice(cursor, index);
    result += refs.map((ref) => (
      openable.has(ref) ? `[\\[${ref}\\]](${SOURCE_LINK_SCHEME}${ref})` : `\\[${ref}\\]`
    )).join("");
    cursor = index + match[0].length;
  }
  return result + answer.slice(cursor);
}

/** One source under an answer: the number it is cited by, and what it opens. */
export interface ASKGAnswerSource {
  /** The number the answer cites it by; null for a read an answer from an older server could not cite. */
  ref: number | null;
  /** The call that read it; null when the answer cites a number no call carries. */
  row: ASKGToolRow | null;
  target: ASKGSourceTarget;
}

/** A read that came back with data, worth listing when the answer cites none. */
function readSomething(row: ASKGToolRow): boolean {
  return row.writeTier === "read" && (row.status === "ok" || row.status === "partial");
}

/**
 * The sources an answer lists. A cited number is looked up among every call
 * of the conversation up to this turn (numbers run on across it, so a
 * follow-up can cite what an earlier turn read). An answer that cites nothing
 * lists the reads its own turn made, so an answer from an older server, or
 * one that forgot to cite, still opens what it read.
 */
export function answerSources(
  turns: readonly ASKGTurn[],
  turnIndex: number,
  resolver: ASKGSourceResolver,
): ASKGAnswerSource[] {
  const turn = turns[turnIndex];
  if (!turn) return [];
  const refs = citedRefs(turn.answer);
  if (refs.length === 0) {
    return turn.tools
      .filter((row) => readSomething(row) && resolver.target(row).kind === "pane")
      .map((row) => ({ ref: row.ref ?? null, row, target: resolver.target(row) }));
  }
  const byRef = new Map<number, ASKGToolRow>();
  for (const earlier of turns.slice(0, turnIndex + 1)) {
    for (const row of earlier.tools) if (row.ref !== undefined && !byRef.has(row.ref)) byRef.set(row.ref, row);
  }
  return refs.map((ref) => {
    const row = byRef.get(ref) ?? null;
    return { ref, row, target: row ? resolver.target(row) : { kind: "none" } };
  });
}

/** True when an answer gives figures and read nothing to take them from. */
export function answerReadNothing(turn: ASKGTurn): boolean {
  return /\d/.test(turn.answer)
    && citedRefs(turn.answer).length === 0
    && !turn.tools.some((row) => row.writeTier === "read" && row.status !== "denied" && row.status !== "cancelled");
}

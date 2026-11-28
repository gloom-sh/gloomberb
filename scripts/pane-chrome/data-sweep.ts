import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PaneCatalogEntry } from "../../src/cli/pane-functions/catalog";
import { FUNCTION_HELP } from "../../src/cli/pane-functions/function-help";
import { PANE_SWEEP_EVIDENCE_PATH, type PaneScreenshotResult } from "../../src/cli/pane-functions/screenshot-types";
import snapshot from "../../src/docs/snapshot.json";
import type { RegistryPlugin } from "../../src/plugins/marketplace/model";
import { isRecord } from "../../src/utils/guards";
import { runCommand, type CommandResult } from "./data-sweep-command";
import { createSweepShot } from "./data-sweep-shot";
import { pluginDirectory, pluginInstallRef, pluginLaneEnv, planPlugins, type FunctionCard } from "./data-sweep-plugins";

const READ_ONLY = new Set(`adverse-events analyst-research apps attention-trending awards backtest buildout buildout-company
 catalysts ccass-market central-bank-rates chart-composer comment-letters commodities-energy company-kpis congress-trades corporate-actions
 correlation cpi crypto-board crypto-etf-flows csp-screen custom-view data-catalog dividend-yield earnings-calendar earnings-calls
 earnings-estimates earnings-ripple econ-calendar econ-statistics equity-dilution equity-screener estimate-revisions executives exposure fear-greed
 filing-events financial-analysis fixed-income fx-matrix gpu company-guidance hiring historical-prices holders insider ipo-calendar
 iv-history iv-screen jobs kelly-sizer litigation macro-day market-halts market-heatmap market-movers market-valuation members mna
 money-markets news-breaking news-feed news-industry news-top options options-calculator options-positioning options-scenario pe-band
 perps power quote-monitor rate-path realized-vol relationship-graph relative-rotation relative-valuation research-search returns
 reverse-dcf revenue-breakdown risk-factors scanner-flow scanner-hilo scanner-live seasonality sec sectors short-interest short-watch
 social-mentions supply-chain thirteenf-funds ticker-news ticker-research time-sales trials twitter-feed vol-surface
 volatility-term-structure world-indices world-venue-map yield-curve`.split(/\s+/));
/** Catalog panes the sweep never captures, each with why: account, portfolio, alert and chat data, generative, media and app surfaces. */
const EXCLUDED: Record<string, string> = {
  "account-management": "Your Gloom Cloud account: profile, emails, plan and password (account data)",
  alerts: "Your saved alerts, their trigger state and delivery history (alert data)",
  analytics: "Risk, stress and performance of your own portfolio holdings (portfolio data)",
  askg: "Generative: every question spends model tokens",
  brokers: "Your broker profiles, account sync and connection status (account data)",
  "broker-orders": "Your broker orders and fills, beside order entry (account data)",
  chat: "Chat channels and their messages (chat data)",
  changelog: "Release notes shipped with the app, not market data",
  connections: "This app's own request and socket health, not market data",
  docs: "The docs reader, not market data",
  "equity-diagnostic": "Generative: a report not in the cache is written by a model on demand, which spends model tokens",
  help: "Keyboard shortcuts and the command reference, not market data",
  "layout-marketplace": "Saved and published layouts, with actions that add them to the workspace (workspace data)",
  "local-agent-workspace": "Generative: an AI agent thread on the model account you configure",
  "macro-tv": "Live television video and audio (media)",
  "news-story": "One article by its story id, opened from a news list: no stable id to review, and the lists that open stories (N, TOP, CN, NI, FIRST) are measured",
  "plugin-marketplace": "The plugin directory, with install and remove actions, not market data",
  "portfolio-list": "Your portfolios and watchlists with positions and P&L (portfolio data)",
  "quick-notes": "Your own notes (workspace data)",
  roadmap: "Gloom's product roadmap and its votes, not market data",
  "thesis-board": "Your and your teams' investment theses; on Pro a model drafts them (account data, generative)",
};
/**
 * Reviewed inputs where the catalog's own example is not the one to measure:
 * CAT lists a bare code first (an empty search), the X Feed has no help entry
 * under its catalog name, and VIEW reads a data function its card names,
 * MOST's most-active board, through MOST's own columns.
 */
const MOST_VIEW_SPEC = JSON.stringify({ version: 1, source: { kind: "inline", pane: "MOST" },
  projection: { columns: ["symbol", "name", "price", "changePercent", "volume"], limit: 20 } });
const REVIEWED_INPUTS: Record<string, string[]> = {
  "data-catalog": ["fed", "funds"],
  // One X search a run.
  "twitter-feed": ["$NVDA"],
  "custom-view": [MOST_VIEW_SPEC],
};
/**
 * Function cards whose code the catalog lists under another token. TWIT is the
 * X Feed's command-bar code, a command's rather than its template's, so the
 * catalog (and `gloom shot`) knows the pane by its name, `x-feed`.
 */
const CARD_PANES: Record<string, string> = { TWIT: "twitter-feed" };
/** Function cards with no catalog function to capture: commands that act on the workspace, the account or the app. */
const CARD_ONLY: Record<string, string> = {
  AW: "Action: adds a ticker to the active watchlist; no pane of its own",
  AP: "Action: adds a ticker to a manual portfolio; no pane of its own",
  RW: "Action: removes a ticker from the active watchlist; no pane of its own",
  RP: "Action: removes a ticker and its positions from the active portfolio; no pane of its own",
  SA: "Action: creates a price alert; no pane of its own",
  DM: "Opens or starts a direct message conversation (chat data)",
  TEAM: "Your teams' members, invites and settings (account data); the command line has no team page to capture",
  FOCUS: "Narrows the workspace to one team (a workspace setting, no pane)",
  UPGRADE: "Opens Pro checkout or the billing portal (an account billing action)",
  GL: "Arranges the open windows into one layout (a layout command, no pane)",
  DESK: "Adds a ready-made desk as a layout tab (a layout command, no pane)",
  LMA: "Float, dock, swap, remove and save actions on panes and layouts (a layout command, no pane)",
  WIN: "Moves or resizes the focused window from the keyboard (a window mode, no pane)",
  PS: "Opens the focused pane's settings form (no pane of its own)",
  TH: "Switches the app theme (a setting, no pane)",
  LANG: "Switches the interface language (a setting, no pane)",
  "FONT+": "Changes the app font size (a setting, no pane)",
  SB: "Shows or hides the shortcuts bar (a setting, no pane)",
  VF: "Turns quote flashing on or off (a setting, no pane)",
  CR: "Cycles the terminal chart renderer (a setting, no pane)",
  FB: "Sends feedback with logs and an optional screenshot (an outward action, no pane)",
};

/** The function cards gloom.sh shows, from the docs snapshot the app ships (refreshed by scripts/update-docs-snapshot.ts). */
export function functionCards(): FunctionCard[] {
  return (snapshot.functions as unknown as FunctionCard[]).map(({ code, category, plugin }) => ({ code, category, ...(plugin ? { plugin } : {}) }));
}
const EQUITY_MATRIX = new Set(`ADR ANR APPS BT BTST BUZZ CALLS CATL CN COVN CRDOC DDIS EE EM EVT EVTS FA GE GF GIP GP
 GS GUIDE HDS HIRE HP HVG HVT JOBS KELLY KPIS LITI MA PEB RDCF RETURN RIPL RISK RV SEAS SEG SPLC T TBOC`.split(/\s+/));
const COHORTS = [["us-large", "AAPL"], ["us-small", "PLPC"], ["us-micro", "DWSN"], ["non-us", "7203:JPX"]] as const;

export interface SweepCase {
  id: string;
  /** What `shot` is given. */
  token: string;
  /** The function card's code, where the catalog lists the function under another token (TWIT is `x-feed`). */
  code?: string;
  lane: string;
  args: string[];
  /** The plugin that provides the function: the case runs only in the plugin lane. */
  plugin?: string;
  status?: "missing" | "skipped" | "unsupported" | "excluded";
  reason?: string;
}

export function exampleArgs(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let escaped = false;
  for (const character of text) {
    if (escaped) { word += character; escaped = false; }
    else if (character === "\\" && quote !== "'") escaped = true;
    else if (quote) { if (character === quote) quote = ""; else word += character; }
    else if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) { if (word) words.push(word); word = ""; }
    else word += character;
  }
  if (quote || escaped) throw new Error("Unclosed catalog example");
  if (word) words.push(word);
  return words;
}

function catalogExample(entry: PaneCatalogEntry): string[] | null {
  const usages = FUNCTION_HELP[entry.token]?.usage ?? [];
  const candidates = [
    ...(entry.shotArgument && !/[<>]/.test(entry.shotArgument) ? [entry.shotArgument] : []),
    ...(entry.argExamples ?? []),
    ...usages.map((usage) => usage.replace(/^gloom fn /, "")).filter((usage) => usage.split(/\s/)[0] === entry.token).map((usage) => usage.slice(entry.token.length).trim()),
  ];
  for (const example of candidates) {
    if (/[<>]|portfolio-id|watchlist-id/.test(example)) continue;
    const args = exampleArgs(example);
    if (["G", "SIW"].includes(entry.token) && !args.length) continue;
    if (entry.token === "OSA" && !args.includes("--strategy")) continue;
    if (args.some((argument) => argument.startsWith("--") && !(entry.token === "OSA" && ["--strategy", "--expiration"].includes(argument)))) continue;
    return args;
  }
  return entry.argKind === "none" || (!entry.argKind && !entry.argPlaceholder) ? [] : null;
}

/**
 * One case or more per catalog function, then one for each function card the
 * catalog has no function for (plugin cards are `planPlugins`'s): a reviewed
 * reason, or missing until it has one.
 */
export function planSweep(entries: readonly PaneCatalogEntry[], cards: readonly FunctionCard[] = []): SweepCase[] {
  const functions = [...entries].sort((left, right) => left.token.localeCompare(right.token)).flatMap((entry): SweepCase[] => {
    const code = Object.keys(CARD_PANES).find((candidate) => CARD_PANES[candidate] === entry.paneId);
    const name = code ?? entry.token;
    const base = { id: `${name}/default`, token: entry.token, ...(code ? { code } : {}), lane: "default", args: [] };
    if (Object.hasOwn(EXCLUDED, entry.paneId)) return [{ ...base, status: "skipped", reason: EXCLUDED[entry.paneId]! }];
    if (!READ_ONLY.has(entry.paneId)) return [{ ...base, status: "missing", reason: "New pane needs read-only safety and input review" }];
    if (entry.capability.screenshotReadiness === "unsupported") return [{ ...base, status: "unsupported", reason: "Catalog screenshot capability is unsupported" }];
    if (!["", "none", "ticker", "tickers", "symbol-list", "text", "free-text"].includes(entry.argKind ?? "")) return [{ ...base, status: "missing", reason: "New argument kind needs input review" }];
    if (Object.hasOwn(REVIEWED_INPUTS, entry.paneId)) {
      const args = REVIEWED_INPUTS[entry.paneId]!;
      return [{ ...base, id: `${name}/${args.length ? "reviewed-input" : "default"}`, lane: args.length ? "reviewed-input" : "default", args }];
    }
    if (EQUITY_MATRIX.has(entry.token) && ["ticker", "tickers", "symbol-list"].includes(entry.argKind ?? "")) {
      return COHORTS.map(([lane, symbol]) => {
        const reason = entry.token === "BUZZ" && lane === "non-us" ? "Numeric exchange-qualified sample is not a cashtag"
          : ["HVG", "HVT"].includes(entry.token) && lane !== "us-large" ? "Listed-option IV needs a reviewed optionable input; this cohort is unsupported" : null;
        return { ...base, id: `${name}/${lane}`, lane, args: [symbol], ...(reason ? { status: "unsupported" as const, reason } : {}) };
      });
    }
    if (entry.token === "MOST") {
      const lists = entry.capability.options.find((option) => option.key === "list")?.values;
      return lists?.length ? lists.map(({ value }) => ({ ...base, id: `MOST/${value}`, lane: value, args: ["--list", value] }))
        : [{ ...base, status: "missing", reason: "MOST has no catalog list choices" }];
    }
    const example = catalogExample(entry);
    if (example === null) return [{ ...base, status: "missing", reason: "No safe concrete catalog/help example" }];
    return [{ ...base, lane: example.length ? "catalog-example" : "default", args: example }];
  });
  const listed = new Set(entries.flatMap((entry) => [entry.token, ...entry.aliases ?? []].map((token) => token.toUpperCase())));
  const panes = new Set(entries.map((entry) => entry.paneId));
  const cardOnly = cards.filter((card) => !card.plugin && !listed.has(card.code.toUpperCase())
    && !(Object.hasOwn(CARD_PANES, card.code) && panes.has(CARD_PANES[card.code]!)));
  return [...functions, ...cardOnly.map((card): SweepCase => {
    const reason = Object.hasOwn(CARD_ONLY, card.code) ? CARD_ONLY[card.code] : undefined;
    return { id: `${card.code}/card`, token: card.code, lane: "card", args: [], status: reason ? "skipped" : "missing",
      reason: reason ?? "Function card has no catalog function and no reviewed reason" };
  })];
}

export interface Assessment {
  status: "pass" | "partial" | "pending" | "expected-empty" | "no-coverage" | "market-closed" | "unsupported" | "failure" | "timeout" | "invalid-output" | "command-error";
  reason: string | null;
  states: string[];
  stateText: { error?: string[]; empty?: string[] };
  visibleText: string;
  reasonCodes: string[];
  blankColumns: string[];
}

function candidateCodes(text: string, symbols?: readonly string[]): string[] {
  return [...text.matchAll(/\b[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+\b/g)].filter((match) => {
    if (!symbols) return true;
    const before = text.slice(0, match.index);
    if (/(?:^|[^\w@])@[a-zA-Z0-9_]*$/.test(before)) return false;
    const qualifier = before.match(/\b([A-Z0-9][A-Z0-9:.-]*):$/)?.[1];
    return !(qualifier && symbols.includes(qualifier)) && !/\b(?:field|expression|formula)\s*[:=]\s*$/i.test(before);
  }).map((match) => match[0]);
}

/**
 * Panes whose rows are third-party prose, story titles and posts: an identifier
 * in that text (`EVP_EncodeBlock()` in an HN title) is the text, not a status
 * code. Their state and error markers are still read for codes.
 */
const PROSE_TOKENS = new Set(["HN", "x-feed"]);

export const REVIEWED_EMPTY: Record<string, ["no-coverage" | "expected-empty" | "unsupported" | "market-closed", RegExp]> = {
  APPS: ["no-coverage", /^\S+ has no mapped apps in the observed App Store and Google Play charts\.$/],
  CALLS: ["no-coverage", /^Earnings calls for \S+ are not yet available\. Calls appear once the company's investor site or filings list a webcast\.$/],
  CATL: ["expected-empty", /^No (?:company )?events linked to (\S+) yet\.$/],
  EE: ["no-coverage", /^No analyst estimates for (\S+)$/],
  EM: ["no-coverage", /^No covered estimate periods\.$/],
  COVN: ["no-coverage", /^(?:No debt instrument has been read from this issuer's filings yet|This is not an issuer the credit documents cover)\.$/],
  CRDOC: ["no-coverage", /^(?:No debt instrument has been read from this issuer's filings yet|This is not an issuer the credit documents cover)\.$/],
  GUIDE: ["no-coverage", /^Guidance for \S+ is not yet available\. Try GUIDE \S+\.$/],
  KPIS: ["no-coverage", /^No KPIs on file for \S+ yet\.$/],
  HIRE: ["no-coverage", /^No current role evidence has been captured yet\.$/],
  HILO: ["market-closed", /^Markets closed(?: until [^.]+)?\. New highs and lows resume at the open\.$/],
  // The default scan's conditions (a move and a volume spike over 5 minutes) only hold in the session.
  SCAN: ["market-closed", /^Nothing matched at the close\. The scan runs again at the open\.$/],
  // Collection is on (a disabled one says so) and no hour yet has activity that passes the privacy threshold.
  "gloom-trending": ["expected-empty", /^Waiting for privacy-qualified research activity\.$/],
  JOBS: ["no-coverage", /^No careers system found for \S+\. Gloom reads companies' own careers systems\. This one either has none we can read or lists roles only on third-party job boards\.$/],
  LITI: ["no-coverage", /^No cases linked to \S+\. US court dockets are not collected yet, so only agency and regulator actions show\.$/],
  MA: ["expected-empty", /^No deals involving \S+\.$/],
  RIPL: ["expected-empty", /^None of the \d+ disclosed (?:customers and suppliers|customer or supplier) of \S+ reports from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} \(the next \d+ days\)\.$/],
  RISK: ["no-coverage", /^No 10-K risk factors on file for \S+\.$/],
  SEG: ["no-coverage", /^No revenue breakdown\. This company's filings do not split revenue by product, segment or region\.$/],
  TBOC: ["no-coverage", /^(?:No relationships in TheBuildout yet|\S+ is not in TheBuildout)\.$/],
  BUZZ: ["unsupported", /^This ticker cannot be searched as a cashtag\. Use a symbol of up to six letters and digits, starting with a letter\.$/],
  OSA: ["expected-empty", /^Build an options position\.$/],
  SIW: ["expected-empty", /^No US-listed names in your portfolios or watchlists\.$/],
};

// Empty states of event lists and first reads, matched on the start of the pane's wording.
export const EXPECTED_EMPTY: Record<string, RegExp> = {
  ANR: /^No upgrades, downgrades or target changes on record for /m,
  HALT: /^No trading halts reported\./m,
  ERN: /^No reports on the calendar /m,
  // A company nobody had asked about: the server looks for its careers system, the pane fills in when it is read.
  JOBS: /^Looking for \S+'s careers system\./m,
};

/**
 * Reviewed states of a pane whose service is still working on its answer, matched on the pane's whole copy.
 * CALLS on a company's first open of the day: the server is searching for its calls, and the pane asks again
 * until the search lands, then shows the calls or its reviewed no-coverage copy. The capture is taken before
 * that, so it is pending, not a failure and not a reviewed empty answer.
 */
export const REVIEWED_PENDING: Record<string, RegExp> = {
  CALLS: /^Looking for \S+'s earnings calls\.\.\.$/,
};

function emptyCompanyCalendar(evidence: Record<string, unknown>, symbol: string): boolean {
  const payload = evidence.payload;
  return evidence.kind === "catalysts" && evidence.ready === true && evidence.complete === true
    && evidence.tab === "calendar" && evidence.openId === null && Array.isArray(evidence.rowIds) && evidence.rowIds.length === 0
    && isRecord(payload) && isRecord(payload.filters) && payload.filters.symbol === symbol
    && payload.total === 0 && Array.isArray(payload.events) && payload.events.length === 0
    && isRecord(payload.coverage) && typeof payload.coverage.totalEvents === "number" && payload.coverage.totalEvents > 0;
}

export function assessCapture(result: CommandResult, token: string): Assessment {
  const base = { reason: null, states: [], stateText: {}, visibleText: "", reasonCodes: [], blankColumns: [] };
  if (result.timedOut) return { ...base, status: "timeout", reason: "Capture exceeded its time limit" };
  let envelope: unknown;
  const fromStderr = !result.stdout.trim() && result.exitCode !== 0;
  const serialized = fromStderr ? result.stderr.replace(/^(?:Still (?:drawing|loading the data for) [^\r\n]+\.\r?\n)+/, "").trim() : result.stdout;
  try { envelope = JSON.parse(serialized); }
  catch (error) { return { ...base, status: "invalid-output", reason: `Invalid JSON: ${String(error)}` }; }
  if (!isRecord(envelope)) return { ...base, status: "invalid-output", reason: "Missing CLI envelope" };
  if (envelope.ok === false && isRecord(envelope.error) && typeof envelope.error.message === "string" && typeof envelope.error.code === "string") {
    return { ...base, status: "command-error", reason: envelope.error.message, reasonCodes: [envelope.error.code] };
  }
  if (fromStderr) return { ...base, status: "invalid-output", reason: "Nonzero CLI exit without a structured CLI error" };
  const data = envelope.data;
  const rendered = isRecord(data) && isRecord(data.render) ? data.render : null;
  const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
  if (envelope.ok !== true || !isRecord(data) || data.kind !== "pane-screenshot" || !rendered
    || typeof data.usable !== "boolean" || typeof data.complete !== "boolean" || typeof data.empty !== "boolean"
    || typeof data.rowCount !== "number" || typeof rendered.visibleText !== "string"
    || ["errorStateDetected", "emptyStateDetected", "loadingStateDetected"].some((key) => typeof rendered[key] !== "boolean")
    || (data.blankColumns !== undefined && !strings(data.blankColumns))
    || (data.symbols !== undefined && !strings(data.symbols))
    || ["emptyStateText", "errorStateMarkers", "emptyStateMarkers", "truncationReasons"].some((key) => rendered[key] !== undefined && !strings(rendered[key]))
    || (rendered.stateText !== undefined && (!isRecord(rendered.stateText)
      || Object.values(rendered.stateText).some((value) => !strings(value))))) {
    return { ...base, status: "invalid-output", reason: "Missing strict screenshot assessment fields" };
  }
  const shot = data as unknown as PaneScreenshotResult;
  const render = shot.render;
  const stateText = {
    ...(render.errorStateMarkers?.length ? { error: render.errorStateMarkers } : {}),
    ...(render.emptyStateText?.length ? { empty: render.emptyStateText } : render.emptyStateMarkers?.length ? { empty: render.emptyStateMarkers } : {}),
    ...render.stateText,
  };
  const truncation = (shot.complete ? render.truncationReasons?.filter((reason) => reason.startsWith("rows ")) : render.truncationReasons)?.join("; ");
  const reason = shot.unusableReason ?? shot.gaps ?? (truncation || (!shot.complete ? "Strict capture is usable but its report is incomplete" : null));
  const diagnostics = [reason, shot.gaps, ...Object.values(shot.unreadReasons ?? {})].filter((text): text is string => typeof text === "string");
  const markers = [...Object.values(stateText).flat(), ...(render.emptyStateText ?? []), ...(render.errorStateMarkers ?? []), ...(render.emptyStateMarkers ?? [])];
  const reasonCodes = [...new Set([...PROSE_TOKENS.has(token) ? [] : candidateCodes(render.visibleText, shot.symbols ?? []),
    ...candidateCodes([...diagnostics, ...markers].join("\n"))])];
  const blankColumns = shot.blankColumns ?? [];
  const hasError = render.errorStateDetected || !!stateText.error?.length || !!render.errorStateMarkers?.length;
  const hasEmpty = render.emptyStateDetected || shot.empty || !!stateText.empty?.length || !!render.emptyStateText?.length || !!render.emptyStateMarkers?.length;
  const states = [hasError ? "error" : "", hasEmpty ? "empty" : "",
    render.loadingStateDetected ? "loading" : "", render.accessGate ? `access:${render.accessGate}` : ""].filter(Boolean);
  const evidence = { reason, states, stateText, visibleText: render.visibleText, reasonCodes, blankColumns };
  const negativeFcfText = "reverse DCF unavailable. Free cash flow over the last twelve months is negative, so no growth rate prices it.";
  const negativeFcf = token === "RDCF" && !shot.usable && shot.empty && shot.rowCount === 0
    && stateText.error?.join(" ") === negativeFcfText && render.emptyStateText?.join(" ") === negativeFcfText
    && (!stateText.empty?.length || stateText.empty.join(" ") === negativeFcfText)
    && (render.errorStateMarkers ?? []).every((text) => /^RDCF [A-Z0-9:.-]+ Discount \d+(?:\.\d+)?% FCF margin Own unavailable reverse DCF unavailable\.$/.test(text))
    && reason === `The pane rendered an error state. It reads "${negativeFcfText}"`;
  const details = isRecord(data.dataEvidence) ? data.dataEvidence : {};
  const ivErrors = [`No options provider available for ${details.symbol}`, "Current ATM IV unavailable"];
  const missingIv = ["HVG", "HVT"].includes(token) && !shot.usable && details.kind === "realized-volatility"
    && typeof details.symbol === "string"
    && !render.emptyStateDetected && !stateText.empty?.length && !render.emptyStateText?.length
    && details.showIv === true && details.currentIv === null && details.loading === false && details.stale === false
    && [details.errors, details.ivErrors].every((errors) => Array.isArray(errors) && strings(errors) && errors.length === 2 && ivErrors.every((error) => errors.includes(error)))
    && shot.unavailableSymbols?.length === 1 && [details.symbol, `${details.symbol} current ATM IV`].includes(shot.unavailableSymbols[0]!)
    && reason === `Data is unavailable for ${shot.unavailableSymbols[0]}.`;
  if (blankColumns.length || (hasError && !negativeFcf) || render.accessGate || render.loadingStateDetected || shot.semanticMismatch || shot.refused || shot.unreadRows?.length
    || ![0, 2].includes(result.exitCode)
    || diagnostics.some((text) => !((negativeFcf || missingIv) && text === reason) && /\b(?:error|failed|failure|unavailable|timeout|timed out|denied|forbidden|unauthorized)\b/i.test(text))) {
    return { ...evidence, status: "failure" };
  }
  const said = [...(stateText.empty ?? []), ...(render.emptyStateText ?? []), ...(render.emptyStateMarkers ?? [])].join("\n");
  let expected: "pending" | "no-coverage" | "market-closed" | "expected-empty" | "unsupported" | null = negativeFcf ? "unsupported" : missingIv ? "no-coverage" : null;
  if (hasEmpty && (token === "CATL" || token === "EE")) {
    const [status, pattern] = REVIEWED_EMPTY[token]!;
    const texts = [stateText.empty, render.emptyStateText, render.emptyStateMarkers].flatMap((lines) => lines ?? []);
    const symbol = shot.symbols?.length === 1 ? shot.symbols[0] : undefined;
    const complete = shot.complete && !shot.gaps && !shot.unavailableSymbols?.length;
    const correctView = token === "CATL" ? symbol && shot.rowCount === 0 && (shot.options?.tab ?? "calendar") === "calendar"
      && emptyCompanyCalendar(details, symbol) && (complete || (!shot.complete && shot.gaps === `no data for ${symbol}`
        && shot.unavailableSymbols?.length === 1 && shot.unavailableSymbols[0] === symbol))
      : (shot.options?.view ?? "estimates") === "estimates" && complete;
    if (symbol && correctView && !shot.usable && shot.empty && render.emptyStateDetected && !render.rows?.length && !render.reportRows?.length
      && !render.tableRowTotals?.some((total) => total != null && total > 0)
      && !(Array.isArray(details.errors) && details.errors.length)
      && texts.length && texts.every((text) => pattern.exec(text.trim())?.[1] === symbol)) expected = status;
  } else if (!shot.usable && hasEmpty && (shot.empty || shot.rowCount === 0)) {
    const reviewed = REVIEWED_EMPTY[token];
    const pending = REVIEWED_PENDING[token];
    const texts = [stateText.empty, render.emptyStateText, render.emptyStateMarkers].filter((lines) => lines?.length).map((lines) => lines!.join(" ").replace(/\s+/g, " ").trim());
    if (!expected && reviewed && texts.length && texts.every((text) => reviewed[1].test(text))) expected = reviewed[0];
    if (!expected && pending && texts.length && texts.every((text) => pending.test(text))) expected = "pending";
    if (!expected && token === "RIPL" && texts.length && texts.every((text) => /^No US-listed customer or supplier with a share of revenue is disclosed for \S+, so no report date was looked up from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} \(the next \d+ days\)\.$/.test(text))) expected = "no-coverage";
    if (!expected && (/\bno (?:analyst |estimate |ratings? )?coverage\b|\bnot covered\b/i.test(said)
      || (token === "ANR" && /\bsource lists them mainly for North American listings\b/.test(said)))) {
      expected = "no-coverage";
    } else if (!expected && ["MOST", "SCAN", "HILO", "HALT", "FLOW", "QR", "TAS"].includes(token)
      && /\bmarket (?:is )?closed\b|\boutside (?:regular |market |trading )?hours\b/i.test(said)) {
      expected = "market-closed";
    }
    if (!expected && EXPECTED_EMPTY[token]?.test(said)) expected = "expected-empty";
  }
  const allowedCodes = expected === "no-coverage" ? ["no_coverage", "symbol_not_covered"]
    : expected === "market-closed" ? ["market_closed", "outside_market_hours", "outside_session"] : [];
  if (reasonCodes.some((code) => !allowedCodes.includes(code.toLowerCase()))) return { ...evidence, status: "failure" };
  if (expected) return { ...evidence, status: expected };
  return { ...evidence, status: shot.usable && !states.length && result.exitCode === 0 ? shot.complete && !truncation ? "pass" : "partial" : "failure" };
}

interface Selection { only: string[]; shard: [number, number]; maxCases: number }
type SweepResult = Omit<SweepCase, "status" | "reason"> & Omit<Partial<Assessment>, "status"> & {
  status: NonNullable<SweepCase["status"]> | Assessment["status"];
  exitCode?: number;
  png?: string;
  evidenceError?: string;
};

export async function captureEvidence(result: CommandResult, token: string, png: string, image: Blob) {
  const assessment = assessCapture(result, token);
  if (["timeout", "invalid-output", "command-error"].includes(assessment.status)) return assessment;
  const signature = new Uint8Array(await image.slice(0, 8).arrayBuffer());
  return Buffer.from(signature).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? { ...assessment, png }
    : { ...assessment, evidenceError: "Strict report has no rendered PNG" };
}

export function selectCases(plan: SweepCase[], selection: Selection): SweepCase[] {
  let selected = 0;
  return plan.map((item) => {
    if (item.status) return item;
    let hash = 0;
    for (const character of item.id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
    const reason = selection.only.length && ![item.token, item.id, item.code].some((name) => name && selection.only.includes(name)) ? "Not selected by --only"
      : hash % selection.shard[1] !== selection.shard[0] - 1 ? "Not selected by deterministic shard"
      : selected >= selection.maxCases ? "Case budget exhausted" : null;
    if (reason) return { ...item, status: "skipped", reason };
    selected++;
    return item;
  });
}

/** A plugin the plugin lane installed, as results.json records it. */
interface InstalledPluginRecord {
  id: string;
  repo: string;
  directory: string;
  /** The tag and commit the registry reviewed, which the installer lands on; null where the registry follows the default branch. */
  registryRef: string | null;
  registryCommit: string | null;
  /** The commit actually checked out, as `gloom plugins` reads it. */
  commit: string | null;
  version: string | null;
  exitCode: number | null;
  error: string | null;
}

/**
 * A plugin-lane capture as reported. The lane never has a session, so a pane
 * that shows its data only behind a Gloom sign-in or plan is unsupported
 * there, with that reason; every other status stays the strict one.
 */
export function sessionlessAssessment<T extends Pick<Assessment, "status" | "reason" | "states" | "reasonCodes">>(assessment: T): T {
  const gate = assessment.states.find((state) => state.startsWith("access:"));
  const signIn = assessment.status === "command-error" && assessment.reasonCodes.includes("auth_required");
  if (!gate && !signIn) return assessment;
  return { ...assessment, status: "unsupported", reason: `Shows its data only with a Gloom session (${gate ?? "auth_required"}), which the plugin lane never passes` };
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function main(signal: AbortSignal) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("bun run check:pane-data --out DIR [--lanes pro|plugins|pro,plugins] [--only ANR,MOST] [--shard 1/8] [--max-cases 40] [--max-seconds 600] [--timeout-seconds 90]");
    return;
  }
  if (args.includes("--cli")) throw new Error("--cli is no longer supported: run check:pane-data from the source checkout whose CLI you want to sweep.");
  if (process.platform === "win32") throw new Error("check:pane-data requires Chrome's private DevTools pipe, unavailable on Windows. Run the sweep on macOS or Linux.");
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (!["--out", "--lanes", "--only", "--shard", "--max-cases", "--max-seconds", "--timeout-seconds"].includes(key) || !value || options.has(key)) throw new Error(`Invalid option ${key}`);
    options.set(key, value);
  }
  if (!options.get("--out")) throw new Error("--out DIR is required; all evidence stays there");
  const lanes = new Set((options.get("--lanes") ?? "pro").split(","));
  if ([...lanes].some((lane) => lane !== "pro" && lane !== "plugins")) throw new Error("--lanes must be pro, plugins or pro,plugins");
  const bounded = (key: string, fallback: number, maximum: number) => {
    const value = Number(options.get(key) ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${key} must be 1..${maximum}`);
    return value;
  };
  const maxCases = bounded("--max-cases", 40, 2_000);
  const maxSeconds = bounded("--max-seconds", 600, 7_200);
  const timeoutSeconds = bounded("--timeout-seconds", 90, 180);
  const shard = (options.get("--shard") ?? "1/1").split("/").map(Number);
  if (shard.length !== 2 || shard.some((value) => !Number.isInteger(value) || value < 1) || shard[0]! > shard[1]! || shard[1]! > 1_000) throw new Error("--shard must be N/M, 1 <= N <= M <= 1000");
  const only = options.get("--only")?.split(",").filter(Boolean) ?? [];
  const out = resolve(options.get("--out")!);
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length) throw new Error("--out must be empty to avoid mixing evidence from different runs");
  const root = join(homedir(), ".cache", "gloom-smoke");
  await mkdir(root, { recursive: true });
  const session = process.env.GLOOMBERB_SESSION_TOKEN?.trim();
  const redact = (text: string) => session ? text.replaceAll(session, "[redacted]") : text;
  const cli = [process.execPath, "--no-env-file", resolve(import.meta.dir, "../../src/cli/entry.ts")];
  const started = new Date().toISOString();
  const deadline = Date.now() + maxSeconds * 1_000;
  const remaining = (limitMs: number) => Math.max(1, Math.min(limitMs, deadline - Date.now()));
  const results = new Map<string, SweepResult>();
  const plugins: InstalledPluginRecord[] = [];
  const fatal: string[] = [];
  const profiles = new Set<string>();
  let planned: SweepCase[] = [];
  let proVerified = false;
  let registryError: string | null = null;
  let captures = 0;
  const newProfile = async (prefix: string) => {
    const profile = await mkdtemp(join(root, prefix));
    profiles.add(profile);
    await mkdir(join(profile, "tmp"));
    await writeFile(join(profile, "config.json"), JSON.stringify({ dataDir: profile, onboardingComplete: true }));
    return profile;
  };
  const removeProfile = async (profile: string) => {
    await rm(profile, { recursive: true, force: true });
    profiles.delete(profile);
  };
  const shot = createSweepShot(cli, async () => {
    const profile = await newProfile("pane-data-browser-");
    const env = pluginLaneEnv(process.env, profile);
    await mkdir(env.HOME!, { recursive: true });
    return { profile, env };
  }, signal);
  // One strict capture, saved and judged the same way in either lane.
  const capture = async (item: SweepCase, run: (argv: string[], evidencePath: string) => Promise<CommandResult>) => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) { results.set(item.id, { ...item, status: "skipped", reason: "Global time budget exhausted" }); return; }
    const stem = String(++captures).padStart(4, "0");
    const png = `${stem}.png`;
    const evidencePath = join(out, png);
    const raw = await run(["shot", item.token, ...item.args, "--strict", "--json", "--width", "1600", "--output", evidencePath], evidencePath);
    raw.stdout = redact(raw.stdout);
    raw.stderr = redact(raw.stderr);
    await writeFile(join(out, `${stem}.json`), raw.stdout);
    await writeFile(join(out, `${stem}.stderr`), raw.stderr);
    const file = Bun.file(evidencePath);
    const assessment = await captureEvidence(raw, item.token, png, await file.exists() ? file : new Blob());
    results.set(item.id, { ...item, ...(item.plugin ? sessionlessAssessment(assessment) : assessment), exitCode: raw.exitCode });
    await Bun.sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  };
  try {
    // Read once, with no credential: the plugins to plan, and the commit the registry reviewed for each.
    let feed: RegistryPlugin[] | null = null;
    try {
      const { readRegistryOnce } = await import("../../src/plugins/marketplace/feed");
      feed = await readRegistryOnce(remaining(15_000), signal);
    } catch (error) { registryError = redact(message(error)); }
    signal.throwIfAborted();

    // The Pro lane: the session, a verified Pro plan and the built-in catalog, in a profile with no plugins.
    let pro: { profile: string; env: NodeJS.ProcessEnv } | null = null;
    let catalog: PaneCatalogEntry[] | null = null;
    const proCommand = async (argv: string[], evidencePath?: string) => {
      const pluginsDir = join(pro!.profile, "plugins");
      await mkdir(pluginsDir, { recursive: true });
      if ((await readdir(pluginsDir)).length) throw new Error("Refusing to load external plugins beside credentials");
      const limit = remaining(timeoutSeconds * 1_000);
      return evidencePath ? shot.run(argv, { ...pro!.env, [PANE_SWEEP_EVIDENCE_PATH]: evidencePath }, limit)
        : runCommand([...cli, ...argv], pro!.env, limit, { signal });
    };
    if (lanes.has("pro")) {
      try {
        const profile = await newProfile("pane-data-sweep-");
        const temp = join(profile, "tmp");
        pro = { profile, env: { ...process.env, GLOOMBERB_HOME: profile, TMPDIR: temp, TMP: temp, TEMP: temp,
          GLOOMBERB_NO_TELEMETRY: "1", DO_NOT_TRACK: "1", GLOOMBERB_SESSION_TOKEN: session ?? "" } };
        if (!session) throw new Error("No GLOOMBERB_SESSION_TOKEN; no Pro coverage");
        const { apiClient } = await import("../../src/api-client");
        const { resolvePlanAccess } = await import("../../src/api-client/plan-rules");
        apiClient.setSessionToken(session);
        const accountSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining(timeoutSeconds * 1_000))]);
        let aborted: (() => void) | undefined;
        try {
          accountSignal.throwIfAborted();
          const account = await Promise.race([apiClient.getAccountProfile(), new Promise<never>((resolveAccount, reject) => {
            aborted = () => reject(signal.aborted ? signal.reason : new Error("Account read timed out; no Pro coverage"));
            accountSignal.addEventListener("abort", aborted, { once: true });
          })]);
          proVerified = resolvePlanAccess(account).hasProAccess;
        } finally { if (aborted) accountSignal.removeEventListener("abort", aborted); apiClient.setSessionToken(null); }
        if (!proVerified) throw new Error("Current account read did not verify Pro; no Pro coverage");
        const listing = await proCommand(["catalog", "--all", "--json"]);
        await writeFile(join(out, "catalog.json"), redact(listing.stdout));
        if (listing.timedOut || listing.exitCode !== 0) throw new Error("Catalog failed or timed out; no pane coverage");
        const envelope: unknown = JSON.parse(listing.stdout);
        if (!isRecord(envelope) || envelope.ok !== true || !Array.isArray(envelope.data) || !envelope.data.length
          || envelope.data.some((entry) => !isRecord(entry) || typeof entry.token !== "string" || typeof entry.paneId !== "string" || !isRecord(entry.capability))) throw new Error("Invalid catalog output");
        catalog = envelope.data as PaneCatalogEntry[];
      } catch (error) {
        fatal.push(redact(message(error)));
        if (pro) await removeProfile(pro.profile);
        pro = null;
      }
    }
    signal.throwIfAborted();

    const cards = functionCards();
    const pluginPlan = planPlugins(feed, cards).map((item): SweepCase => item.id === "registry/feed" && registryError ? { ...item, reason: `${item.reason}: ${registryError}` }
      : !item.status && !lanes.has("plugins") ? { ...item, status: "skipped", reason: "Plugin lane not selected (--lanes plugins)" } : item);
    const plan = [...(catalog ? planSweep(catalog, cards) : []), ...pluginPlan];
    for (const requested of only) if (!plan.some((item) => [item.token, item.id, item.code].includes(requested))) throw new Error(`Unknown --only selection: ${requested}`);
    planned = selectCases(plan, { only, shard: [shard[0]!, shard[1]!], maxCases });
    await writeFile(join(out, "plan.json"), JSON.stringify(planned, null, 2));

    if (pro) {
      try {
        for (const item of planned) if (!item.status && !item.plugin) await capture(item, (argv, evidencePath) => proCommand(argv, evidencePath));
      } catch (error) { fatal.push(redact(message(error))); }
      finally { await removeProfile(pro.profile); }
    }
    signal.throwIfAborted();

    // The plugin lane: reviewed gloom-sh plugins, installed by the app's own installer into a profile with no session.
    const pluginItems = planned.filter((item) => !item.status && item.plugin);
    if (pluginItems.length) {
      const profile = await newProfile("pane-data-plugins-");
      try {
        const env = pluginLaneEnv(process.env, profile);
        await mkdir(env.HOME!, { recursive: true });
        const pluginsDir = join(profile, "plugins");
        const expected = new Set<string>();
        const pluginCommand = async (argv: string[], limitMs: number, evidencePath?: string) => {
          await mkdir(pluginsDir, { recursive: true });
          const unexpected = (await readdir(pluginsDir)).filter((name) => !expected.has(name));
          if (unexpected.length) throw new Error(`Refusing to run beside plugin folders nobody reviewed: ${unexpected.join(", ")}`);
          return evidencePath ? shot.run(argv, { ...env, [PANE_SWEEP_EVIDENCE_PATH]: evidencePath }, remaining(limitMs))
            : runCommand([...cli, ...argv], env, remaining(limitMs), { signal });
        };
        const failed = new Map<string, string>();
        const unstarted = new Set<string>();
        for (const id of new Set(pluginItems.map((item) => item.plugin!))) {
          signal.throwIfAborted();
          const ref = pluginInstallRef(id);
          const listed = feed?.find((candidate) => candidate.id === id);
          const record: InstalledPluginRecord = { id, repo: ref.slice("https://github.com/".length), directory: pluginDirectory(id),
            registryRef: listed?.ref ?? null, registryCommit: listed?.commit ?? null, commit: null, version: null, exitCode: null, error: null };
          plugins.push(record);
          if (Date.now() >= deadline) { record.error = "Global time budget exhausted"; unstarted.add(id); continue; }
          expected.add(record.directory);
          const install = await pluginCommand(["install", ref], Math.max(timeoutSeconds, 180) * 1_000);
          await writeFile(join(out, `install-${id}.stdout`), redact(install.stdout));
          await writeFile(join(out, `install-${id}.stderr`), redact(install.stderr));
          record.exitCode = install.exitCode;
          if (install.timedOut || install.exitCode !== 0) {
            record.error = install.timedOut ? "Install timed out" : redact(install.stderr.trim().split("\n").at(-1) || `Install exited ${install.exitCode}`);
            failed.set(id, `Install failed: ${record.error}`);
          }
        }
        const listing = await pluginCommand(["plugins", "--json"], timeoutSeconds * 1_000);
        await writeFile(join(out, "plugins.json"), redact(listing.stdout));
        const envelope: unknown = JSON.parse(listing.stdout);
        if (!isRecord(envelope) || envelope.ok !== true || !Array.isArray(envelope.data)) throw new Error("Invalid plugin listing");
        const rows = envelope.data.filter(isRecord);
        for (const record of plugins) {
          if (failed.has(record.id) || unstarted.has(record.id)) continue;
          const row = rows.find((candidate) => candidate.name === record.directory);
          const listedCommit = typeof row?.commit === "string" ? row.commit : "";
          // The listing shortens the commit; the record keeps all of it.
          const head = await runCommand(["git", "-C", join(pluginsDir, record.directory), "rev-parse", "HEAD"], env, remaining(10_000), { signal });
          const full = head.stdout.trim();
          record.commit = /^[0-9a-f]{40}$/.test(full) && listedCommit && full.startsWith(listedCommit) ? full : listedCommit || null;
          record.version = typeof row?.version === "string" && row.version ? row.version : null;
          const problem = !row ? "Not listed after its install"
            : row.id !== record.id ? `Installed plugin is ${String(row.id)}, not the reviewed ${record.id}`
              : typeof row.blocked === "string" && row.blocked ? `Not loaded: ${row.blocked}`
                : record.registryCommit && record.commit && !record.registryCommit.startsWith(record.commit.slice(0, 7))
                  ? `Checked out ${record.commit}, not the registry's reviewed ${record.registryCommit}` : null;
          if (problem) { record.error = problem; failed.set(record.id, problem); }
        }
        for (const item of pluginItems) {
          const problem = failed.get(item.plugin!);
          if (unstarted.has(item.plugin!)) results.set(item.id, { ...item, status: "skipped", reason: "Global time budget exhausted" });
          else if (problem) results.set(item.id, { ...item, status: "command-error", reason: problem });
          else await capture(item, (argv, evidencePath) => pluginCommand(argv, timeoutSeconds * 1_000, evidencePath));
        }
      } catch (error) { fatal.push(`Plugin lane: ${redact(message(error))}`); }
      finally { await removeProfile(profile); }
    }
  } catch (error) {
    fatal.push(redact(message(error)));
  } finally {
    try { await shot.close(); } catch (error) { fatal.push(redact(message(error))); }
    for (const profile of profiles) {
      try { await removeProfile(profile); } catch (error) { fatal.push(redact(message(error))); }
    }
  }
  const stopped = fatal.length ? fatal.join("; ") : null;
  const ordered = planned.map((item): SweepResult => results.get(item.id)
    ?? { ...item, status: item.status ?? "skipped", reason: item.reason ?? (stopped ? `Run stopped: ${stopped}` : "Not run") });
  const counts: Record<string, number> = {};
  for (const result of ordered) counts[result.status] = (counts[result.status] ?? 0) + 1;
  const profileRemoved = profiles.size === 0;
  const report = { started, finished: new Date().toISOString(), lanes: [...lanes], proVerified, fatal: stopped, profileRemoved,
    registry: { read: !registryError, error: registryError }, plugins,
    bounds: { maxCases, maxSeconds, timeoutSeconds, only, shard }, counts, results: ordered };
  await writeFile(join(out, "results.json"), JSON.stringify(report, null, 2));
  const attempted = ordered.filter((result) => result.exitCode !== undefined).length;
  const breakdown = Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(", ") || "no pane coverage";
  const proText = lanes.has("pro") ? `Pro ${proVerified ? "verified" : "NOT verified"}` : "Pro lane not run";
  const pluginText = lanes.has("plugins") ? `plugin lane without a session (${plugins.filter((plugin) => plugin.commit).length} installed)` : "plugin lane not run";
  const total = `${attempted} attempted / ${ordered.length} planned: ${breakdown}; ${proText}; ${pluginText}; ${profileRemoved ? "profiles removed" : "profile NOT removed"}`;
  const findings = ordered.filter((result) => result.status !== "pass" || result.evidenceError).map((result) => {
    const evidence = [result.reason, result.evidenceError, result.states?.length ? `states: ${result.states.join(", ")}` : "", ...Object.values(result.stateText ?? {}).flat(),
      result.states?.some((state) => state === "loading" || state.startsWith("access:")) ? result.visibleText : "",
      result.reasonCodes?.length ? `codes: ${result.reasonCodes.join(", ")}` : "",
      result.blankColumns?.length ? `blank columns: ${result.blankColumns.join(", ")}` : ""].filter(Boolean).join(" | ");
    return { status: result.status, text: `${result.id}: ${result.status} — ${evidence}` };
  });
  await writeFile(join(out, "results.md"), [`# Rendered pane data sweep`, "", total, ...(stopped ? [`Fatal: ${stopped}`] : []), "",
    ...plugins.map((plugin) => `- Plugin ${plugin.repo} at ${plugin.commit ?? "no commit"}${plugin.error ? `: ${plugin.error}` : ""}`),
    ...findings.map((finding) => `- ${finding.text.replaceAll("\n", " ")}`)].join("\n"));
  console.log(total);
  if (stopped) console.error(`FATAL: ${stopped}`);
  for (const finding of findings) if (finding.status !== "skipped" && finding.status !== "excluded") console.log(finding.text);
  if (stopped || ordered.some((result) => result.evidenceError || ["failure", "timeout", "invalid-output", "command-error", "missing"].includes(result.status))) process.exitCode = 1;
}

if (import.meta.main) {
  const interruption = new AbortController();
  const interrupt = () => interruption.abort(new Error("Sweep interrupted (SIGINT)"));
  const terminate = () => interruption.abort(new Error("Sweep interrupted (SIGTERM)"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try { await main(interruption.signal); }
  finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    if (interruption.signal.aborted) process.exitCode = interruption.signal.reason.message.includes("SIGINT") ? 130 : 143;
  }
}

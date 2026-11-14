import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PaneCatalogEntry } from "../../src/cli/pane-functions/catalog";
import { FUNCTION_HELP } from "../../src/cli/pane-functions/function-help";
import type { PaneScreenshotResult } from "../../src/cli/pane-functions/screenshot-types";
import { isRecord } from "../../src/utils/guards";

const READ_ONLY = new Set(`adverse-events analyst-research apps attention-trending awards backtest buildout buildout-company
 catalysts central-bank-rates chart-composer comment-letters commodities-energy company-kpis congress-trades corporate-actions
 correlation cpi crypto-board crypto-etf-flows csp-screen dividend-yield earnings-calendar earnings-calls earnings-estimates earnings-ripple
 econ-calendar econ-statistics equity-screener estimate-revisions executives exposure fear-greed filing-events financial-analysis
 fixed-income fx-matrix gpu company-guidance hiring historical-prices holders insider ipo-calendar iv-history iv-screen jobs kelly-sizer litigation
 macro-day market-halts market-heatmap market-movers market-valuation members mna money-markets news-breaking news-feed news-industry
 news-top options options-calculator options-positioning options-scenario pe-band perps power quote-monitor rate-path realized-vol
 relationship-graph relative-rotation relative-valuation returns reverse-dcf revenue-breakdown risk-factors scanner-flow scanner-hilo
 scanner-live seasonality sec sectors short-interest short-watch social-mentions supply-chain thirteenf-funds ticker-news ticker-research
 time-sales trials vol-surface volatility-term-structure world-indices yield-curve`.split(/\s+/));
const EXCLUDED = new Set(`account-management alerts analytics askg brokers broker-orders chat changelog connections custom-view
 data-catalog docs equity-diagnostic help layout-marketplace local-agent-workspace macro-tv news-story plugin-marketplace portfolio-list
 quick-notes research-search roadmap thesis-board twitter-feed world-venue-map`.split(/\s+/));
const EQUITY_MATRIX = new Set(`ADR ANR APPS BT BTST BUZZ CALLS CATL CN COVN CRDOC DDIS EE EM EVT EVTS FA GE GF GIP GP
 GS GUIDE HDS HIRE HP HVG HVT JOBS KELLY KPIS LITI MA PEB RDCF RETURN RIPL RISK RV SEAS SEG SPLC T TBOC`.split(/\s+/));
const COHORTS = [["us-large", "AAPL"], ["us-small", "PLPC"], ["us-micro", "DWSN"], ["non-us", "7203:JPX"]] as const;

export interface SweepCase {
  id: string;
  token: string;
  lane: string;
  args: string[];
  status?: "missing" | "skipped" | "unsupported";
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

export function planSweep(entries: readonly PaneCatalogEntry[]): SweepCase[] {
  return [...entries].sort((left, right) => left.token.localeCompare(right.token)).flatMap((entry): SweepCase[] => {
    const base = { id: `${entry.token}/default`, token: entry.token, lane: "default", args: [] };
    if (EXCLUDED.has(entry.paneId)) return [{ ...base, status: "skipped", reason: "Account, action, generative, media, custom or non-market surface" }];
    if (!READ_ONLY.has(entry.paneId)) return [{ ...base, status: "missing", reason: "New pane needs read-only safety and input review" }];
    if (entry.capability.screenshotReadiness === "unsupported") return [{ ...base, status: "unsupported", reason: "Catalog screenshot capability is unsupported" }];
    if (!["", "none", "ticker", "tickers", "symbol-list", "text", "free-text"].includes(entry.argKind ?? "")) return [{ ...base, status: "missing", reason: "New argument kind needs input review" }];
    if (EQUITY_MATRIX.has(entry.token) && ["ticker", "tickers", "symbol-list"].includes(entry.argKind ?? "")) {
      return COHORTS.map(([lane, symbol]) => {
        const reason = entry.token === "BUZZ" && lane === "non-us" ? "Numeric exchange-qualified sample is not a cashtag"
          : ["HVG", "HVT"].includes(entry.token) && lane !== "us-large" ? "Listed-option IV needs a reviewed optionable input; this cohort is unsupported" : null;
        return { ...base, id: `${entry.token}/${lane}`, lane, args: [symbol], ...(reason ? { status: "unsupported" as const, reason } : {}) };
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
}

export interface CommandResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean }
export interface Assessment {
  status: "pass" | "partial" | "expected-empty" | "no-coverage" | "market-closed" | "unsupported" | "failure" | "timeout" | "invalid-output" | "command-error";
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

const REVIEWED_EMPTY: Record<string, ["no-coverage" | "expected-empty" | "unsupported" | "market-closed", RegExp]> = {
  APPS: ["no-coverage", /^\S+ has no mapped apps in the observed App Store and Google Play charts\.$/],
  CALLS: ["no-coverage", /^Earnings calls for \S+ are not yet available\. Calls appear once the company's investor site or filings list a webcast\.$/],
  CATL: ["expected-empty", /^No events linked to \S+ yet\.$/],
  EM: ["no-coverage", /^No covered estimate periods\.$/],
  COVN: ["no-coverage", /^(?:No debt instrument has been read from this issuer's filings yet|This is not an issuer the credit documents cover)\.$/],
  CRDOC: ["no-coverage", /^(?:No debt instrument has been read from this issuer's filings yet|This is not an issuer the credit documents cover)\.$/],
  GUIDE: ["no-coverage", /^Guidance for \S+ is not yet available\. Try GUIDE WMT\.$/],
  KPIS: ["no-coverage", /^KPIs for \S+ are not yet available\. Try KPIS AAPL\.$/],
  HIRE: ["no-coverage", /^No current role evidence has been captured yet\.$/],
  HILO: ["market-closed", /^Markets closed(?: until [^.]+)?\. New highs and lows resume at the open\.$/],
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

export function assessCapture(result: CommandResult, token: string): Assessment {
  const base = { reason: null, states: [], stateText: {}, visibleText: "", reasonCodes: [], blankColumns: [] };
  if (result.timedOut) return { ...base, status: "timeout", reason: "Capture exceeded its time limit" };
  let envelope: unknown;
  const fromStderr = !result.stdout.trim() && result.exitCode !== 0;
  const serialized = fromStderr ? result.stderr.replace(/^(?:Still drawing [^\r\n]+\.\r?\n)+/, "").trim() : result.stdout;
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
    || ["emptyStateText", "errorStateMarkers", "emptyStateMarkers"].some((key) => rendered[key] !== undefined && !strings(rendered[key]))
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
  const reason = shot.unusableReason ?? shot.gaps ?? (!shot.complete ? render.truncationReasons?.join("; ") || "Strict capture is usable but its report is incomplete" : null);
  const diagnostics = [reason, shot.gaps, ...Object.values(shot.unreadReasons ?? {})].filter((text): text is string => typeof text === "string");
  const markers = [...Object.values(stateText).flat(), ...(render.emptyStateText ?? []), ...(render.errorStateMarkers ?? []), ...(render.emptyStateMarkers ?? [])];
  const reasonCodes = [...new Set([...candidateCodes(render.visibleText, shot.symbols ?? []), ...candidateCodes([...diagnostics, ...markers].join("\n"))])];
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
  let expected: "no-coverage" | "market-closed" | "expected-empty" | "unsupported" | null = negativeFcf ? "unsupported" : missingIv ? "no-coverage" : null;
  if (!shot.usable && hasEmpty && (shot.empty || shot.rowCount === 0)) {
    const reviewed = REVIEWED_EMPTY[token];
    const texts = [stateText.empty, render.emptyStateText, render.emptyStateMarkers].filter((lines) => lines?.length).map((lines) => lines!.join(" ").replace(/\s+/g, " ").trim());
    if (!expected && reviewed && texts.length && texts.every((text) => reviewed[1].test(text))) expected = reviewed[0];
    if (!expected && token === "RIPL" && texts.length && texts.every((text) => /^No US-listed customer or supplier with a share of revenue is disclosed for \S+, so no report date was looked up from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} \(the next \d+ days\)\.$/.test(text))) expected = "no-coverage";
    if (!expected && (/\bno (?:analyst |estimate |ratings? )?coverage\b|\bnot covered\b/i.test(said)
      || (token === "ANR" && /\bsource lists them mainly for North American listings\b/.test(said)))) {
      expected = "no-coverage";
    } else if (!expected && ["MOST", "SCAN", "HILO", "HALT", "FLOW", "QR", "TAS"].includes(token)
      && /\bmarket (?:is )?closed\b|\boutside (?:regular |market |trading )?hours\b/i.test(said)) {
      expected = "market-closed";
    }
    const expectedEmpty: Record<string, RegExp> = {
      ANR: /^No upgrades, downgrades or target changes on record for /m,
      HALT: /^No trading halts reported\./m,
      ERN: /^No reports on the calendar /m,
    };
    if (!expected && expectedEmpty[token]?.test(said)) expected = "expected-empty";
  }
  const allowedCodes = expected === "no-coverage" ? ["no_coverage", "symbol_not_covered"]
    : expected === "market-closed" ? ["market_closed", "outside_market_hours", "outside_session"] : [];
  if (reasonCodes.some((code) => !allowedCodes.includes(code.toLowerCase()))) return { ...evidence, status: "failure" };
  if (expected) return { ...evidence, status: expected };
  return { ...evidence, status: shot.usable && !states.length && result.exitCode === 0 ? shot.complete ? "pass" : "partial" : "failure" };
}

export async function runCommand(argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = (name: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, name);
        else child.kill(name);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error); }
    };
    const stop = () => {
      timedOut = true;
      signal("SIGTERM");
      killTimer ??= setTimeout(() => signal("SIGKILL"), 2_000);
    };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(0, 16_000_001); if (stdout.length > 16_000_000) stop(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-64_000); });
    child.on("error", (error) => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal("SIGKILL");
      resolveResult({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
  });
}

interface Selection { only: string[]; shard: [number, number]; maxCases: number }
type SweepResult = Omit<SweepCase, "status" | "reason"> & Omit<Partial<Assessment>, "status"> & {
  status: NonNullable<SweepCase["status"]> | Assessment["status"];
  exitCode?: number;
  png?: string;
};
export function selectCases(plan: SweepCase[], selection: Selection): SweepCase[] {
  let selected = 0;
  return plan.map((item) => {
    if (item.status) return item;
    let hash = 0;
    for (const character of item.id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
    const reason = selection.only.length && !selection.only.includes(item.token) && !selection.only.includes(item.id) ? "Not selected by --only"
      : hash % selection.shard[1] !== selection.shard[0] - 1 ? "Not selected by deterministic shard"
      : selected >= selection.maxCases ? "Case budget exhausted" : null;
    if (reason) return { ...item, status: "skipped", reason };
    selected++;
    return item;
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("bun run check:pane-data --out DIR [--only ANR,MOST] [--shard 1/8] [--max-cases 40] [--max-seconds 600] [--timeout-seconds 90] [--cli /path/to/gloom]");
    return;
  }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (!["--out", "--only", "--shard", "--max-cases", "--max-seconds", "--timeout-seconds", "--cli"].includes(key) || !value || options.has(key)) throw new Error(`Invalid option ${key}`);
    options.set(key, value);
  }
  if (!options.get("--out")) throw new Error("--out DIR is required; all evidence stays there");
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
  const profile = await mkdtemp(join(root, "pane-data-sweep-"));
  const session = process.env.GLOOMBERB_SESSION_TOKEN?.trim();
  const redact = (text: string) => session ? text.replaceAll(session, "[redacted]") : text;
  const temp = join(profile, "tmp");
  const env = { ...process.env, GLOOMBERB_HOME: profile, TMPDIR: temp, TMP: temp, TEMP: temp,
    GLOOMBERB_NO_TELEMETRY: "1", DO_NOT_TRACK: "1", GLOOMBERB_SESSION_TOKEN: session ?? "" };
  const cli = options.has("--cli") ? [resolve(options.get("--cli")!)] : [process.execPath, resolve(import.meta.dir, "../../src/cli/entry.ts")];
  const started = new Date().toISOString();
  const deadline = Date.now() + maxSeconds * 1_000;
  const results: SweepResult[] = [];
  let planned: SweepCase[] = [];
  let proVerified = false;
  let fatal: string | null = null;
  let profileRemoved = false;
  const command = async (argv: string[]) => {
    const plugins = join(profile, "plugins");
    await mkdir(plugins, { recursive: true });
    if ((await readdir(plugins)).length) throw new Error("Refusing to load external plugins beside credentials");
    return runCommand([...cli, ...argv], env, Math.max(1, Math.min(timeoutSeconds * 1_000, deadline - Date.now())));
  };
  try {
    await mkdir(temp);
    await writeFile(join(profile, "config.json"), JSON.stringify({ dataDir: profile, onboardingComplete: true }));
    if (!session) throw new Error("No GLOOMBERB_SESSION_TOKEN; no Pro coverage");
    const { apiClient } = await import("../../src/api-client");
    const { resolvePlanAccess } = await import("../../src/api-client/plan-rules");
    apiClient.setSessionToken(session);
    let accountTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const account = await Promise.race([apiClient.getAccountProfile(), new Promise<never>((resolveAccount, reject) => {
        accountTimer = setTimeout(() => reject(new Error("Account read timed out; no Pro coverage")), Math.max(1, Math.min(timeoutSeconds * 1_000, deadline - Date.now())));
      })]);
      proVerified = resolvePlanAccess(account).hasProAccess;
    } finally { if (accountTimer) clearTimeout(accountTimer); apiClient.setSessionToken(null); }
    if (!proVerified) throw new Error("Current account read did not verify Pro; no Pro coverage");
    const catalog = await command(["catalog", "--all", "--json"]);
    await writeFile(join(out, "catalog.json"), redact(catalog.stdout));
    if (catalog.timedOut || catalog.exitCode !== 0) throw new Error("Catalog failed or timed out; no pane coverage");
    const envelope: unknown = JSON.parse(catalog.stdout);
    if (!isRecord(envelope) || envelope.ok !== true || !Array.isArray(envelope.data) || !envelope.data.length
      || envelope.data.some((entry) => !isRecord(entry) || typeof entry.token !== "string" || typeof entry.paneId !== "string" || !isRecord(entry.capability))) throw new Error("Invalid catalog output");
    const plan = planSweep(envelope.data as PaneCatalogEntry[]);
    for (const requested of only) if (!plan.some((item) => item.token === requested || item.id === requested)) throw new Error(`Unknown --only selection: ${requested}`);
    planned = selectCases(plan, { only, shard: [shard[0]!, shard[1]!], maxCases });
    await writeFile(join(out, "plan.json"), JSON.stringify(planned, null, 2));
    for (const item of planned) {
      if (item.status) { results.push({ ...item, status: item.status }); continue; }
      if (Date.now() >= deadline) { results.push({ ...item, status: "skipped", reason: "Global time budget exhausted" }); continue; }
      const stem = String(results.length + 1).padStart(4, "0");
      const png = `${stem}.png`;
      const raw = await command(["shot", item.token, ...item.args, "--strict", "--json", "--width", "1600", "--output", join(out, png)]);
      raw.stdout = redact(raw.stdout);
      raw.stderr = redact(raw.stderr);
      await writeFile(join(out, `${stem}.json`), raw.stdout);
      await writeFile(join(out, `${stem}.stderr`), raw.stderr);
      const assessment = assessCapture(raw, item.token);
      if (!["timeout", "invalid-output", "command-error"].includes(assessment.status)) {
        const file = Bun.file(join(out, png));
        if (!await file.exists() || !Buffer.from(await file.slice(0, 8).arrayBuffer()).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          assessment.status = "invalid-output";
          assessment.reason = "Strict report has no rendered PNG";
        }
      }
      results.push({ ...item, ...assessment, exitCode: raw.exitCode, png });
      await Bun.sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    }
  } catch (error) {
    fatal = redact(error instanceof Error ? error.message : String(error));
    const finished = new Set(results.map((item) => item.id));
    for (const item of planned) if (!finished.has(item.id)) results.push({ ...item, status: item.status ?? "skipped", reason: item.reason ?? `Run stopped: ${fatal}` });
  } finally {
    await rm(profile, { recursive: true, force: true });
    profileRemoved = true;
  }
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.status!] = (counts[result.status!] ?? 0) + 1;
  const report = { started, finished: new Date().toISOString(), proVerified, fatal, profileRemoved,
    bounds: { maxCases, maxSeconds, timeoutSeconds, only, shard }, counts, results };
  await writeFile(join(out, "results.json"), JSON.stringify(report, null, 2));
  const attempted = results.filter((result) => result.exitCode !== undefined).length;
  const breakdown = Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(", ") || "no pane coverage";
  const total = `${attempted} attempted / ${results.length} planned: ${breakdown}; Pro ${proVerified ? "verified" : "NOT verified"}; profile removed`;
  const findings = results.filter((result) => result.status !== "pass").map((result) => {
    const evidence = [result.reason, result.states?.length ? `states: ${result.states.join(", ")}` : "", ...Object.values(result.stateText ?? {}).flat(),
      result.states?.some((state) => state === "loading" || state.startsWith("access:")) ? result.visibleText : "",
      result.reasonCodes?.length ? `codes: ${result.reasonCodes.join(", ")}` : "",
      result.blankColumns?.length ? `blank columns: ${result.blankColumns.join(", ")}` : ""].filter(Boolean).join(" | ");
    return `${result.id}: ${result.status} — ${evidence}`;
  });
  await writeFile(join(out, "results.md"), [`# Rendered pane data sweep`, "", total, ...(fatal ? [`Fatal: ${fatal}`] : []), "", ...findings.map((finding) => `- ${finding.replaceAll("\n", " ")}`)].join("\n"));
  console.log(total);
  if (fatal) console.error(`FATAL: ${fatal}`);
  for (const finding of findings.filter((finding) => !finding.includes(": skipped "))) console.log(finding);
  if (fatal || results.some((result) => ["failure", "timeout", "invalid-output", "command-error", "missing"].includes(result.status!))) process.exitCode = 1;
}

if (import.meta.main) await main();

import { logFailure } from "../../utils/log-failure";
import { extname, isAbsolute, relative, resolve } from "path";
import type { CliCommandContext, HeadlessArgumentExpansion } from "../../types/plugin";
import type { MarketContext } from "../types";
import { withMarketData } from "../context";
import { cliStyles, renderStats, type CliStatEntry } from "../../utils/cli-output";
import {
  filterPaneCatalogEntries,
  findFunctionCode,
  nearFunctionCodes,
  renderFunctionHelp,
  renderPaneCatalogReport,
  selectPaneCatalogMatches,
  suggestPaneFunctions,
  type PaneFunctionCatalog,
} from "./catalog";
import { createPaneCatalog } from "./discovery";
import { catalogFredSeriesIds, findCatalogSeries } from "../series-search";
import {
  parsePaneCatalogArgs,
  parsePaneFunctionArgs,
  type ParsedPaneFunctionArgs,
} from "./options";
import { applyListingArgument, findPaneFunction, parsePaneFunctionArgsFor, resolvePaneFunction, UnknownPaneFunctionError, type ResolvedPaneFunction } from "./resolver";
import { buildFunctionReport } from "./report";
import { expandResolvedArgument } from "./headless";
import { defaultScreenshotPath, shotSizeWarnings } from "./screenshot-payload";
import { renderDesktopShot } from "./screenshot-render";
import { shotStatusIssues } from "./screenshot-assessment";
import {
  buildPaneCatalogEntries,
} from "./catalog";
import { incompleteReportGateMessage } from "./access-gate";
import { withPersistedCloudSession } from "./cloud-session";
import {
  ListingArgError, listingFateLoader, listingReadNotes, loadForListing, loadListingQuoteAnswer, quotedListingChoiceNotes, refuseMovedListing,
} from "../listing-arg";
import { isNotATickerMessage } from "../not-a-ticker";
import { isCliFailure, SERVICE_UNREACHABLE_CODE } from "../errors";
import { DATA_SERVICE_UNREACHABLE_MESSAGE } from "../../utils/network-failure";
import { isTickerLinkPeer } from "../../layout/ticker-navigation";
import { knownGapMessage, commandPointer, commandPointerLeads, topicPointer } from "../known-gaps";
import { selectReportTables, type CliReportTables } from "../report-tables";
import { cliOutputWritten, type CliErrorObject } from "../result";
import type { CatalogCommandHit } from "../unknown-command";
import { CLI_EXIT_CODES } from "../exit-codes";
import { shotOptionRefusal } from "./shot-options";
import {
  GLOSSARY,
  glossaryRecord,
  lookupGlossary,
  renderGlossaryEntries,
  renderGlossaryIndex,
  renderReportGlossary,
  reportGlossary,
} from "../glossary";

async function withPaneRuntime<T>(
  ctx: CliCommandContext,
  args: string[],
  run: (runtime: {
    parsed: ParsedPaneFunctionArgs;
    context: MarketContext;
    registry: PaneFunctionCatalog;
    resolved: ResolvedPaneFunction;
  }) => Promise<T>,
  settings: { strictHeadlessOptions?: boolean; tableSection?: boolean; command?: "fn" | "shot" } = {},
): Promise<T> {
  return withMarketData(ctx, async (market) => {
    const context: MarketContext = ctx.cliOptions.refresh ? { ...market, refresh: true } : market;
    const registry = await createPaneCatalog(context, ctx.plugins);
    try {
      let parsed = await applyListingArgument(registry, context, parsePaneFunctionArgsFor(registry, args, ctx.cliOptions), settings.command);
      let resolved = await resolvePaneFunction(registry, context, parsed, settings);
      // A function that widens its argument (RV's --peers) runs, reports and captures the widened one.
      const expansion = await withPersistedCloudSession(context, () => expandResolvedArgument(resolved, context, parsed.arg));
      if (expansion) {
        parsed = { ...parsed, arg: expansion.argument };
        resolved = withExpansion(await resolvePaneFunction(registry, context, parsed, settings), expansion);
      }
      return await run({ parsed, context, registry, resolved });
    } finally {
      registry.destroy();
    }
  });
}

/** The resolved function with what its expansion adds to the pane: settings, and a title that says how. */
function withExpansion(resolved: ResolvedPaneFunction, { settings = {}, title }: HeadlessArgumentExpansion): ResolvedPaneFunction {
  return {
    ...resolved,
    optionSettings: { ...resolved.optionSettings, ...settings },
    instance: { ...resolved.instance, ...(title ? { title } : {}), settings: { ...resolved.instance.settings, ...settings } },
  };
}

/** A word that can be a function code: letters and digits, with the dots and dashes some codes carry. */
const FUNCTION_CODE_WORD = /^[\w.$-]{1,24}$/;

/** An argument as a shell reads it back: bare when it is one word, in quotes when it is not. */
function commandWord(argument: string): string {
  return /^[\w.:,=%+@/-]+$/.test(argument) ? argument : JSON.stringify(argument);
}

/**
 * What to run when a command name is a function's code (`gloom OVDV KO`,
 * `gloom help OVDV`): `fn` with the reader's own arguments, or the
 * function's argument hint when they gave none. Null when the word is no
 * function code or the catalog cannot be read, and the command stays unknown.
 */
export async function functionCodeCommand(
  ctx: CliCommandContext,
  token: string,
  args: readonly string[],
): Promise<{ code: string; command: string } | null> {
  const word = token.trim();
  if (!FUNCTION_CODE_WORD.test(word)) return null;
  try {
    const found = await withMarketData(ctx, async (market) => {
      const registry = await createPaneCatalog(market, ctx.plugins);
      try {
        return findFunctionCode(registry, word);
      } finally {
        registry.destroy();
      }
    });
    if (!found) return null;
    const code = word.replace(/^\$/, "").toUpperCase();
    return { code, command: ["gloom fn", code, args.length > 0 ? args.map(commandWord).join(" ") : found.argument].filter(Boolean).join(" ") };
  } catch (error) {
    logFailure("cli.pane-functions-index", "Resolve function code command failed")(error);
    return null;
  }
}

/**
 * The one function code a command name is a slip from (`gloom RCDF PLTR`
 * for RDCF), with the command that runs it on the reader's arguments, read
 * as a command word is (nearFunctionCodes), so a ticker is not taken for one.
 * Null when no code, or more than one, is that close, or the catalog cannot
 * be read.
 */
export async function nearFunctionCodeCommand(
  ctx: CliCommandContext,
  token: string,
  args: readonly string[],
): Promise<{ code: string; label: string; command: string } | null> {
  const word = token.trim();
  if (!FUNCTION_CODE_WORD.test(word)) return null;
  try {
    const near = await withMarketData(ctx, async (market) => {
      const registry = await createPaneCatalog(market, ctx.plugins);
      try {
        return nearFunctionCodes(registry, word, { commandWord: true });
      } finally {
        registry.destroy();
      }
    });
    if (near.length !== 1) return null;
    const { code, label } = near[0]!;
    return { code, label, command: ["gloom fn", code, ...args.map(commandWord)].join(" ") };
  } catch (error) {
    logFailure("cli.pane-functions-index", "Find nearby function code command failed")(error);
    return null;
  }
}

/** How many functions an unknown command word is answered with. */
const COMMAND_HIT_LIMIT = 3;

/**
 * The functions the catalog finds for a word typed as a command (`gloomberb
 * comps`): what `catalog <word>` would list first, as many as are close.
 * Empty when the word finds none or the catalog cannot be read.
 */
export async function catalogCommandHits(ctx: CliCommandContext, token: string): Promise<CatalogCommandHit[]> {
  const word = token.trim();
  if (!/^[a-z][\w-]{1,30}$/i.test(word)) return [];
  try {
    return await withMarketData(ctx, async (market) => {
      const registry = await createPaneCatalog(market, ctx.plugins);
      try {
        return (await suggestPaneFunctions(registry, market, word)).slice(0, COMMAND_HIT_LIMIT).map((entry) => ({
          code: entry.token,
          label: entry.label,
          argKind: entry.argKind ?? null,
          argPlaceholder: entry.argPlaceholder ?? null,
          peers: entry.capability.options.some((option) => option.key === "peers" && option.type === "boolean"),
        }));
      } finally {
        registry.destroy();
      }
    });
  } catch (error) {
    logFailure("cli.pane-functions-index", "Find catalog command suggestions failed")(error);
    return [];
  }
}

/** A board's rows in a shot: "72" when the image holds them all, "37 of 72 rows" when it was cut. */
export function shotRowsText(rows: { shown: number; total: number }): string {
  return rows.shown >= rows.total ? String(rows.total) : `${rows.shown} of ${rows.total} rows`;
}

/** Whether a list report has no row with data: it is empty, or every row is a name without any. */
function foundNothing(data: { rowCount: number; unavailableSymbols: readonly string[] }): boolean {
  return data.rowCount === 0 || data.unavailableSymbols.length >= data.rowCount;
}

/** A listing key as asked or reported (`BHP:XASX`, `fred:DGS10`, `SPY`), in one case. */
const listingKey = (symbol: string) => symbol.trim().toUpperCase();
const bareKey = (key: string) => key.split(":")[0]!;

/**
 * The listings asked that a report has no data for. A report names one by its
 * full key; one that names it by the bare symbol (`SAN` for `SAN:EPA`), or by
 * the listing a bare symbol resolved to (`SXR8:XETRA` for `SXR8`), stands for
 * the one listing asked that way, never for a listing asked by its own key:
 * with `BHP:XASX` and `BHP` asked, `BHP:XASX` unavailable leaves `BHP`.
 */
function missingListings(asked: readonly string[], unavailable: readonly string[]): Set<string> {
  const keys = asked.map(listingKey);
  const exact = new Set(keys);
  const missing = new Set<string>();
  for (const entry of unavailable.map(listingKey)) {
    if (exact.has(entry)) {
      missing.add(entry);
      continue;
    }
    const loose = keys.filter((key) => bareKey(key) === bareKey(entry) && key.includes(":") !== entry.includes(":"));
    if (loose.length === 1) missing.add(loose[0]!);
  }
  return missing;
}

/** Whether a table holds a value past its first column (a row's label or date) and its reasons: a figure, a time, any text. */
function tablesHoldValues(tables: CliReportTables): boolean {
  return tables.tables.some((table) => {
    const skipped = new Set(table.columns.flatMap((header, index) => index === 0 || header === "status" || header === "value_status" ? [index] : []));
    return table.rows.some((row) => row.some((cell, index) => !skipped.has(index) && cell !== "" && cell != null));
  });
}

/**
 * Why `fn` fails a report it printed, or null when the report has data. It
 * fails when it is empty (a pane behind a wall reads nothing), when it has no
 * data for any listing asked and its tables hold no value either, or when it
 * is a list (`failsWithoutData`) with no name that has any. A report with data
 * for some of what was asked, warnings or errors beside it, is a result: a
 * loss-maker's P/E band without a P/E, or IV history with only realized
 * volatility, exits 0. Not one missing a part because the data service could
 * not be reached: that is no answer rather than no data, and fails as
 * retryable `service_unreachable`, whatever else it shows.
 */
export function reportFailure(
  data: { empty: boolean; rowCount: number; symbols: readonly string[]; unavailableSymbols: readonly string[]; errors?: readonly string[]; reason?: unknown },
  asked: string,
  { failsWithoutData = false, tables }: { failsWithoutData?: boolean; tables?: CliReportTables } = {},
): CliErrorObject | null {
  const missing = missingListings(data.symbols, data.unavailableSymbols);
  const noListing = data.symbols.length > 0 && data.symbols.every((symbol) => missing.has(listingKey(symbol)));
  const noValues = tables ? !tablesHoldValues(tables) : false;
  const reasons = [...data.errors ?? [], ...typeof data.reason === "string" ? [data.reason] : []];
  const unreached = reasons.filter((reason) => reason.includes(DATA_SERVICE_UNREACHABLE_MESSAGE));
  if (unreached.length > 0 && (data.empty || data.unavailableSymbols.length > 0)) {
    return { code: SERVICE_UNREACHABLE_CODE, message: `${asked}: ${unreached.join("; ")}.`.replace(/\.\.$/, "."), retryable: true };
  }
  if (!data.empty && !(noListing && noValues) && !(failsWithoutData && foundNothing(data))) return null;
  const unavailable = data.unavailableSymbols.length > 0 ? `no data for ${data.unavailableSymbols.join(", ")}` : "no data";
  return { code: "no_data", message: `${asked}: ${reasons.length > 0 ? reasons.join("; ") : unavailable}.`.replace(/\.\.$/, ".") };
}

export async function runPaneFunction(args: string[], ctx: CliCommandContext) {
  await runPaneCliCommand(ctx, async () => {
    await withPaneRuntime(ctx, args, async ({ parsed, context, registry, resolved }) => {
      if (parsed.strict) {
        throw new Error("--strict is an option of shot. fn takes --require-bot-safe to fail on a report that is not complete.");
      }
      if (parsed.requireBotSafe && (
        !resolved.capability.botSafe || resolved.capability.reportReadiness !== "ready"
      )) {
        throw new Error(
          `${resolved.token} is not a verified bot-safe report capability. `
          + `Use "gloom catalog ${resolved.token}" to inspect readiness.`,
        );
      }
      const tabular = ctx.cliOptions.format === "csv" || ctx.cliOptions.format === "ndjson";
      if (resolved.tableSection !== undefined && !tabular) {
        throw new Error("--section picks one table of --csv or --ndjson output.");
      }
      if (resolved.tableSection === true) throw new Error("--section needs a section title or number.");
      // A report's title names the function and the symbol, never the listing a bare one was read on,
      // so it gets `quote`'s line for that. Looked up beside the report, so it costs no wait.
      const choice = parsed.listing ? quotedListingChoiceNotes(parsed.listing, context) : null;
      // A symbol whose company moved (HFC became DINO) has no data of its own: a report of a pane that shows
      // one ticker, as the app gates those panes, serves none and names the new symbol with the same
      // function, as `history` does. Looked up beside the report. A loader that finds it itself (VCA of
      // one symbol) fails the same way.
      const listing = parsed.listing;
      // The listing's own quote, as `quote` asks for it: what the fate reads, and what says a name is not a ticker.
      let quoted: ReturnType<typeof loadListingQuoteAnswer> | null = null;
      const quoteAnswer = listing ? () => quoted ??= loadListingQuoteAnswer(context.dataProvider, listing) : null;
      const fate = listing && quoteAnswer && isTickerLinkPeer(resolved.instance, registry.panes)
        ? listingFateLoader(listing, context, quoteAnswer().then((answer) => answer.quote))
        : null;
      const moved = { command: "fn", retry: (key: string) => `gloom fn ${resolved.token} ${key}` };
      // A report that fails or comes back empty for an exchange the symbol is not listed on says so.
      const report = await refuseMovedListing(fate, moved, () => withPersistedCloudSession(
        context,
        () => loadForListing(
          parsed.listing ?? [],
          context,
          ctx,
          () => buildFunctionReport(resolved, context, parsed.arg),
          (built) => built.data.empty || !built.data.complete,
        ),
      ));
      // A company's name typed where its ticker goes (`fn RDCF Palantir`) found nothing: the answer is `quote`'s,
      // "Not a ticker: PALANTIR. Try `gloom search Palantir`.", not an empty report.
      if (quoteAnswer && (report.data.empty || report.data.unavailableSymbols.length > 0)) {
        const { quote, error } = await quoteAnswer();
        const message = error instanceof Error ? error.message : null;
        if (!quote && isNotATickerMessage(message)) ctx.fail(message!);
      }
      if (parsed.requireBotSafe && (report.data.empty || !report.data.complete)) {
        const unavailable = report.data.unavailableSymbols.length > 0
          ? ` Missing data for ${report.data.unavailableSymbols.join(", ")}.`
          : "";
        const gated = incompleteReportGateMessage(resolved.token, report.data.errors);
        if (gated) throw new Error(gated);
        throw new Error(
          `${resolved.token} did not produce a complete bot-safe report.${unavailable}`,
        );
      }
      // A chart or other series exported to CSV or NDJSON with no rows fails, rather than writing a header alone.
      if (tabular && report.data.kind === "series" && report.data.empty) {
        const empty = emptySeriesExport(resolved.token, parsed.arg, report.data, catalogFredSeriesIds(ctx.plugins), `--${ctx.cliOptions.format}`);
        ctx.fail(empty.message, empty.details);
      }
      // --explain follows the report with the terms it shows; JSON lists them under `glossary`.
      const glossary = parsed.explain ? reportGlossary(resolved.token, report.text) : null;
      const data = glossary
        ? { ...report.data, glossary: glossary.map(({ term, short, definition }) => ({ term, ...(short ? { short } : {}), definition })) }
        : report.data;
      const warnings = [...parsed.listingNotes ?? [], ...await choice ?? [], ...report.data.warnings ?? []];
      // A report with no data is printed as it is, and fails: exit 1, and `ok: false` in JSON with the reason.
      const failure = reportFailure(report.data, ["fn", resolved.token, parsed.arg.trim()].filter(Boolean).join(" "), {
        failsWithoutData: resolved.headless?.failsWithoutData, tables: report.tables });
      // The report states its own freshness in its data and text; JSON cites it as `source` too.
      ctx.printResult({ data, exportFreshness: report.data.freshness, ...(warnings.length > 0 ? { warnings } : {}), ...(failure ? { failure } : {}) }, {
        text: () => glossary ? `${report.text}\n\n${renderReportGlossary(resolved.token, glossary)}` : report.text,
        ...(tabular ? { tables: selectReportTables(report.tables, resolved.tableSection) } : {}),
      });
      if (failure) process.exitCode = CLI_EXIT_CODES.error;
    }, { strictHeadlessOptions: true, tableSection: true });
  });
}

/**
 * What a series export that came back with no rows says: what was asked, why
 * when the report knows, and what to run instead. A FRED series ID given where
 * a ticker goes (`fn G DEXSFUS`) is charted with the `fred:` prefix.
 */
export function emptySeriesExport(
  token: string,
  arg: string,
  data: { unavailableSymbols: readonly string[]; errors?: readonly string[] },
  fredSeriesIds: ReadonlySet<string>,
  formatFlag = "--csv",
): { message: string; details: string } {
  const asked = ["fn", token, arg.trim()].filter(Boolean).join(" ");
  const fred = data.unavailableSymbols
    .map((symbol) => symbol.split(":")[0]!.trim().toUpperCase())
    .filter((id) => /^[A-Z0-9]+$/.test(id) && fredSeriesIds.has(id));
  if (fred.length > 0) {
    const ids = [...new Set(fred)];
    return {
      message: `${asked} has no data to export: ${ids.join(" and ")} ${ids.length === 1 ? "is a FRED series" : "are FRED series"}, not ${ids.length === 1 ? "a ticker" : "tickers"}.`,
      details: `Chart it with the fred: prefix: gloom fn G ${ids.map((id) => `fred:${id}`).join(",")} ${formatFlag}`
        + `${ids.length === 1 ? ` (or gloom fred ${ids[0]} ${formatFlag})` : ""}.`,
    };
  }
  const missing = data.unavailableSymbols.length > 0 ? ` for ${data.unavailableSymbols.join(", ")}` : "";
  const reasons = (data.errors ?? []).map((error) => error.replace(/^[a-z0-9-]+-\d+: /, ""));
  return {
    message: `${asked} has no data to export${missing}.`,
    details: [
      ...reasons,
      `Check the symbol with gloom search, or run gloom ${asked} without ${formatFlag} to see the report.`,
    ].join("\n"),
  };
}

/** How long a capture's process may stay up after its output, for a report it stopped waiting for. */
const STALLED_REPORT_EXIT_MS = 1_000;

export async function runPaneScreenshot(args: string[], ctx: CliCommandContext) {
  let stalledReport = false;
  try {
    await capturePaneScreenshot(args, ctx, () => { stalledReport = true; });
  } finally {
    // The capture is written and dated without the report it stopped waiting
    // for; a loader that ignores its abort must not hold the process open
    // until it settles. Unref'd, so a process with nothing left exits first.
    if (stalledReport) setTimeout(() => void cliOutputWritten().then(() => process.exit()), STALLED_REPORT_EXIT_MS).unref();
  }
}

async function capturePaneScreenshot(args: string[], ctx: CliCommandContext, onStalledReport: () => void) {
  await runPaneCliCommand(ctx, async () => {
    await withPaneRuntime(ctx, args, async ({ parsed, context, resolved }) => {
      if (parsed.requireBotSafe && (
        !resolved.capability.botSafe || resolved.capability.screenshotReadiness !== "ready"
      )) {
        throw new Error(
          `${resolved.token} is not a verified bot-safe screenshot capability. `
          + `Use "gloom catalog ${resolved.token}" to inspect readiness.`,
        );
      }
      // An option the pane cannot draw fails here, before a capture of its default is saved as if it were the view asked for.
      const refusal = shotOptionRefusal(resolved, parsed.arg, parsed.options, { explain: parsed.explain === true });
      if (refusal) throw new Error(refusal);
      const outputPath = parsed.outputPath
        ? resolve(process.cwd(), ensurePngExtension(parsed.outputPath))
        : defaultScreenshotPath(resolved, parsed.arg);
      const result = await renderDesktopShot({
        resolved,
        context,
        rawArg: parsed.arg,
        outputPath,
        width: parsed.width,
        height: parsed.height,
        theme: parsed.theme,
        scale: parsed.scale,
        watermark: parsed.watermark,
        statusLine: parsed.status !== false,
        fitRows: parsed.heightGiven !== true,
        options: parsed.options,
        onStalledReport,
      });
      if (parsed.requireBotSafe && !result.usable) {
        throw new Error(
          `${resolved.token} did not produce a usable bot-safe screenshot: ${result.unusableReason ?? "unknown reason"}`,
        );
      }
      // Text prints a warning on stderr, out of the way of piped output; JSON carries it in the envelope.
      const read = parsed.listing ? listingReadNotes(parsed.listing) : [];
      const warnings = [...read, ...parsed.listingNotes ?? [], ...shotSizeWarnings(parsed.clamped, parsed)];
      ctx.printResult({ data: result, ...(warnings.length > 0 ? { warnings } : {}) }, {
        text: (data) => {
          const issues = shotStatusIssues(data);
          const stats: CliStatEntry[] = [
            // A board that grows to show every row (FUT) says how many of them the image holds when it could not.
            ["Rows", data.tableRows ? shotRowsText(data.tableRows) : String(data.rowCount)],
            ["Status", issues.length > 0 ? cliStyles.warning(issues.join(", ")) : cliStyles.success("complete")],
          ];
          if (data.render.statusLine) stats.push(["Status line", data.render.statusLine]);
          if (data.unusableReason) stats.push(["Reason", data.unusableReason]);
          if (data.notices?.length) stats.push(["Notes", data.notices.join(" ")]);
          if (data.unavailableSymbols.length > 0) stats.push(["No data for", data.unavailableSymbols.join(", ")]);
          if (data.render.emptyStateMarkers.length > 0) stats.push(["Empty states", data.render.emptyStateMarkers.join(", ")]);
          if (data.render.missingExpectedText.length > 0) stats.push(["Missing text", data.render.missingExpectedText.join(", ")]);
          return [`Saved ${displayPath(data.outputPath)}`, renderStats(stats)].join("\n");
        },
      });
      // The image is saved and the reason printed; --strict tells a script it should not be used.
      if (parsed.strict && !result.usable) process.exitCode = CLI_EXIT_CODES.unusableShot;
    }, { command: "shot" });
  });
}

/** `catalog glossary [term]` and `catalog explain <term>`, which need no market data. */
function runGlossary(term: string, ctx: CliCommandContext): void {
  if (!term) {
    ctx.printResult({ data: GLOSSARY.map(glossaryRecord) }, { text: renderGlossaryIndex });
    return;
  }
  const { exact, partial } = lookupGlossary(term);
  const entries = [...exact, ...partial];
  if (entries.length === 0) {
    ctx.fail(`No glossary entry for "${term}".`, knownGapMessage(term) ?? "gloom catalog glossary lists every term.");
  }
  ctx.printResult({ data: entries.map(glossaryRecord) }, { text: () => renderGlossaryEntries(entries).join("\n") });
}

const GLOSSARY_ACTIONS = new Set(["glossary", "explain"]);

/**
 * The help of a command that runs a function (`fn BT --help`, `shot BT
 * --help`, `help fn BT`): that function's options and examples, as
 * `catalog BT` lists them. The first word is read as `fn` reads it, so a pane
 * id or alias (`fn backtest --help`) helps with what it would run. False when
 * it opens nothing or the catalog cannot be read, so the command's own help prints instead.
 */
export async function runPaneFunctionHelp(command: string, args: string[], ctx: CliCommandContext): Promise<boolean> {
  let target: string;
  try {
    target = parsePaneFunctionArgs(args).target.trim();
  } catch {
    // Intentional ignore: help for arguments that do not parse is the command's own.
    return false;
  }
  if (!target) return false;
  try {
    const entry = await withMarketData(ctx, async (context) => {
      const registry = await createPaneCatalog(context, ctx.plugins);
      try {
        const found = findPaneFunction(registry, target);
        if (!found?.pane) return undefined;
        const { template, pane } = found;
        const entries = await buildPaneCatalogEntries(registry, context);
        // A pane named directly, where functions open it, is helped by the first of them.
        return (template ? entries.find((candidate) => candidate.templateId === template.id) : undefined)
          ?? entries.find((candidate) => candidate.paneId === pane.id);
      } finally {
        registry.destroy();
      }
    });
    if (!entry) return false;
    ctx.printResult({ data: entry }, { text: () => renderFunctionHelp(entry, command) });
    return true;
  } catch (error) {
    logFailure("cli.pane-functions-index", "Read function help failed")(error);
    return false;
  }
}

export async function runPaneCatalog(args: string[], ctx: CliCommandContext) {
  await runPaneCliCommand(ctx, async () => {
    const parsed = parsePaneCatalogArgs(args);
    const [action = "", ...term] = parsed.query.split(/\s+/);
    if (GLOSSARY_ACTIONS.has(action.toLowerCase())) {
      runGlossary(term.join(" "), ctx);
      return;
    }
    const effectiveParsed = {
      ...parsed,
      limit: ctx.cliOptions.limit ?? parsed.limit,
    };
    await withMarketData(ctx, async (context) => {
      const registry = await createPaneCatalog(context, ctx.plugins);
      try {
        const entries = await buildPaneCatalogEntries(registry, context);
        const botSafeEntries = effectiveParsed.botSafeOnly
          ? entries.filter((entry) => entry.capability.botSafe)
          : entries;
        // A topic no function covers is answered by its pointer, not by the loose matches its words find.
        const pointer = topicPointer(parsed.query);
        const filtered = pointer ? [] : filterPaneCatalogEntries(botSafeEntries, parsed.query);
        // A search also finds the terms it names; text only, the JSON stays a list of functions.
        const glossary = lookupGlossary(parsed.query);
        // Data no source carries yet is said once: in the text, else as the envelope's warning.
        const gap = knownGapMessage(parsed.query);
        // A setting or a report can be a command, not a function: "light theme" names `config themes` beside THEM,
        // "drip" names `portfolio show --drip` beside DVD.
        const setting = commandPointer(parsed.query);
        const settingLeads = commandPointerLeads(parsed.query);
        // The data catalog series the query names, which `fn G` charts.
        const series = findCatalogSeries(ctx.plugins, parsed.query);
        const listed = pointer
          ? pointer.codes.flatMap((code) => entries.filter((entry) => entry.token === code))
          : selectPaneCatalogMatches(filtered, parsed.query, effectiveParsed.limit).shown;
        ctx.printResult({
          data: listed,
          ...series.length ? { metadata: { series } } : {},
          ...(gap || setting) && ctx.cliOptions.format !== "text" ? { warnings: [gap, setting].filter((note): note is string => !!note) } : {},
        }, {
          text: () => renderPaneCatalogReport(filtered, effectiveParsed, glossary, gap, series, setting, settingLeads),
        });
      } finally {
        registry.destroy();
      }
    });
  });
}

async function runPaneCliCommand(ctx: CliCommandContext, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    // A failure with fields for --json (`ticker_moved`, its change and retry) keeps its code and them.
    if (isCliFailure(error) && error.fields) throw error;
    // A listing it cannot use says what to type instead; a name that opens nothing, what is close to it.
    if (error instanceof ListingArgError || error instanceof UnknownPaneFunctionError) ctx.fail(error.message, error.details || undefined);
    const message = error instanceof Error ? error.message : String(error);
    // A failure the command already worded keeps its advice line.
    const stated = error instanceof Error ? (error as Error & { details?: unknown }).details : undefined;
    const details = typeof stated === "string" ? stated : undefined;
    ctx.fail(message, details);
  }
}

/** A path under the working directory reads shorter relative to it. */
function displayPath(path: string): string {
  const relativePath = relative(process.cwd(), path);
  return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath) ? relativePath : path;
}

function ensurePngExtension(path: string): string {
  return extname(path) ? path : `${path}.png`;
}

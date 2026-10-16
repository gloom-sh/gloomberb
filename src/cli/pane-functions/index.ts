import { extname, isAbsolute, relative, resolve } from "path";
import type { CliCommandContext, HeadlessArgumentExpansion } from "../../types/plugin";
import type { MarketContext } from "../types";
import { withMarketData } from "../context";
import { cliStyles, renderStats, type CliStatEntry } from "../../utils/cli-output";
import {
  filterPaneCatalogEntries,
  findFunctionCode,
  nearFunctionCodes,
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
import { applyListingArgument, resolvePaneFunction, UnknownPaneFunctionError, type ResolvedPaneFunction } from "./resolver";
import { buildFunctionReport } from "./report";
import { expandResolvedArgument } from "./headless";
import { defaultScreenshotPath, renderDesktopShot, shotSizeWarnings, shotStatusIssues } from "./screenshot";
import {
  buildPaneCatalogEntries,
} from "./catalog";
import { incompleteReportGateMessage } from "./access-gate";
import { withPersistedCloudSession } from "./cloud-session";
import {
  ListingArgError, listingFateLoader, listingReadNotes, loadForListing, loadListingQuoteAnswer, quotedListingChoiceNotes, refuseMovedListing,
} from "../listing-arg";
import { isNotATickerMessage } from "../not-a-ticker";
import { isCliFailure } from "../errors";
import { isTickerLinkPeer } from "../../layout/ticker-navigation";
import { knownGapMessage, settingsPointer, topicPointer } from "../known-gaps";
import { selectReportTables } from "../report-tables";
import { cliOutputWritten } from "../result";
import type { CatalogCommandHit } from "../unknown-command";
import { CLI_EXIT_CODES } from "../exit-codes";
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
      let parsed = await applyListingArgument(registry, context, parsePaneFunctionArgs(args, ctx.cliOptions), settings.command);
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
 * What to run when a command name is a function's code (`gloomberb OVDV KO`,
 * `gloomberb help OVDV`): `fn` with the reader's own arguments, or the
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
    return { code, command: ["gloomberb fn", code, args.length > 0 ? args.map(commandWord).join(" ") : found.argument].filter(Boolean).join(" ") };
  } catch {
    return null;
  }
}

/**
 * The one function code a command name is a slip from (`gloomberb RCDF PLTR`
 * for RDCF), with the command that runs it on the reader's arguments. Null
 * when no code, or more than one, is that close, or the catalog cannot be read.
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
        return nearFunctionCodes(registry, word);
      } finally {
        registry.destroy();
      }
    });
    if (near.length !== 1) return null;
    const { code, label } = near[0]!;
    return { code, label, command: ["gloomberb fn", code, ...args.map(commandWord)].join(" ") };
  } catch {
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
  } catch {
    return [];
  }
}

/** Whether a list report has no row with data: it is empty, or every row is a name without any. */
function foundNothing(data: { rowCount: number; unavailableSymbols: readonly string[] }): boolean {
  return data.rowCount === 0 || data.unavailableSymbols.length >= data.rowCount;
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
          + `Use "gloomberb catalog ${resolved.token}" to inspect readiness.`,
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
      const moved = { command: "fn", retry: (key: string) => `gloomberb fn ${resolved.token} ${key}` };
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
      // "Not a ticker: PALANTIR. Try `gloomberb search Palantir`.", not an empty report.
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
      // The report states its own freshness in its data and text; JSON cites it as `source` too.
      ctx.printResult({ data, exportFreshness: report.data.freshness, ...(warnings.length > 0 ? { warnings } : {}) }, {
        text: () => glossary ? `${report.text}\n\n${renderReportGlossary(resolved.token, glossary)}` : report.text,
        ...(tabular ? { tables: selectReportTables(report.tables, resolved.tableSection) } : {}),
      });
      // The report is printed as it is; a list that found data for none of its names says so in the exit status too.
      if (resolved.headless?.failsWithoutData && foundNothing(report.data)) process.exitCode = CLI_EXIT_CODES.error;
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
      details: `Chart it with the fred: prefix: gloomberb fn G ${ids.map((id) => `fred:${id}`).join(",")} ${formatFlag}`
        + `${ids.length === 1 ? ` (or gloomberb fred ${ids[0]} ${formatFlag})` : ""}.`,
    };
  }
  const missing = data.unavailableSymbols.length > 0 ? ` for ${data.unavailableSymbols.join(", ")}` : "";
  const reasons = (data.errors ?? []).map((error) => error.replace(/^[a-z0-9-]+-\d+: /, ""));
  return {
    message: `${asked} has no data to export${missing}.`,
    details: [
      ...reasons,
      `Check the symbol with gloomberb search, or run gloomberb ${asked} without ${formatFlag} to see the report.`,
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
          + `Use "gloomberb catalog ${resolved.token}" to inspect readiness.`,
        );
      }
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
            ["Rows", String(data.rowCount)],
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
    ctx.fail(`No glossary entry for "${term}".`, knownGapMessage(term) ?? "gloomberb catalog glossary lists every term.");
  }
  ctx.printResult({ data: entries.map(glossaryRecord) }, { text: () => renderGlossaryEntries(entries).join("\n") });
}

const GLOSSARY_ACTIONS = new Set(["glossary", "explain"]);

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
        // A setting is a command, not a function: "light theme" names `config themes` beside THEM.
        const setting = settingsPointer(parsed.query);
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
          text: () => renderPaneCatalogReport(filtered, effectiveParsed, glossary, gap, series, setting),
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

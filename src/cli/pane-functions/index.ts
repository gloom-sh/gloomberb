import { extname, isAbsolute, relative, resolve } from "path";
import type { CliCommandContext } from "../../types/plugin";
import type { MarketContext } from "../types";
import { withMarketData } from "../context";
import { cliStyles, renderStats, type CliStatEntry } from "../../utils/cli-output";
import {
  filterPaneCatalogEntries,
  findFunctionCode,
  renderPaneCatalogReport,
  selectPaneCatalogMatches,
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
import { defaultScreenshotPath, renderDesktopShot, shotSizeWarnings, shotStatusIssues } from "./screenshot";
import {
  buildPaneCatalogEntries,
} from "./catalog";
import { incompleteReportGateMessage } from "./access-gate";
import { withPersistedCloudSession } from "./cloud-session";
import { ListingArgError, listingReadNotes, loadForListing, quotedListingChoiceNotes } from "../listing-arg";
import { knownGapMessage, settingsPointer, topicPointer } from "../known-gaps";
import { selectReportTables } from "../report-tables";
import { cliOutputWritten } from "../result";
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
      const parsed = await applyListingArgument(registry, context, parsePaneFunctionArgs(args, ctx.cliOptions), settings.command);
      const resolved = await resolvePaneFunction(registry, context, parsed, settings);
      return await run({ parsed, context, registry, resolved });
    } finally {
      registry.destroy();
    }
  });
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

export async function runPaneFunction(args: string[], ctx: CliCommandContext) {
  await runPaneCliCommand(ctx, async () => {
    await withPaneRuntime(ctx, args, async ({ parsed, context, resolved }) => {
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
      // A report that fails or comes back empty for an exchange the symbol is not listed on says so.
      const report = await withPersistedCloudSession(
        context,
        () => loadForListing(
          parsed.listing ?? [],
          context,
          ctx,
          () => buildFunctionReport(resolved, context, parsed.arg),
          (built) => built.data.empty || !built.data.complete,
        ),
      );
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
    // A listing it cannot use says what to type instead; a name that opens nothing, what is close to it.
    if (error instanceof ListingArgError || error instanceof UnknownPaneFunctionError) ctx.fail(error.message, error.details);
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

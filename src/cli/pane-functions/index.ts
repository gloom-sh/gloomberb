import { extname, isAbsolute, relative, resolve } from "path";
import type { CliCommandContext } from "../../types/plugin";
import type { MarketContext } from "../types";
import { withMarketData } from "../context";
import { cliStyles, renderStats, type CliStatEntry } from "../../utils/cli-output";
import {
  filterPaneCatalogEntries,
  renderPaneCatalogReport,
  type PaneFunctionCatalog,
} from "./catalog";
import { createPaneCatalog } from "./discovery";
import {
  parsePaneCatalogArgs,
  parsePaneFunctionArgs,
  type ParsedPaneFunctionArgs,
} from "./options";
import { applyListingArgument, resolvePaneFunction, type ResolvedPaneFunction } from "./resolver";
import { buildFunctionReport } from "./report";
import { defaultScreenshotPath, renderDesktopShot, shotSizeWarnings } from "./screenshot";
import {
  buildPaneCatalogEntries,
} from "./catalog";
import { accessGateStatus, incompleteReportGateMessage } from "./access-gate";
import { withPersistedCloudSession } from "./cloud-session";
import { ListingArgError, listingReadNotes, loadForListing, quotedListingChoiceNotes } from "../listing-arg";
import { knownGapMessage } from "../known-gaps";
import { selectReportTables } from "../report-tables";
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

export async function runPaneFunction(args: string[], ctx: CliCommandContext) {
  await runPaneCliCommand(ctx, async () => {
    await withPaneRuntime(ctx, args, async ({ parsed, context, resolved }) => {
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
      // --explain follows the report with the terms it shows; JSON lists them under `glossary`.
      const glossary = parsed.explain ? reportGlossary(resolved.token, report.text) : null;
      const data = glossary
        ? { ...report.data, glossary: glossary.map(({ term, short, definition }) => ({ term, ...(short ? { short } : {}), definition })) }
        : report.data;
      const warnings = [...parsed.listingNotes ?? [], ...await choice ?? []];
      // The report states its own freshness in its data and text; JSON cites it as `source` too.
      ctx.printResult({ data, exportFreshness: report.data.freshness, ...(warnings.length > 0 ? { warnings } : {}) }, {
        text: () => glossary ? `${report.text}\n\n${renderReportGlossary(resolved.token, glossary)}` : report.text,
        ...(tabular ? { tables: selectReportTables(report.tables, resolved.tableSection) } : {}),
      });
    }, { strictHeadlessOptions: true, tableSection: true });
  });
}

export async function runPaneScreenshot(args: string[], ctx: CliCommandContext) {
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
          const issues = [
            data.render.accessGate && (data.empty || !data.usable) ? accessGateStatus(data.render.accessGate) : data.empty ? "empty" : null,
            data.complete ? null : "incomplete",
            data.semanticMismatch ? "does not match the data" : null,
            data.usable ? null : "not usable",
          ].filter((issue): issue is string => issue != null);
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
    ctx.fail(`No glossary entry for "${term}".`, "gloomberb catalog glossary lists every term.");
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
        const filtered = filterPaneCatalogEntries(botSafeEntries, parsed.query);
        // A search also finds the terms it names; text only, the JSON stays a list of functions.
        const glossary = lookupGlossary(parsed.query);
        // Data no source carries yet is said once: in the text, else as the envelope's warning.
        const gap = knownGapMessage(parsed.query);
        ctx.printResult({
          data: filtered.slice(0, effectiveParsed.limit),
          ...gap && ctx.cliOptions.format !== "text" ? { warnings: [gap] } : {},
        }, {
          text: () => renderPaneCatalogReport(filtered, effectiveParsed, glossary, gap),
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
    // A listing it cannot use says what to type instead.
    if (error instanceof ListingArgError) ctx.fail(error.message, error.details);
    const message = error instanceof Error ? error.message : String(error);
    ctx.fail(message);
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

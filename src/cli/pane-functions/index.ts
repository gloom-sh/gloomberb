import { extname, resolve } from "path";
import type { CliCommandContext } from "../../types/plugin";
import type { MarketContext } from "../types";
import { withMarketData } from "../context";
import {
  filterPaneCatalogEntries,
  renderPaneCatalogReport,
  type PaneFunctionCatalog,
} from "./catalog";
import { createPaneCatalog } from "./discovery";
import {
  normalizeLookupToken,
  optionPaneState,
  parseArgumentsOption,
  parsePaneCatalogArgs,
  parsePaneFunctionArgs,
  type ParsedPaneFunctionArgs,
} from "./options";
import { resolvePaneFunction, type ResolvedPaneFunction } from "./resolver";
import { buildFunctionReport } from "./report";
import { defaultScreenshotPath, renderDesktopShot } from "./screenshot";
import {
  buildPaneCatalogEntries,
} from "./catalog";
import {
  capabilityPluginState,
  getPaneFunctionCapability,
  normalizeCapabilityOptions,
} from "./capabilities";

async function withPaneRuntime<T>(
  ctx: CliCommandContext,
  args: string[],
  run: (runtime: {
    parsed: ParsedPaneFunctionArgs;
    context: MarketContext;
    registry: PaneFunctionCatalog;
    resolved: ResolvedPaneFunction;
  }) => Promise<T>,
): Promise<T> {
  const parsed = parsePaneFunctionArgs(args);
  return withMarketData(ctx, async (context) => {
    const registry = await createPaneCatalog(context, ctx.plugins);
    try {
      const resolved = await resolvePaneFunction(registry, context, parsed);
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
      const report = await buildFunctionReport(resolved, context, parsed.arg);
      if (parsed.requireBotSafe && (report.data.empty || !report.data.complete)) {
        const unavailable = report.data.unavailableSymbols.length > 0
          ? ` Missing data for ${report.data.unavailableSymbols.join(", ")}.`
          : "";
        throw new Error(
          `${resolved.token} did not produce a complete bot-safe report.${unavailable}`,
        );
      }
      ctx.printResult({ data: report.data }, {
        text: () => report.text,
      });
    });
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
        options: parsed.options,
      });
      if (parsed.requireBotSafe && !result.usable) {
        throw new Error(
          `${resolved.token} did not produce a usable bot-safe screenshot: `
          + `${result.empty ? "empty render" : ""}${result.empty && !result.complete ? ", " : ""}`
          + `${!result.complete ? `missing data for ${result.unavailableSymbols.join(", ")}` : ""}`
          + `${result.semanticMismatch ? `${(result.empty || !result.complete) ? ", " : ""}rendered content did not match the requested capability` : ""}`,
        );
      }
      ctx.printResult({ data: result }, {
        text: (data) => [
          `Saved screenshot to ${data.outputPath}`,
          `Result: ${data.rowCount} semantic rows; empty=${data.empty}; complete=${data.complete}; mismatch=${data.semanticMismatch}; usable=${data.usable}`,
          ...(data.unavailableSymbols.length > 0
            ? [`Unavailable symbols: ${data.unavailableSymbols.join(", ")}`]
            : []),
          ...(data.render.emptyStateMarkers.length > 0
            ? [`Empty markers: ${data.render.emptyStateMarkers.join(", ")}`]
            : []),
          ...(data.render.missingExpectedText.length > 0
            ? [`Missing expected text: ${data.render.missingExpectedText.join(", ")}`]
            : []),
        ].join("\n"),
      });
    });
  });
}

export async function runPaneCatalog(args: string[], ctx: CliCommandContext) {
  await runPaneCliCommand(ctx, async () => {
    const parsed = parsePaneCatalogArgs(args);
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
        if (ctx.cliOptions.format === "text") {
          console.log(renderPaneCatalogReport(filtered, effectiveParsed));
        } else {
          ctx.printResult({ data: filtered.slice(0, effectiveParsed.limit) });
        }
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
    const message = error instanceof Error ? error.message : String(error);
    ctx.fail(message);
  }
}

function ensurePngExtension(path: string): string {
  return extname(path) ? path : `${path}.png`;
}

export const paneFunctionTestInternals = {
  parsePaneFunctionArgs,
  parsePaneCatalogArgs,
  normalizeLookupToken,
  parseArgumentsOption,
  optionPaneState,
  filterPaneCatalogEntries,
  renderPaneCatalogReport,
  getPaneFunctionCapability,
  normalizeCapabilityOptions,
  capabilityPluginState,
};

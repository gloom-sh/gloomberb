import { readFile } from "fs/promises";
import { homedir } from "os";
import { saveConfig } from "../../../../data/config/store";
import { withCollectionMarketData } from "../../../../cli/suffixed-listing-rows";
import { resolveTickersForCli } from "../../../../cli/ticker-resolution";
import { StagedTickerRepository } from "../../../../cli/staged-tickers";
import { listingFields, savedListingName } from "../../../../cli/listing-arg";
import { cliStyles, renderStats, renderTable } from "../../../../utils/cli-output";
import { findNamedCollection } from "../../../../portfolio/collection-name";
import { tickerChangeLine } from "../../../../tickers/ticker-changes";
import { createManualPortfolio, isManualPortfolio } from "../../../../portfolio/mutations";
import {
  parsePositionsFile,
  POSITIONS_EXPORT_BROKERS,
  POSITIONS_LAYOUT_NAMES,
  PositionsFileError,
  type PositionsFile,
} from "../../../../portfolio/positions-import/parse";
import {
  defaultImportPortfolioName,
  positionsImportCost,
  positionsImportShares,
  positionsImportSource,
  positionsImportStatus,
} from "../../../../portfolio/positions-import/describe";
import {
  applyPositionsImportPlan,
  buildPositionsImportPlan,
  summarizePositionsImport,
  type ImportSymbolResolution,
  type PositionsImportMode,
  type PositionsImportPlan,
} from "../../../../portfolio/positions-import/plan";
import type { CliCommandContext } from "../../../../types/plugin";
import type { Portfolio, TickerRecord } from "../../../../types/ticker";
import { progressNotice, retryNotice } from "./bulk-symbols";
import { failPortfolioCommand, PortfolioCliError } from "./shared";

export const POSITIONS_IMPORT_USAGE = "Usage: gloom portfolio import <file> [--name <portfolio>] [--merge | --replace] [--dry-run]";

/** What `portfolio import <file>` says in its help. */
export const POSITIONS_IMPORT_HELP = {
  title: "Importing a broker's positions",
  lines: [
    `portfolio import <file> reads the positions export (CSV) a brokerage's positions or holdings page downloads: ${POSITIONS_EXPORT_BROKERS.join(", ")}, or any table with a Symbol (or Ticker) and a Quantity (or Shares) column, and a cost in total (Cost Basis) or per share (Avg Cost, Price Paid), a purchase date (Date Acquired) and a Currency where it has them. US brokers' exports are in USD.`,
    "Each symbol becomes a position of shares at its cost per share; rows of one symbol (several accounts or lots) are added up, dated by the earliest. Totals, footers and account headings are left out. Cash and money market sweeps, pending activity, options, bonds and CDs, rows without a ticker and symbols that do not resolve are listed as skipped, each with the reason.",
    "The portfolio is named after the broker (or the file) unless --name says otherwise, and is created when it does not exist. One that holds tickers needs --merge (the file's positions replace those of the same listings; the rest stay) or --replace (holdings the file does not list are removed, with their targets). A position the file gives no cost for keeps the holding's own cost, else it has none.",
    "--dry-run looks every symbol up and prints the same table without saving. In the app, Import Positions… in the PF pane menu shows the same preview before it saves.",
  ],
};

export interface PositionsImportOptions {
  path: string;
  name: string | undefined;
  mode: PositionsImportMode | null;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

async function readPositionsText(path: string, readStdin: () => Promise<string>): Promise<string> {
  if (path === "-") return readStdin();
  try {
    return await readFile(expandHome(path), "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PortfolioCliError(code === "ENOENT" ? `No file at ${path}.` : `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function importHeadline(plan: PositionsImportPlan, portfolio: Portfolio, created: boolean, dryRun: boolean, path: string): string {
  const summary = summarizePositionsImport(plan);
  const count = `${plan.rows.length} position${plan.rows.length === 1 ? "" : "s"}`;
  const source = `from ${positionsImportSource(plan.layout, path)}`;
  if (created) return `${dryRun ? "Would create" : "Created"} portfolio "${portfolio.name}" with ${count} ${source}.`;
  if (plan.mode === "replace" && summary.removed > 0) {
    return `${dryRun ? "Would replace" : "Replaced"} the holdings of "${portfolio.name}" with ${count} ${source}, removing ${summary.removed}.`;
  }
  return `${dryRun ? "Would import" : "Imported"} ${count} into "${portfolio.name}" ${source} (${summary.added} new, ${summary.updated} updated).`;
}

/**
 * `portfolio import <file>`: a broker's positions export into a manual
 * portfolio, made when it does not exist. Every symbol is looked up first;
 * --dry-run prints what the import would do and saves nothing.
 */
export async function importPositionsFileCommand(
  options: PositionsImportOptions,
  ctx: CliCommandContext,
  readStdin: () => Promise<string> = () => Bun.stdin.text(),
) {
  const dryRun = ctx.cliOptions.dryRun === true;
  let file: PositionsFile;
  try {
    file = parsePositionsFile(await readPositionsText(options.path, readStdin));
  } catch (error) {
    if (error instanceof PositionsFileError) {
      // A list of symbols without shares is what `portfolio add --file` reads.
      ctx.fail(`${options.path}: ${error.message}`, `To add a list of symbols without shares, run: gloom portfolio add <portfolio> --file ${options.path}\n${POSITIONS_IMPORT_USAGE}`);
    }
    return failPortfolioCommand(ctx, error, `Failed to read ${options.path}.`);
  }
  await withCollectionMarketData(ctx, async ({ config, store, dataProvider }) => {
    try {
      const name = options.name ?? defaultImportPortfolioName(file.layout, options.path);
      const existing = findNamedCollection(config.portfolios, name);
      if (existing && !isManualPortfolio(existing)) {
        throw new PortfolioCliError(`Portfolio "${existing.name}" is broker-managed and cannot be imported into.`, "Name another with --name.");
      }
      const holdings = existing ? (await store.loadAllTickers()).filter((ticker) => ticker.metadata.portfolios.includes(existing.id)) : [];
      if (existing && holdings.length > 0 && !options.mode) {
        throw new PortfolioCliError(
          `Portfolio "${existing.name}" already holds ${holdings.length} ticker${holdings.length === 1 ? "" : "s"}.`,
          `Add --merge to update it with the file's positions, --replace to make it hold only them, or --name to import into a new portfolio.\n${POSITIONS_IMPORT_USAGE}`,
        );
      }
      const created = existing ? null : createManualPortfolio(config, name, config.baseCurrency);
      const portfolio = existing ?? created!.portfolio;

      // Looked up as `portfolio add` looks a list up; listings found are kept in memory until the import is saved.
      const staged = new StagedTickerRepository(store);
      const symbols = file.positions.map((position) => position.symbol);
      const lookups = symbols.length > 0
        ? await resolveTickersForCli(symbols, staged, dataProvider, undefined, { onRetry: retryNotice(ctx), onProgress: progressNotice(ctx) })
        : [];
      // A broker's symbols are its own market's listings: a row says only that a symbol changed or stopped trading.
      const resolutions = new Map<string, ImportSymbolResolution>(lookups.map((lookup) => [
        lookup.input,
        lookup.error
          ? { error: lookup.error.message }
          : { ticker: lookup.ticker, notes: [tickerChangeLine(lookup.change), lookup.ended].filter((note): note is string => !!note) },
      ]));
      const plan = buildPositionsImportPlan({
        file, resolutions, portfolio, holdings, mode: options.mode ?? "merge", baseCurrency: config.baseCurrency,
      });
      if (plan.rows.length === 0) {
        throw new PortfolioCliError(
          `None of the positions in ${options.path} could be imported.`,
          plan.skipped.map((row) => `line ${row.line} ${row.label}: ${row.reason}`).join("\n"),
        );
      }

      if (!dryRun) {
        const latest = new Map<string, TickerRecord>([...lookups.flatMap((lookup) => lookup.ticker ? [lookup.ticker] : []), ...holdings]
          .map((ticker) => [ticker.metadata.ticker, ticker] as const));
        const applied = applyPositionsImportPlan(plan, {
          portfolioId: portfolio.id,
          config: created?.config ?? config,
          holdings,
          current: (key) => latest.get(key),
        });
        await store.saveTickers(applied.tickers);
        const nextConfig = applied.config ?? created?.config;
        if (nextConfig) await saveConfig(nextConfig);
      }

      const positions = plan.rows.map((row) => ({
        ...listingFields(savedListingName(row.ticker)),
        symbols: row.symbols,
        shares: row.shares,
        avgCost: row.avgCost,
        currency: row.currency,
        dateAcquired: row.dateAcquired,
        status: row.heldShares === null ? "new" : "updated",
        heldShares: row.heldShares,
        costKept: row.keptCost,
        lines: row.lines,
        ...(row.notes.length > 0 ? { notes: row.notes } : {}),
      }));
      const removed = plan.removed.map((ticker) => listingFields(savedListingName(ticker)));
      const withoutCost = plan.rows.filter((row) => row.avgCost === null);
      const dated = plan.rows.some((row) => row.dateAcquired);
      ctx.printResult({
        data: {
          changed: !dryRun,
          dryRun,
          action: created ? "created" : options.mode ?? "merge",
          portfolio: portfolio.name,
          portfolioId: portfolio.id,
          format: POSITIONS_LAYOUT_NAMES[plan.layout],
          layout: plan.layout,
          positions,
          skipped: plan.skipped,
          removed,
        },
        ...withoutCost.length > 0
          ? { warnings: [`No cost in the file for ${withoutCost.map((row) => savedListingName(row.ticker).key).join(", ")}; set it with portfolio position set.`] }
          : {},
      }, {
        text: () => [
          cliStyles.success(importHeadline(plan, portfolio, !!created, dryRun, options.path)),
          "",
          renderTable(
            [
              { header: "Ticker" }, { header: "Name" }, { header: "Shares", align: "right" }, { header: "Avg Cost", align: "right" },
              ...dated ? [{ header: "Bought" }] : [], { header: "Status" },
            ],
            plan.rows.map((row) => {
              const saved = savedListingName(row.ticker);
              return [
                saved.key, saved.name ?? "", positionsImportShares(row), positionsImportCost(row),
                ...dated ? [row.dateAcquired ?? ""] : [], positionsImportStatus(row),
              ];
            }),
          ),
          ...plan.rows.flatMap((row) => row.notes.map((note) => cliStyles.muted(`${savedListingName(row.ticker).key}: ${note}`))),
          ...plan.skipped.length > 0
            ? ["", cliStyles.warning(`Skipped ${plan.skipped.length} row${plan.skipped.length === 1 ? "" : "s"}:`),
              renderTable([{ header: "Line", align: "right" }, { header: "Row" }, { header: "Reason" }],
                plan.skipped.map((row) => [String(row.line), row.label, row.reason]))]
            : [],
          ...removed.length > 0
            ? ["", cliStyles.warning(`${dryRun ? "Would remove" : "Removed"} ${removed.map((entry) => entry.listing).join(", ")}: not in the file.`)]
            : [],
          dryRun ? cliStyles.muted("Dry run: nothing saved.") : renderStats([["ID", portfolio.id]]),
        ].join("\n"),
      });
    } catch (error) {
      failPortfolioCommand(ctx, error, `Failed to import ${options.path}.`);
    }
  });
}

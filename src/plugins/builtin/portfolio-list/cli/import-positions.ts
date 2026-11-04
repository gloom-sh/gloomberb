import { readFile, stat } from "fs/promises";
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
  decodePositionsFile,
  MAX_IMPORT_POSITIONS,
  MAX_POSITIONS_FILE_BYTES,
  parsePositionsFile,
  POSITIONS_EXPORT_BROKERS,
  POSITIONS_LAYOUT_NAMES,
  PositionsFileError,
  type PositionsFile,
} from "../../../../portfolio/positions-import/parse";
import {
  defaultImportPortfolioName,
  moreSkippedLine,
  positionsImportCost,
  positionsImportShares,
  positionsImportSource,
  positionsImportStatus,
  PREVIEW_ROWS_SHOWN,
} from "../../../../portfolio/positions-import/describe";
import {
  applyPositionsImportPlan,
  buildPositionsImportPlan,
  replaceRefusal,
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
    `portfolio import <file> reads the positions export (CSV) a brokerage's positions or holdings page downloads: ${POSITIONS_EXPORT_BROKERS.join(", ")}, or any table with a Symbol (or Ticker) and a Quantity (or Shares) column, and a cost in total (Cost Basis) or per share (Avg Cost, Price Paid), a purchase date (Date Acquired) and a Currency where it has them. US brokers' exports are in USD. A file takes at most ${MAX_IMPORT_POSITIONS.toLocaleString("en-US")} positions; a trade or activity history is refused.`,
    "Each symbol becomes a position of shares at its cost per share; rows of one symbol (several accounts or lots) are added up, dated by the earliest. Totals, footers and account headings are left out. Cash and money market sweeps, pending activity, options, bonds and CDs, rows without a ticker and symbols that do not resolve are listed as skipped, each with the reason.",
    "The portfolio is named after the broker (or the file) unless --name says otherwise, and is created when it does not exist. One that holds tickers needs --merge (the file's positions replace those of the same listings, a holding's lots becoming one position; the rest stay) or --replace (holdings the file does not list are removed, with their targets). A replace is refused while any of the file's stock or fund rows could not be imported, and never removes a holding the file names on a skipped row. A position the file gives no cost for keeps the holding's own cost, else it has none.",
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

function tooLarge(path: string): PortfolioCliError {
  return new PortfolioCliError(`${path === "-" ? "Standard input" : path} is too large to be a positions export (over ${MAX_POSITIONS_FILE_BYTES / 1024 / 1024} MB).`);
}

/** The file's text, in whichever encoding it was saved; refused past the size of any positions export. */
async function readPositionsText(path: string, readStdin: () => Promise<Uint8Array>): Promise<string> {
  if (path === "-") {
    const bytes = await readStdin();
    if (bytes.length > MAX_POSITIONS_FILE_BYTES) throw tooLarge(path);
    return decodePositionsFile(bytes);
  }
  const resolved = expandHome(path);
  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new PortfolioCliError(`${path} is not a file.`);
    if (info.size > MAX_POSITIONS_FILE_BYTES) throw tooLarge(path);
    return decodePositionsFile(await readFile(resolved));
  } catch (error) {
    if (error instanceof PortfolioCliError) throw error;
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
  readStdin: () => Promise<Uint8Array> = async () => new Uint8Array(await Bun.stdin.arrayBuffer()),
) {
  const dryRun = ctx.cliOptions.dryRun === true;
  let file: PositionsFile;
  try {
    file = parsePositionsFile(await readPositionsText(options.path, readStdin));
  } catch (error) {
    if (error instanceof PositionsFileError) {
      // A list of symbols without shares is what `portfolio add --file` reads.
      const listHint = error.problem === "no-table" ? `To add a list of symbols without shares, run: gloom portfolio add <portfolio> --file ${options.path}\n` : "";
      ctx.fail(`${options.path}: ${error.message}`, `${listHint}${POSITIONS_IMPORT_USAGE}`);
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
      // A portfolio that holds nothing has nothing to replace: the file goes into it either way.
      const mode = options.mode === "replace" && holdings.length > 0 ? "replace" : "merge";
      const plan = buildPositionsImportPlan({ file, resolutions, portfolio, holdings, mode, baseCurrency: config.baseCurrency });
      const skippedLines = (rows: PositionsImportPlan["skipped"]) => [
        ...rows.slice(0, PREVIEW_ROWS_SHOWN).map((row) => `line ${row.line} ${row.label}: ${row.reason}`),
        ...[moreSkippedLine(rows.length)].filter((line): line is string => !!line),
      ].join("\n");
      if (plan.rows.length === 0) {
        throw new PortfolioCliError(`None of the positions in ${options.path} could be imported.`, skippedLines(plan.skipped));
      }
      const refusal = plan.mode === "replace" ? replaceRefusal(plan, "Use --merge instead") : null;
      if (refusal) {
        throw new PortfolioCliError(
          `Not replacing "${portfolio.name}". ${refusal}`,
          skippedLines(plan.replaceBlockers),
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
        heldLots: row.heldLots,
        costKept: row.keptCost,
        lines: row.lines,
        ...(row.notes.length > 0 ? { notes: row.notes } : {}),
      }));
      const removed = plan.removed.map((ticker) => listingFields(savedListingName(ticker)));
      const kept = plan.kept.map((ticker) => listingFields(savedListingName(ticker)));
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
          ...(plan.mode === "replace" ? { kept } : {}),
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
                // With the currency's sign, as portfolio show prints a position's cost.
                saved.key, saved.name ?? "", positionsImportShares(row), positionsImportCost(row, { withCurrency: true }),
                ...dated ? [row.dateAcquired ?? ""] : [], positionsImportStatus(row),
              ];
            }),
          ),
          ...plan.rows.flatMap((row) => row.notes.map((note) => cliStyles.muted(`${savedListingName(row.ticker).key}: ${note}`))),
          ...plan.skipped.length > 0
            ? ["", cliStyles.warning(`Skipped ${plan.skipped.length} row${plan.skipped.length === 1 ? "" : "s"}:`),
              renderTable([{ header: "Line", align: "right" }, { header: "Row" }, { header: "Reason" }],
                plan.skipped.slice(0, PREVIEW_ROWS_SHOWN).map((row) => [String(row.line), row.label, row.reason])),
              ...[moreSkippedLine(plan.skipped.length)].filter((line): line is string => !!line).map((line) => cliStyles.muted(`${line}; --json lists them all.`))]
            : [],
          ...removed.length > 0
            ? ["", cliStyles.warning(`${dryRun ? "Would remove" : "Removed"} ${removed.map((entry) => entry.listing).join(", ")}: not in the file.`)]
            : [],
          ...kept.length > 0
            ? [cliStyles.muted(`${dryRun ? "Would keep" : "Kept"} ${kept.map((entry) => entry.listing).join(", ")}: the file lists ${kept.length === 1 ? "it" : "them"} on a skipped row.`)]
            : [],
          dryRun ? cliStyles.muted("Dry run: nothing saved.") : renderStats([["ID", portfolio.id]]),
        ].join("\n"),
      });
    } catch (error) {
      failPortfolioCommand(ctx, error, `Failed to import ${options.path}.`);
    }
  });
}

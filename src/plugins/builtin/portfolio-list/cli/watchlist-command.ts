import { saveConfig } from "../../../../data/config/store";
import { withConfigData } from "../../../../cli/scoped-context";
import { withCollectionConfigData, withCollectionMarketData } from "../../../../cli/suffixed-listing-rows";
import { countCollectionTickers, findWatchlist } from "../../../../cli/helpers";
import { slugifyName } from "../../../../utils/slugify";
import { takeOption } from "../../../../cli/commands/command-utils";
import { EXCHANGE_OPTION, requireSavedListing, savedListingName } from "../../../../cli/listing-arg";
import {
  cliStyles,
  renderSection,
  renderStats,
  renderTable,
} from "../../../../utils/cli-output";
import type { AppConfig } from "../../../../types/config";
import type { CliCommandContext, CliCommandDef } from "../../../../types/plugin";
import type { Watchlist } from "../../../../types/ticker";
import type { ConfigContext, MarketContext } from "../../../../cli/types";
import {
  addTickerToWatchlist,
  deleteWatchlist as deleteWatchlistConfig,
  removeTickerFromWatchlist as removeWatchlistMembership,
} from "../../../../portfolio/mutations";
import { showCollection } from "./render";
import { listingFields, misplacedSymbolList, refuseDryRun, takeCollectionName } from "./shared";
import { addOneSymbol, addSymbols, FILE_OPTION, printSymbolRows, removeSymbols, requireSymbolList, retryNotice, shellWord, SYMBOL_LIST_HELP } from "./bulk-symbols";
import { readNameEntries } from "../../../../cli/name-entries";
import { CLI_COMMAND_GROUPS } from "../../../../cli/help";

const ADD_USAGE = "Usage: gloom watchlist add <watchlist> <symbols...> [--file <path>]";
const REMOVE_USAGE = "Usage: gloom watchlist remove <watchlist> <symbols...> [--file <path>]";

/** Actions that change a watchlist without a preview, so --dry-run would change it anyway. add previews. */
const MUTATING_ACTIONS = new Set(["create", "delete", "rm", "remove"]);

/** The watchlist the leading arguments name and the symbols after it; fails naming the watchlists there are. */
function requireWatchlistArgs(
  config: AppConfig,
  args: readonly string[],
  file: string | undefined,
  verb: "add" | "remove",
  usage: string,
  ctx: CliCommandContext,
): { watchlist: Watchlist; rest: string[] } {
  if (args.length === 0) ctx.fail(usage);
  const match = takeCollectionName(args, config.watchlists);
  if (!match) {
    // A pasted list in the place of the name is a list, not a watchlist that is missing.
    const pasted = misplacedSymbolList(args, file, { noun: "watchlist", verb, collections: config.watchlists, usage });
    if (pasted) ctx.fail(pasted.message, pasted.details);
    ctx.fail(
      `Watchlist "${args[0]}" was not found.`,
      config.watchlists.length > 0 ? `Watchlists: ${config.watchlists.map((entry) => entry.name).join(", ")}` : undefined,
    );
  }
  return { watchlist: match.collection, rest: match.rest };
}

async function createWatchlist(name: string, ctx: CliCommandContext) {
  await withConfigData(ctx, async ({ config }) => {
    const trimmedName = name.trim();
    if (!trimmedName) ctx.fail("Usage: gloom watchlist create <name>");

    const id = slugifyName(trimmedName, "watchlist");
    const duplicate = config.watchlists.some((watchlist) =>
      watchlist.id === id || watchlist.name.toLowerCase() === trimmedName.toLowerCase()
    );
    if (duplicate) ctx.fail(`Watchlist "${trimmedName}" already exists.`);

    const nextConfig = {
      ...config,
      watchlists: [...config.watchlists, { id, name: trimmedName }],
    };
    await saveConfig(nextConfig);
    console.log(cliStyles.success(`Created watchlist "${trimmedName}".`));
    console.log(renderStats([["ID", id]]));
  });
}

async function deleteWatchlist(name: string, ctx: CliCommandContext) {
  await withCollectionConfigData(ctx, async ({ config, store }) => {
    const watchlist = findWatchlist(config, name);
    if (!watchlist) ctx.fail(`Watchlist "${name}" was not found.`);

    const result = deleteWatchlistConfig(config, await store.loadAllTickers(), watchlist.id);
    for (const ticker of result.tickers) {
      await store.saveTicker(ticker);
    }

    await saveConfig(result.config);
    console.log(cliStyles.success(`Deleted watchlist "${watchlist.name}".`));
    console.log(renderStats([["Cleaned Tickers", String(result.tickers.length)]]));
  });
}

async function addTickerToWatchlistCommand(
  watchlist: Watchlist, symbol: string, notes: readonly string[], exchange: string | undefined, ctx: CliCommandContext, market: MarketContext,
) {
  // A bare symbol is stored on the listing `quote` reads it as, and the notes say which; a match a list would leave for a choice fails.
  await addOneSymbol(ctx, market, {
    symbol,
    exchange,
    collection: { kind: "watchlist", name: watchlist.name },
    notes,
    retry: (key) => `gloom watchlist add ${shellWord(watchlist.name)} ${key}`,
    add: (ticker) => addTickerToWatchlist(ticker, watchlist.id),
  });
}

async function addToWatchlistCommand(args: string[], file: string | undefined, exchange: string | undefined, ctx: CliCommandContext) {
  await withCollectionMarketData(ctx, async (market) => {
    const { watchlist, rest } = requireWatchlistArgs(market.config, args, file, "add", ADD_USAGE, ctx);
    const list = await requireSymbolList(ctx, rest, file, ADD_USAGE, (entries) => readNameEntries(entries, market.dataProvider));
    if (list.single) {
      await addTickerToWatchlistCommand(watchlist, list.single, list.notes, exchange, ctx, market);
      return;
    }
    const retry = (key: string) => `gloom watchlist add ${shellWord(watchlist.name)} ${key}`;
    const dryRun = ctx.cliOptions.dryRun;
    const rows = await addSymbols({
      symbols: list.symbols,
      exchange,
      store: market.store,
      dataProvider: market.dataProvider,
      onRetry: retryNotice(ctx),
      retry,
      suggest: true,
      dryRun,
      add: (ticker) => addTickerToWatchlist(ticker, watchlist.id),
    });
    printSymbolRows(ctx, rows, { verb: "add", collection: { kind: "watchlist", name: watchlist.name }, repeated: list.repeated, notes: list.notes, retry, dryRun });
  });
}

async function removeTickerFromWatchlist(
  watchlist: Watchlist, symbol: string, notes: readonly string[], exchange: string | undefined, ctx: CliCommandContext, { store }: ConfigContext,
) {
  // SAN:EPA and SAN --exchange EPA name the stored listing, which a bare SAN may hold under another venue.
  // GARAN.IS is the row of GARAN:BIST, else a row still saved under that key (a broker's).
  const { listing, ticker } = await requireSavedListing(symbol, exchange, ctx, store, (row) => row.metadata.watchlists.includes(watchlist.id));
  if (!ticker) ctx.fail(`Ticker "${listing.key}" was not found in your local data.`);
  const saved = savedListingName(ticker);
  const result = removeWatchlistMembership(ticker, watchlist.id);
  if (!result.changed) ctx.fail(`${saved.key} is not in "${watchlist.name}".`);

  await store.saveTicker(result.ticker);
  ctx.printResult({ data: { changed: true, ...listingFields(saved), watchlist: watchlist.name }, ...notes.length > 0 ? { warnings: [...notes] } : {} }, {
    text: () => cliStyles.success(`Removed ${saved.label} from "${watchlist.name}".`),
  });
}

async function removeFromWatchlistCommand(args: string[], file: string | undefined, exchange: string | undefined, ctx: CliCommandContext) {
  await withCollectionConfigData(ctx, async (context) => {
    const { watchlist, rest } = requireWatchlistArgs(context.config, args, file, "remove", REMOVE_USAGE, ctx);
    const list = await requireSymbolList(ctx, rest, file, REMOVE_USAGE);
    if (list.single) {
      await removeTickerFromWatchlist(watchlist, list.single, list.notes, exchange, ctx, context);
      return;
    }
    const rows = await removeSymbols({
      symbols: list.symbols,
      exchange,
      store: context.store,
      holds: (ticker) => ticker.metadata.watchlists.includes(watchlist.id),
      remove: (ticker) => removeWatchlistMembership(ticker, watchlist.id),
    });
    printSymbolRows(ctx, rows, { verb: "remove", collection: { kind: "watchlist", name: watchlist.name }, repeated: list.repeated, notes: list.notes });
  });
}

async function listWatchlists(ctx: CliCommandContext) {
  await withConfigData(ctx, async ({ config, store }) => {
    const tickers = await store.loadAllTickers();
    const rows = config.watchlists.map((watchlist) => ({
      id: watchlist.id,
      name: watchlist.name,
      tickerCount: countCollectionTickers(tickers, "watchlists", watchlist.id),
    }));

    if (ctx.cliOptions.format !== "text") {
      ctx.printResult({ data: rows }, {
        columns: [
          { key: "name", header: "Watchlist" },
          { key: "id", header: "ID" },
          { key: "tickerCount", header: "Tickers", align: "right" },
        ],
      });
      return;
    }

    console.log(renderSection("Watchlists"));
    if (config.watchlists.length === 0) {
      console.log(cliStyles.muted("No watchlists configured."));
      return;
    }

    console.log(renderTable(
      [
        { header: "Watchlist" },
        { header: "ID", shrink: false },
        { header: "Tickers", align: "right" },
      ],
      rows.map((watchlist) => [
        watchlist.name,
        watchlist.id,
        String(watchlist.tickerCount),
      ]),
    ));
  });
}

export const watchlistCliCommand: CliCommandDef = {
  name: "watchlist",
  aliases: ["watchlists"],
  description: "Show watchlist quotes, and add or remove symbols",
  help: {
    group: CLI_COMMAND_GROUPS.portfolios,
    usage: [
      "watchlist [list]",
      "watchlist show <name>",
      "watchlist create <name>",
      "watchlist delete <name>",
      "watchlist add <watchlist> <symbols...> [--file <path>]",
      "watchlist remove <watchlist> <symbols...> [--file <path>]",
    ],
    options: [EXCHANGE_OPTION, FILE_OPTION],
    examples: [
      "watchlist show Growth",
      "watchlist create Growth",
      "watchlist add Growth NVDA",
      "watchlist add Growth SAN:EPA",
      "watchlist add Energy hyperliquid:xyz:BRENTOIL",
      "watchlist add Growth NVDA AMD,AVGO",
      "watchlist add Growth --file holdings.csv",
      "watchlist add Growth --file holdings.csv --dry-run",
      "watchlist show Growth --csv",
    ],
    sections: [SYMBOL_LIST_HELP],
  },
  execute: async (rawArgs, ctx) => {
    const args = [...rawArgs];
    const exchange = takeOption(args, "--exchange");
    const hasFile = args.some((arg) => arg === "--file" || arg.startsWith("--file="));
    const file = hasFile ? takeOption(args, "--file") ?? "" : undefined;
    const action = args[0];
    if (file != null && action !== "add" && action !== "remove") ctx.fail(`--file is an option of watchlist add and remove, not watchlist ${action ?? "list"}.`, ADD_USAGE);
    if (MUTATING_ACTIONS.has(action ?? "")) refuseDryRun(ctx, "watchlist", action!);

    if (!action || action === "list") {
      await listWatchlists(ctx);
      return;
    }

    if (action === "show") {
      const name = args.slice(1).join(" ");
      if (!name) ctx.fail("Usage: gloom watchlist show <name>");
      await showCollection(name, ctx);
      return;
    }

    if (action === "create") {
      const name = args.slice(1).join(" ");
      if (!name) ctx.fail("Usage: gloom watchlist create <name>");
      await createWatchlist(name, ctx);
      return;
    }

    if (action === "delete" || action === "rm") {
      const name = args.slice(1).join(" ");
      if (!name) ctx.fail("Usage: gloom watchlist delete <name>");
      await deleteWatchlist(name, ctx);
      return;
    }

    if (action === "add") {
      await addToWatchlistCommand(args.slice(1), file, exchange, ctx);
      return;
    }

    if (action === "remove") {
      await removeFromWatchlistCommand(args.slice(1), file, exchange, ctx);
      return;
    }

    if (action === "import") {
      // A list of symbols is what add reads; say how, with the user's own list and file.
      const rest = args.slice(1);
      const path = /\.\w+$/.test(rest.at(-1) ?? "") ? rest.at(-1)! : null;
      const name = (path ? rest.slice(0, -1) : rest).join(" ") || "<watchlist>";
      ctx.fail(
        `watchlist has no import. To add the symbols in ${path ?? "a file"}, run: gloom watchlist add ${/\s/.test(name) ? `"${name}"` : name} --file ${path ?? "<path>"}`,
        ADD_USAGE,
      );
    }

    await showCollection(args.join(" "), ctx);
  },
};

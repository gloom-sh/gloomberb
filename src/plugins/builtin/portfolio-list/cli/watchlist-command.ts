import { saveConfig } from "../../../../data/config/store";
import { withConfigData } from "../../../../cli/scoped-context";
import { withCollectionConfigData, withCollectionMarketData } from "../../../../cli/suffixed-listing-rows";
import { countCollectionTickers, findWatchlist } from "../../../../cli/helpers";
import { windowTextRows } from "../../../../cli/row-window";
import { slugifyName } from "../../../../utils/slugify";
import { takeOption } from "../../../../cli/commands/command-utils";
import { EXCHANGE_OPTION, loadSavedListingOf, requireSavedListing, savedListingCandidates, savedListingName } from "../../../../cli/listing-arg";
import {
  cliStyles,
  renderSection,
  renderStats,
  renderTable,
} from "../../../../utils/cli-output";
import type { AppConfig } from "../../../../types/config";
import type { CliCommandContext, CliCommandDef } from "../../../../types/plugin";
import type { TickerRecord, Watchlist } from "../../../../types/ticker";
import type { ConfigContext, MarketContext } from "../../../../cli/types";
import {
  addTickerToWatchlist,
  deleteWatchlist as deleteWatchlistConfig,
  removeTickerFromWatchlist as removeWatchlistMembership,
} from "../../../../portfolio/mutations";
import {
  parseWatchlistGroupName,
  setWatchlistGroup,
  watchlistGroups,
  watchlistTakesGroups,
  withoutWatchlistGroupSymbols,
} from "../../../../portfolio/watchlist-groups";
import { collectionAddCommand, showCollection } from "./render";
import { listingFields, misplacedSymbolList, refuseDryRun, takeCollectionName } from "./shared";
import { addOneSymbol, addSymbols, FILE_OPTION, listAddLookups, printSymbolRows, progressNotice, removeSymbols, requireSymbolList, retryNotice, shellWord, SYMBOL_LIST_HELP } from "./bulk-symbols";
import { readNameEntries } from "../../../../cli/name-entries";
import { CLI_COMMAND_GROUPS } from "../../../../cli/help";

const ADD_USAGE = "Usage: gloom watchlist add <watchlist> <symbols...> [--file <path>] [--group <name>]";
const REMOVE_USAGE = "Usage: gloom watchlist remove <watchlist> <symbols...> [--file <path>]";
const MOVE_USAGE = "Usage: gloom watchlist move <watchlist> <symbols...> --group <name>";
const UNGROUP_USAGE = "Usage: gloom watchlist ungroup <watchlist> <symbols...> | --group <name>";

const GROUPS_HELP = {
  title: "Groups",
  lines: [
    "A watchlist's tickers can sit in named groups (Energy, Tech, Index funds), which PF shows under headers that collapse, and watchlist show in a Group column; the rest show under Ungrouped. A ticker is in one group of a list at most, and a ticker on two lists can be in a different group on each.",
    "add --group puts the symbols added, and those already in the list, in the group, made when new. move --group puts symbols of the list in it. ungroup takes symbols out of their group, and ungroup --group takes every symbol out of that group. A group with no symbols left goes. Names are matched in any case.",
  ],
};

const GROUP_OPTION = {
  flags: "--group <name>",
  description: "add, move: put the symbols in this group of the watchlist, made when new; ungroup: take every symbol out of it",
};

/** Actions that change a watchlist without a preview, so --dry-run would change it anyway. add previews. */
const MUTATING_ACTIONS = new Set(["create", "delete", "rm", "remove", "move", "ungroup"]);

/** The watchlist the leading arguments name and the symbols after it; fails naming the watchlists there are. */
function requireWatchlistArgs(
  config: AppConfig,
  args: readonly string[],
  file: string | undefined,
  verb: "add" | "remove" | "move" | "ungroup",
  usage: string,
  ctx: CliCommandContext,
): { watchlist: Watchlist; rest: string[] } {
  if (args.length === 0) ctx.fail(usage);
  const match = takeCollectionName(args, config.watchlists);
  if (!match) {
    // A pasted list in the place of the name is a list, not a watchlist that is missing.
    const pasted = verb === "add" || verb === "remove"
      ? misplacedSymbolList(args, file, { noun: "watchlist", verb, collections: config.watchlists, usage })
      : null;
    if (pasted) ctx.fail(pasted.message, pasted.details);
    // The watchlist goes first: `watchlist add USDJPY=X USDCHF=X` read USDJPY=X as its name, so the form is said too.
    ctx.fail(
      `Watchlist "${args[0]}" was not found.`,
      [config.watchlists.length > 0 ? `Watchlists: ${config.watchlists.map((entry) => entry.name).join(", ")}` : "", usage].filter(Boolean).join("\n"),
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

/** The group `--group` names, checked before anything is looked up; a team list takes none. */
function requireGroupName(watchlist: Watchlist, group: string | undefined, usage: string, ctx: CliCommandContext): string | null {
  if (group == null) return null;
  if (!watchlistTakesGroups(watchlist)) ctx.fail(`"${watchlist.name}" is a team watchlist; only your own watchlists have groups.`);
  if (!group.trim()) ctx.fail("--group needs a group name.", usage);
  try {
    return parseWatchlistGroupName(group);
  } catch (error) {
    return ctx.fail(error instanceof Error ? error.message : String(error), usage);
  }
}

/** Puts the rows an add stored or found in the list into its group, and says so on standard error beside the add's own lines. */
async function groupAdded(ctx: CliCommandContext, config: AppConfig, watchlist: Watchlist, keys: readonly string[], group: string | null) {
  if (group == null || keys.length === 0 || ctx.cliOptions.dryRun) return;
  const result = setWatchlistGroup(config, watchlist.id, keys, group);
  if (result.moved.length === 0) return;
  await saveConfig(result.config);
  if (!ctx.cliOptions.quiet) {
    console.error(cliStyles.muted(`Put ${result.moved.length === 1 ? result.moved[0] : `${result.moved.length} tickers`} in group "${result.group}".`));
  }
}

async function addTickerToWatchlistCommand(
  watchlist: Watchlist, symbol: string, notes: readonly string[], exchange: string | undefined, ctx: CliCommandContext, market: MarketContext,
  group: string | null,
) {
  const added: string[] = [];
  // A bare symbol is stored on the listing `quote` reads it as, and the notes say which; a match a list would leave for a choice fails.
  await addOneSymbol(ctx, market, {
    symbol,
    exchange,
    collection: { kind: "watchlist", name: watchlist.name },
    notes,
    retry: (key) => `gloom watchlist add ${shellWord(watchlist.name)} ${key}`,
    add: (ticker) => {
      const result = addTickerToWatchlist(ticker, watchlist.id);
      added.push(result.ticker.metadata.ticker);
      return result;
    },
    member: (ticker) => ticker.metadata.watchlists.includes(watchlist.id),
  });
  await groupAdded(ctx, market.config, watchlist, added, group);
}

async function addToWatchlistCommand(args: string[], file: string | undefined, exchange: string | undefined, rawGroup: string | undefined, ctx: CliCommandContext) {
  await withCollectionMarketData(ctx, async (market) => {
    const { watchlist, rest } = requireWatchlistArgs(market.config, args, file, "add", ADD_USAGE, ctx);
    const group = requireGroupName(watchlist, rawGroup, ADD_USAGE, ctx);
    // Reading the names and looking the symbols up share their answers, so nothing is asked twice.
    const lookups = await listAddLookups(market.dataProvider);
    const list = await requireSymbolList(ctx, rest, file, ADD_USAGE, (entries) => readNameEntries(entries, lookups));
    if (list.single) {
      await addTickerToWatchlistCommand(watchlist, list.single, list.notes, exchange, ctx, market, group);
      return;
    }
    const retry = (key: string) => `gloom watchlist add ${shellWord(watchlist.name)} ${key}`;
    const dryRun = ctx.cliOptions.dryRun;
    // The rows added, or found already in the list, which `--group` puts in its group.
    const added: string[] = [];
    const rows = await addSymbols({
      symbols: list.symbols,
      exchange,
      store: market.store,
      dataProvider: lookups,
      onRetry: retryNotice(ctx),
      onProgress: progressNotice(ctx),
      retry,
      suggest: true,
      dryRun,
      add: (ticker) => {
        const result = addTickerToWatchlist(ticker, watchlist.id);
        added.push(result.ticker.metadata.ticker);
        return result;
      },
      member: (ticker) => ticker.metadata.watchlists.includes(watchlist.id),
    });
    printSymbolRows(ctx, rows, { verb: "add", collection: { kind: "watchlist", name: watchlist.name }, repeated: list.repeated, notes: list.notes, retry, dryRun });
    await groupAdded(ctx, market.config, watchlist, added, group);
  });
}

/**
 * The saved rows of the list the symbols name, by key, as `remove` reads a
 * symbol (SAN:EPA, `--exchange`, GARAN.IS); fails naming every symbol that is
 * not in the list, before anything changes.
 */
async function requireListedKeys(
  symbols: readonly string[], exchange: string | undefined, store: ConfigContext["store"], watchlist: Watchlist, usage: string, ctx: CliCommandContext,
): Promise<string[]> {
  const held = (ticker: TickerRecord) => ticker.metadata.watchlists.includes(watchlist.id);
  const keys: string[] = [];
  const missing: string[] = [];
  for (const input of symbols) {
    let listings;
    try {
      listings = savedListingCandidates(input, exchange, { ownExchangeWins: true });
    } catch (error) {
      return ctx.fail(error instanceof Error ? error.message : String(error), usage);
    }
    const saved = listings[0]!.symbol ? await loadSavedListingOf(store, listings, held) : null;
    if (saved && held(saved.ticker)) keys.push(saved.ticker.metadata.ticker);
    else missing.push(listings[0]!.key || input.trim());
  }
  if (missing.length > 0) ctx.fail(`Not in "${watchlist.name}": ${missing.join(", ")}.`, usage);
  return keys;
}

/**
 * `watchlist move <list> <symbols...> --group <name>` puts the symbols in the
 * group; `watchlist ungroup <list> <symbols...>` takes them out of theirs, and
 * `watchlist ungroup <list> --group <name>` every symbol out of that group.
 */
async function groupWatchlistSymbols(
  action: "move" | "ungroup", args: string[], exchange: string | undefined, rawGroup: string | undefined, ctx: CliCommandContext,
) {
  const usage = action === "move" ? MOVE_USAGE : UNGROUP_USAGE;
  await withCollectionConfigData(ctx, async ({ config, store }) => {
    const { watchlist, rest } = requireWatchlistArgs(config, args, undefined, action, usage, ctx);
    if (action === "move" && rawGroup == null) ctx.fail("watchlist move needs --group <name>: the group to put the symbols in.", usage);
    const group = requireGroupName(watchlist, rawGroup, usage, ctx);
    let keys: string[];
    if (rest.length === 0) {
      // `ungroup --group Energy` empties the group, which then goes.
      const named = action === "ungroup" && group != null
        ? watchlistGroups(watchlist).find((entry) => entry.name.toLocaleLowerCase() === group.toLocaleLowerCase())
        : null;
      if (action === "ungroup" && group != null && !named) ctx.fail(`"${watchlist.name}" has no group "${group}".`, usage);
      if (!named) ctx.fail(usage);
      keys = [...named.symbols];
    } else {
      const list = await requireSymbolList(ctx, rest, undefined, usage);
      keys = await requireListedKeys(list.symbols, exchange, store, watchlist, usage, ctx);
    }
    const result = setWatchlistGroup(config, watchlist.id, keys, action === "move" ? group : null);
    if (result.moved.length > 0) await saveConfig(result.config);
    const data = { watchlist: watchlist.name, group: result.group, symbols: keys, moved: result.moved };
    const named = (symbols: readonly string[]) => symbols.join(", ");
    ctx.printResult({ data }, {
      text: () => result.moved.length === 0
        ? cliStyles.warning(result.group == null
          ? `${named(keys)} ${keys.length === 1 ? "is" : "are"} in no group of "${watchlist.name}".`
          : `${named(keys)} ${keys.length === 1 ? "is" : "are"} already in group "${result.group}" of "${watchlist.name}".`)
        : cliStyles.success(result.group == null
          ? `Took ${named(result.moved)} out of ${result.moved.length === 1 ? "its group" : "their groups"} in "${watchlist.name}".`
          : `Moved ${named(result.moved)} to group "${result.group}" of "${watchlist.name}".`),
    });
  });
}

/** Rows that left the list leave its groups too: added back later, they start in none. */
async function withoutGroups(config: AppConfig, watchlist: Watchlist, keys: readonly string[]) {
  const next = withoutWatchlistGroupSymbols(config, watchlist.id, keys);
  if (next !== config) await saveConfig(next);
}

async function removeTickerFromWatchlist(
  watchlist: Watchlist, symbol: string, notes: readonly string[], exchange: string | undefined, ctx: CliCommandContext, { store, config }: ConfigContext,
) {
  // SAN:EPA and SAN --exchange EPA name the stored listing, which a bare SAN may hold under another venue.
  // GARAN.IS is the row of GARAN:BIST, else a row still saved under that key (a broker's).
  const { listing, ticker } = await requireSavedListing(symbol, exchange, ctx, store, (row) => row.metadata.watchlists.includes(watchlist.id));
  if (!ticker) ctx.fail(`Ticker "${listing.key}" was not found in your local data.`);
  const saved = savedListingName(ticker);
  const result = removeWatchlistMembership(ticker, watchlist.id);
  if (!result.changed) ctx.fail(`${saved.key} is not in "${watchlist.name}".`);

  await store.saveTicker(result.ticker);
  await withoutGroups(config, watchlist, [ticker.metadata.ticker]);
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
    const removed: string[] = [];
    const rows = await removeSymbols({
      symbols: list.symbols,
      exchange,
      store: context.store,
      holds: (ticker) => ticker.metadata.watchlists.includes(watchlist.id),
      remove: (ticker) => {
        const result = removeWatchlistMembership(ticker, watchlist.id);
        if (result.changed) removed.push(ticker.metadata.ticker);
        return result;
      },
    });
    await withoutGroups(context.config, watchlist, removed);
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

    const window = windowTextRows(rows, ctx.cliOptions);
    console.log(renderTable(
      [
        { header: "Watchlist" },
        { header: "ID", shrink: false },
        { header: "Tickers", align: "right" },
      ],
      window.rows.map((watchlist) => [
        watchlist.name,
        watchlist.id,
        String(watchlist.tickerCount),
      ]),
    ));
    if (window.note) console.log(cliStyles.muted(window.note));
    // Nothing in any of them: the command that fills one, as `alerts` names the one that adds an alert.
    if (rows.every((watchlist) => watchlist.tickerCount === 0)) {
      console.log(cliStyles.muted(`\nNo tickers yet. Add some with ${collectionAddCommand("watchlist", rows[0]!.name)}.`));
    }
  });
}

export const watchlistCliCommand: CliCommandDef = {
  name: "watchlist",
  aliases: ["watchlists"],
  description: "Show watchlist quotes, add or remove symbols, and group them",
  help: {
    group: CLI_COMMAND_GROUPS.portfolios,
    usage: [
      "watchlist [list]",
      "watchlist show <name>",
      "watchlist create <name>",
      "watchlist delete <name>",
      "watchlist add <watchlist> <symbols...> [--file <path>] [--group <name>]",
      "watchlist remove <watchlist> <symbols...> [--file <path>]",
      "watchlist move <watchlist> <symbols...> --group <name>",
      "watchlist ungroup <watchlist> <symbols...>",
      "watchlist ungroup <watchlist> --group <name>",
    ],
    options: [EXCHANGE_OPTION, FILE_OPTION, GROUP_OPTION],
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
      "watchlist add Funds VTSAX FXAIX --group \"Index funds\"",
      "watchlist move Growth XOM CVX --group Energy",
      "watchlist ungroup Growth XOM",
    ],
    sections: [SYMBOL_LIST_HELP, GROUPS_HELP],
  },
  execute: async (rawArgs, ctx) => {
    const args = [...rawArgs];
    const exchange = takeOption(args, "--exchange");
    const hasFile = args.some((arg) => arg === "--file" || arg.startsWith("--file="));
    const file = hasFile ? takeOption(args, "--file") ?? "" : undefined;
    const hasGroup = args.some((arg) => arg === "--group" || arg.startsWith("--group="));
    const group = hasGroup ? takeOption(args, "--group") ?? "" : undefined;
    const action = args[0];
    if (group != null && action !== "add" && action !== "move" && action !== "ungroup") {
      ctx.fail(`--group is an option of watchlist add, move and ungroup, not watchlist ${action ?? "list"}.`, MOVE_USAGE);
    }
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
      await addToWatchlistCommand(args.slice(1), file, exchange, group, ctx);
      return;
    }

    if (action === "move" || action === "ungroup") {
      await groupWatchlistSymbols(action, args.slice(1), exchange, group, ctx);
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

import { saveConfig } from "../../../../data/config/store";
import { withConfigData, withMarketData } from "../../../../cli/scoped-context";
import { countCollectionTickers, findWatchlist } from "../../../../cli/helpers";
import { slugifyName } from "../../../../utils/slugify";
import { resolveTickerForCli } from "../../../../cli/ticker-resolution";
import { takeOption } from "../../../../cli/commands/command-utils";
import { EXCHANGE_OPTION, loadSavedListing, requireListingArg, savedListingName } from "../../../../cli/listing-arg";
import {
  cliStyles,
  renderSection,
  renderStats,
  renderTable,
} from "../../../../utils/cli-output";
import type { CliCommandContext, CliCommandDef } from "../../../../types/plugin";
import {
  addTickerToWatchlist,
  deleteWatchlist as deleteWatchlistConfig,
  removeTickerFromWatchlist as removeWatchlistMembership,
} from "../mutations";
import { showCollection } from "./render";
import { listingFields } from "./shared";
import { CLI_COMMAND_GROUPS } from "../../../../cli/help";

async function createWatchlist(name: string, ctx: CliCommandContext) {
  await withConfigData(ctx, async ({ config }) => {
    const trimmedName = name.trim();
    if (!trimmedName) ctx.fail("Usage: gloomberb watchlist create <name>");

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
  await withConfigData(ctx, async ({ config, store }) => {
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

async function addTickerToWatchlistCommand(watchlistName: string, symbol: string, exchange: string | undefined, ctx: CliCommandContext) {
  await withMarketData(ctx, async ({ config, store, dataProvider }) => {
    const watchlist = findWatchlist(config, watchlistName);
    if (!watchlist) ctx.fail(`Watchlist "${watchlistName}" was not found.`);

    try {
      const ticker = await resolveTickerForCli(symbol, store, dataProvider, exchange);
      const result = addTickerToWatchlist(ticker, watchlist.id);
      // Name the listing that was stored: SAN:EPA is not the SAN that a bare SAN means.
      const saved = savedListingName(ticker);
      const data = { changed: result.changed, ...listingFields(saved), watchlist: watchlist.name };
      if (!result.changed) {
        ctx.printResult({ data }, { text: () => cliStyles.warning(`${saved.label} is already in "${watchlist.name}".`) });
        return;
      }

      await store.saveTicker(result.ticker);
      ctx.printResult({ data }, { text: () => cliStyles.success(`Added ${saved.label} to "${watchlist.name}".`) });
    } catch (error) {
      ctx.fail(error instanceof Error ? error.message : `Failed to add ${symbol} to "${watchlist.name}".`);
    }
  });
}

async function removeTickerFromWatchlist(watchlistName: string, symbol: string, exchange: string | undefined, ctx: CliCommandContext) {
  // SAN:EPA and SAN --exchange EPA name the stored listing, which a bare SAN may hold under another venue.
  const listing = await requireListingArg(symbol, exchange, ctx);
  await withConfigData(ctx, async ({ config, store }) => {
    const watchlist = findWatchlist(config, watchlistName);
    if (!watchlist) ctx.fail(`Watchlist "${watchlistName}" was not found.`);

    const ticker = await loadSavedListing(store, listing);
    if (!ticker) ctx.fail(`Ticker "${listing.key}" was not found in your local data.`);
    const saved = savedListingName(ticker);
    const result = removeWatchlistMembership(ticker, watchlist.id);
    if (!result.changed) ctx.fail(`${saved.key} is not in "${watchlist.name}".`);

    await store.saveTicker(result.ticker);
    ctx.printResult({ data: { changed: true, ...listingFields(saved), watchlist: watchlist.name } }, {
      text: () => cliStyles.success(`Removed ${saved.label} from "${watchlist.name}".`),
    });
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
      "watchlist add <watchlist> <symbol>",
      "watchlist remove <watchlist> <symbol>",
    ],
    options: [EXCHANGE_OPTION],
    examples: ["watchlist show Growth", "watchlist create Growth", "watchlist add Growth NVDA", "watchlist add Growth SAN:EPA"],
  },
  execute: async (rawArgs, ctx) => {
    const args = [...rawArgs];
    const exchange = takeOption(args, "--exchange");
    const action = args[0];

    if (!action || action === "list") {
      await listWatchlists(ctx);
      return;
    }

    if (action === "show") {
      const name = args.slice(1).join(" ");
      if (!name) ctx.fail("Usage: gloomberb watchlist show <name>");
      await showCollection(name, ctx);
      return;
    }

    if (action === "create") {
      const name = args.slice(1).join(" ");
      if (!name) ctx.fail("Usage: gloomberb watchlist create <name>");
      await createWatchlist(name, ctx);
      return;
    }

    if (action === "delete" || action === "rm") {
      const name = args.slice(1).join(" ");
      if (!name) ctx.fail("Usage: gloomberb watchlist delete <name>");
      await deleteWatchlist(name, ctx);
      return;
    }

    if (action === "add") {
      const symbol = args.at(-1);
      const name = args.slice(1, -1).join(" ");
      if (!name || !symbol) ctx.fail("Usage: gloomberb watchlist add <watchlist> <ticker>");
      await addTickerToWatchlistCommand(name!, symbol!, exchange, ctx);
      return;
    }

    if (action === "remove") {
      const symbol = args.at(-1);
      const name = args.slice(1, -1).join(" ");
      if (!name || !symbol) ctx.fail("Usage: gloomberb watchlist remove <watchlist> <ticker>");
      await removeTickerFromWatchlist(name!, symbol!, exchange, ctx);
      return;
    }

    await showCollection(args.join(" "), ctx);
  },
};

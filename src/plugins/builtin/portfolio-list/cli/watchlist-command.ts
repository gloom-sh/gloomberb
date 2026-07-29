import { saveConfig } from "../../../../data/config/store";
import { withConfigData, withMarketData } from "../../../../cli/scoped-context";
import { countCollectionTickers, findWatchlist, slugifyName } from "../../../../cli/helpers";
import { resolveTickerForCli } from "../../../../cli/ticker-resolution";
import {
  cliStyles,
  renderSection,
  renderStat,
  renderTable,
} from "../../../../utils/cli-output";
import type { CliCommandContext, CliCommandDef } from "../../../../types/plugin";
import type { TickerRecord } from "../../../../types/ticker";
import { addTickerToWatchlist } from "../mutations";
import { showCollection } from "./render";

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
    console.log(renderStat("ID", id));
  });
}

async function deleteWatchlist(name: string, ctx: CliCommandContext) {
  await withConfigData(ctx, async ({ config, store }) => {
    const watchlist = findWatchlist(config, name);
    if (!watchlist) ctx.fail(`Watchlist "${name}" was not found.`);

    const nextConfig = {
      ...config,
      watchlists: config.watchlists.filter((entry) => entry.id !== watchlist.id),
    };

    let cleanedTickers = 0;
    for (const ticker of await store.loadAllTickers()) {
      if (!ticker.metadata.watchlists.includes(watchlist.id)) continue;
      const nextTicker: TickerRecord = {
        ...ticker,
        metadata: {
          ...ticker.metadata,
          watchlists: ticker.metadata.watchlists.filter((entry) => entry !== watchlist.id),
        },
      };
      await store.saveTicker(nextTicker);
      cleanedTickers += 1;
    }

    await saveConfig(nextConfig);
    console.log(cliStyles.success(`Deleted watchlist "${watchlist.name}".`));
    console.log(renderStat("Cleaned Tickers", String(cleanedTickers)));
  });
}

async function addTickerToWatchlistCommand(watchlistName: string, symbol: string, ctx: CliCommandContext) {
  await withMarketData(ctx, async ({ config, store, dataProvider }) => {
    const watchlist = findWatchlist(config, watchlistName);
    if (!watchlist) ctx.fail(`Watchlist "${watchlistName}" was not found.`);

    try {
      const ticker = await resolveTickerForCli(symbol, store, dataProvider);
      const result = addTickerToWatchlist(ticker, watchlist.id);
      if (!result.changed) {
        console.log(cliStyles.warning(`${ticker.metadata.ticker} is already in "${watchlist.name}".`));
        return;
      }

      const nextTicker = result.ticker;
      await store.saveTicker(nextTicker);
      console.log(cliStyles.success(`Added ${nextTicker.metadata.ticker} to "${watchlist.name}".`));
      if (nextTicker.metadata.name) {
        console.log(renderStat("Name", nextTicker.metadata.name));
      }
    } catch (error) {
      ctx.fail(error instanceof Error ? error.message : `Failed to add ${symbol} to "${watchlist.name}".`);
    }
  });
}

async function removeTickerFromWatchlist(watchlistName: string, symbol: string, ctx: CliCommandContext) {
  await withConfigData(ctx, async ({ config, store }) => {
    const watchlist = findWatchlist(config, watchlistName);
    if (!watchlist) ctx.fail(`Watchlist "${watchlistName}" was not found.`);

    const normalized = symbol.trim().toUpperCase();
    const ticker = await store.loadTicker(normalized);
    if (!ticker) ctx.fail(`Ticker "${normalized}" was not found in your local data.`);
    if (!ticker.metadata.watchlists.includes(watchlist.id)) {
      ctx.fail(`${normalized} is not in "${watchlist.name}".`);
    }

    const nextTicker: TickerRecord = {
      ...ticker,
      metadata: {
        ...ticker.metadata,
        watchlists: ticker.metadata.watchlists.filter((entry) => entry !== watchlist.id),
      },
    };
    await store.saveTicker(nextTicker);
    console.log(cliStyles.success(`Removed ${normalized} from "${watchlist.name}".`));
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
        { header: "ID" },
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
  description: "List, create, delete, add, or remove watchlists",
  help: {
    usage: ["watchlist [action]"],
    sections: [{
      title: "Watchlist Actions",
      columns: [
        { header: "Action" },
        { header: "Example" },
      ],
      rows: [
        ["list", "gloomberb watchlist list"],
        ["show", "gloomberb watchlist show Growth"],
        ["create", "gloomberb watchlist create Growth"],
        ["delete", "gloomberb watchlist delete Growth"],
        ["add", "gloomberb watchlist add Growth NVDA"],
        ["remove", "gloomberb watchlist remove Growth NVDA"],
      ],
    }],
  },
  execute: async (args, ctx) => {
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
      await addTickerToWatchlistCommand(name!, symbol!, ctx);
      return;
    }

    if (action === "remove") {
      const symbol = args.at(-1);
      const name = args.slice(1, -1).join(" ");
      if (!name || !symbol) ctx.fail("Usage: gloomberb watchlist remove <watchlist> <ticker>");
      await removeTickerFromWatchlist(name!, symbol!, ctx);
      return;
    }

    await showCollection(args.join(" "), ctx);
  },
};

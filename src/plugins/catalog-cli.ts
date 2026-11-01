import type { CliCommandDef } from "../types/plugin";
import { fearGreedPluginMeta, newsPluginMeta, notesPluginMeta, portfolioPluginMeta } from "./builtin/builtin-plugin-meta";
import { ALERTS_PLUGIN_ID } from "./builtin/alerts/constants";
import { alertsCliCommand } from "./builtin/alerts/cli";
import { fearGreedCliCommand } from "./builtin/fear-greed/cli";
import { rssCliCommand } from "./builtin/news/wire/rss/cli";
import { notesCliCommand } from "./builtin/notes/cli";
import { portfolioCliCommand } from "./builtin/portfolio-list/cli/portfolio-command";
import { watchlistCliCommand } from "./builtin/portfolio-list/cli/watchlist-command";

/** Command definitions shared with the plugins, without loading their pane components. */
export function getBuiltinCliCommands(): { pluginId: string; commands: CliCommandDef[] }[] {
  return [
    { pluginId: portfolioPluginMeta.id, commands: [portfolioCliCommand, watchlistCliCommand] },
    { pluginId: newsPluginMeta.id, commands: [rssCliCommand] },
    { pluginId: notesPluginMeta.id, commands: [notesCliCommand] },
    { pluginId: fearGreedPluginMeta.id, commands: [fearGreedCliCommand] },
    { pluginId: ALERTS_PLUGIN_ID, commands: [alertsCliCommand] },
  ];
}

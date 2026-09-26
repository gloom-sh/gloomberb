import { CLI_COMMAND_GROUPS } from "../../../../../cli/help";
import { requireArg, takeOption } from "../../../../../cli/commands/command-utils";
import type { CliCommandDef } from "../../../../../types/plugin";
import { createRssNewsCapability } from "./source";

export const rssCliCommand: CliCommandDef = {
  name: "rss",
  description: "Read any RSS or Atom feed as headlines",
  help: {
    group: CLI_COMMAND_GROUPS.markets,
    usage: ["rss fetch <url> [--name <label>]"],
    options: [{ flags: "--name <label>", description: "Source name shown on each row (default RSS)" }],
    examples: ["rss fetch https://feeds.a.dj.com/rss/RSSMarketsMain.xml --limit 10"],
  },
  execute: async (args, ctx) => {
    const action = args[0] ?? "fetch";
    if (action !== "fetch") ctx.fail("Usage: gloomberb rss fetch <url> [--name <label>]");
    const rawArgs = args.slice(1);
    const name = takeOption(rawArgs, "--name") ?? "RSS";
    const url = requireArg(rawArgs[0], "Usage: gloomberb rss fetch <url> [--name <label>]", ctx);
    const capability = createRssNewsCapability([{
      id: "cli-feed",
      url,
      name,
      category: "cli",
      authority: 50,
      enabled: true,
    }]);
    const articles = await capability.provider.fetchNews({ feed: "latest", limit: ctx.cliOptions.limit ?? 20 });
    ctx.printResult({ data: articles.map((article) => ({
      title: article.title,
      source: article.source,
      publishedAt: article.publishedAt.toISOString(),
      url: article.url,
      summary: article.summary ?? "",
    })) }, {
      textColumns: [
        { key: "publishedAt", header: "Published" },
        { key: "source", header: "Source", maxWidth: 20 },
        { key: "title", header: "Title" },
        { key: "url", header: "URL", optional: true },
        { key: "summary", header: "Summary", optional: true },
      ],
      empty: "The feed has no items.",
    });
  },
};

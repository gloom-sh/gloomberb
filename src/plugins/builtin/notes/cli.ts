import { apiClient } from "../../../api-client";
import { withCliServices, withConfigData } from "../../../cli/scoped-context";
import { CLI_COMMAND_GROUPS } from "../../../cli/help";
import { dryRunNote } from "../../../cli/helpers";
import { requireArg, takeOption } from "../../../cli/commands/command-utils";
import { EXCHANGE_OPTION, requireListingArg } from "../../../cli/listing-arg";
import { createPluginPersistence } from "../../plugin-persistence";
import type { CliCommandDef } from "../../../types/plugin";
import { cliStyles } from "../../../utils/cli-output";
import { readChatSessionState } from "../chat/controller/persistence";
import { exportNotesToDirectory, type NotesExportSource } from "./export";
import { NotesFiles } from "./files";
import { CloudNotesStore } from "./store";

export const notesCliCommand: CliCommandDef = {
  name: "notes",
  description: "Read, write, or export ticker notes",
  help: {
    group: CLI_COMMAND_GROUPS.portfolios,
    usage: ["notes show <symbol>", "notes set <symbol> <text...>", "notes delete <symbol>", "notes quick list", "notes export [dir]"],
    options: [EXCHANGE_OPTION],
    examples: ["notes show AAPL", "notes set AAPL \"Services margin above 70%\"", "notes show SAN:EPA", "notes export ~/notes"],
  },
  execute: async (rawArgs, ctx) => {
    const args = [...rawArgs];
    const exchange = takeOption(args, "--exchange");
    // A note belongs to one listing: SAN:EPA, or SAN with --exchange EPA.
    const noteSymbol = async (usage: string) => (
      await requireListingArg(requireArg(args[1], usage, ctx), exchange, ctx)
    ).key;
    await withConfigData(ctx, async (config) => {
      const notes = new NotesFiles(config.dataDir);
      const action = args[0] ?? "list";
      if (action === "export") {
        // Local files plus, when a saved session exists, the cloud copies
        // (personal and every team), one folder each.
        const dir = args[1] ?? `${config.dataDir}/notes-export-${new Date().toISOString().slice(0, 10)}`;
        const sources: NotesExportSource[] = [{ label: "local", store: notes }];
        await withCliServices(ctx, async (services) => {
          const cloudPersistence = createPluginPersistence(services.persistence.pluginState, services.persistence.resources, "plugin:gloomberb-cloud", "gloomberb-cloud");
          const session = readChatSessionState(cloudPersistence, null);
          if (!session?.sessionToken) return;
          apiClient.setSessionToken(session.sessionToken);
          const user = await apiClient.ensureVerifiedSession().catch(() => null);
          if (!user) return;
          const notesPersistence = createPluginPersistence(services.persistence.pluginState, services.persistence.resources, "plugin:notes", "notes");
          sources.push({ label: "mine", store: new CloudNotesStore({ kind: "user" }, notesPersistence) });
          const teams = await apiClient.listTeams().catch(() => []);
          for (const team of teams) {
            sources.push({ label: team.name, store: new CloudNotesStore({ kind: "team", teamId: team.id }, notesPersistence) });
          }
        });
        if (ctx.cliOptions.dryRun) {
          ctx.printResult({ data: { dryRun: true, dir, sources: sources.map((source) => source.label) } }, {
            text: (data) => `Would export ${data.sources.join(", ")} notes to ${data.dir}.${dryRunNote(true)}`,
          });
          return;
        }
        const result = await exportNotesToDirectory(dir, sources);
        ctx.printResult({ data: { dir: result.dir, files: result.files, sources: sources.map((source) => source.label) } }, {
          text: (data) => `Exported ${data.files} notes from ${data.sources.join(", ")} to ${data.dir}.`,
        });
        return;
      }
      if (action === "quick") {
        const subaction = args[1] ?? "list";
        if (subaction !== "list") ctx.fail("Usage: gloomberb notes quick list");
        const entries = await notes.loadQuickNotesIndex();
        ctx.printResult({ data: entries }, { empty: "No quick notes." });
        return;
      }
      if (action === "show") {
        const symbol = await noteSymbol("Usage: gloomberb notes show <symbol>");
        ctx.printResult({ data: { symbol, text: await notes.load(symbol) } }, {
          text: (data) => data.text?.trim() ? data.text.trimEnd() : cliStyles.muted(`No note for ${symbol}.`),
        });
        return;
      }
      if (action === "set") {
        const symbol = await noteSymbol("Usage: gloomberb notes set <symbol> <text...>");
        const text = args.slice(2).join(" ");
        if (!ctx.cliOptions.dryRun) await notes.save(symbol, text);
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, symbol, bytes: text.length } }, {
          text: (data) => `Saved the note for ${symbol}.${dryRunNote(data.dryRun)}`,
        });
        return;
      }
      if (action === "delete" || action === "rm") {
        const symbol = await noteSymbol("Usage: gloomberb notes delete <symbol>");
        // Only picks the message; an unreadable note is still deleted.
        const existed = await notes.load(symbol).then((text) => !!text?.trim(), () => true);
        if (!ctx.cliOptions.dryRun) await notes.delete(symbol);
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, symbol } }, {
          text: (data) => existed
            ? `Deleted the note for ${symbol}.${dryRunNote(data.dryRun)}`
            : cliStyles.muted(`No note for ${symbol}.`),
        });
        return;
      }
      ctx.fail("Usage: gloomberb notes show|set|delete|quick|export");
    });
  },
};

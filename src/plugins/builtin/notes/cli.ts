import { apiClient } from "../../../api-client";
import { withCliServices, withConfigData } from "../../../cli/scoped-context";
import type { CliServicesContext } from "../../../cli/types";
import { CLI_COMMAND_GROUPS } from "../../../cli/help";
import { dryRunNote } from "../../../cli/helpers";
import { requireArg, takeOption } from "../../../cli/commands/command-utils";
import { EXCHANGE_OPTION, listingReadNotes, requireListingArg } from "../../../cli/listing-arg";
import { createPluginPersistence } from "../../plugin-persistence";
import type { CliCommandDef } from "../../../types/plugin";
import { cliStyles } from "../../../utils/cli-output";
import { errorMessage } from "../../../utils/errors";
import { logFailure } from "../../../utils/log-failure";
import { readChatSessionState } from "../chat/controller/persistence";
import { describeExportSkip, exportNotesToDirectory, type NotesExportSource } from "./export";
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
    // What a typed listing was read as (7203:TSE as 7203:JPX) is said beside the note.
    let read: { warnings?: string[] } = {};
    const noteSymbol = async (usage: string) => {
      const listing = await requireListingArg(requireArg(args[1], usage, ctx), exchange, ctx);
      const notes = listingReadNotes(listing);
      if (notes.length > 0) read = { warnings: notes };
      return listing.key;
    };
    await withConfigData(ctx, async (config) => {
      const notes = new NotesFiles(config.dataDir);
      const action = args[0] ?? "list";
      if (action === "export") {
        // Local files plus, when a saved session exists, the cloud copies
        // (personal and every team), one folder each.
        const dir = args[1] ?? `${config.dataDir}/notes-export-${new Date().toISOString().slice(0, 10)}`;
        const sources: NotesExportSource[] = [{ label: "local", store: notes }];
        // A Cloud source left out or unreadable is a warning, as `quote` reports
        // a symbol it found nothing for: the local files are always written.
        const warnings: string[] = [];
        const leftOut = (what: string, failure: string) => (error: unknown) => {
          logFailure("notes.cli", failure)(error);
          warnings.push(`${what} (${errorMessage(error)}).`);
          return null;
        };
        const addCloudSources = async (services: CliServicesContext) => {
          const cloudPersistence = createPluginPersistence(services.persistence.pluginState, services.persistence.resources, "plugin:gloomberb-cloud", "gloomberb-cloud");
          const session = readChatSessionState(cloudPersistence, null);
          if (!session?.sessionToken) return;
          apiClient.setSessionToken(session.sessionToken);
          const user = await apiClient.ensureVerifiedSession()
            .catch(leftOut("Skipped Gloom Cloud notes: the saved session could not be checked", "Verify the saved session for the notes export failed"));
          if (!user) return;
          const notesPersistence = createPluginPersistence(services.persistence.pluginState, services.persistence.resources, "plugin:notes", "notes");
          sources.push({ label: "mine", store: new CloudNotesStore({ kind: "user" }, notesPersistence) });
          const teams = await apiClient.listTeams()
            .catch(leftOut("Skipped team notes: the team list could not be read", "List teams for the notes export failed")) ?? [];
          for (const team of teams) {
            sources.push({ label: team.name, store: new CloudNotesStore({ kind: "team", teamId: team.id }, notesPersistence) });
          }
        };
        // The Cloud stores read and cache through these services, so the
        // export runs before they close.
        const result = await withCliServices(ctx, async (services) => {
          await addCloudSources(services);
          return ctx.cliOptions.dryRun ? null : await exportNotesToDirectory(dir, sources);
        });
        if (!result) {
          ctx.printResult({ data: { dryRun: true, dir, sources: sources.map((source) => source.label) }, ...(warnings.length > 0 ? { warnings } : {}) }, {
            text: (data) => `Would export ${data.sources.join(", ")} notes to ${data.dir}.${dryRunNote(true)}`,
          });
          return;
        }
        warnings.push(...result.skipped.map(describeExportSkip));
        ctx.printResult({
          data: {
            dir: result.dir,
            files: result.files,
            sources: result.exported,
            ...(result.skipped.length > 0 ? { skipped: result.skipped } : {}),
          },
          ...(warnings.length > 0 ? { warnings } : {}),
        }, {
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
        ctx.printResult({ data: { symbol, text: await notes.load(symbol) }, ...read }, {
          text: (data) => data.text?.trim() ? data.text.trimEnd() : cliStyles.muted(`No note for ${symbol}.`),
        });
        return;
      }
      if (action === "set") {
        const symbol = await noteSymbol("Usage: gloomberb notes set <symbol> <text...>");
        const text = args.slice(2).join(" ");
        if (!ctx.cliOptions.dryRun) await notes.save(symbol, text);
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, symbol, bytes: text.length }, ...read }, {
          text: (data) => `Saved the note for ${symbol}.${dryRunNote(data.dryRun)}`,
        });
        return;
      }
      if (action === "delete" || action === "rm") {
        const symbol = await noteSymbol("Usage: gloomberb notes delete <symbol>");
        const existed = await notes.load(symbol).then((text) => !!text?.trim(), () => {
          // Intentional ignore: an unreadable note is still deleted, so the message says it existed.
          return true;
        });
        if (!ctx.cliOptions.dryRun) await notes.delete(symbol);
        ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, symbol }, ...read }, {
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

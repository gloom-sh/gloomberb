import { EXTRACTED_PLUGINS } from "../../plugins/extracted-plugins";
import { logFailure } from "../../utils/log-failure";
import { findOfferedShortcut, isRegistryPluginInstalled } from "../../plugins/marketplace/install-offer";
import type { RegistryPlugin } from "../../plugins/marketplace/model";
import { pluginDirectoryNames } from "../../plugins/plugin-names";
import type { PluginTarget } from "../../types/plugin";
import { plainUntrustedLine } from "../../utils/untrusted-text";
import type { IdleCliPlugin } from "../registry";

/**
 * Why a code the command line does not know is a plugin's: one that is
 * installed but does not run here, or one Gloom publishes that this profile
 * does not have. `gloom catalog` lists only what runs, so `fn` and `shot`
 * answer for the rest in a sentence and the command that fixes it.
 */
export interface PluginCodeStop {
  message: string;
  details: string;
}

/** What the answer reads: the installed plugins that do not run, and the registry, read only when no installed one owns the code. */
export interface PluginCodeSources {
  idle: readonly IdleCliPlugin[];
  /** Every plugin that is loaded and runs here, by id. */
  running: readonly string[];
  loadRegistry: () => Promise<readonly RegistryPlugin[]>;
}

/** The commands an answer names: the one typed, to run again once fixed, and `shot` of it. */
export interface PluginCodeCommands {
  rerun: string;
  /** `gloom shot` of the code and argument, which draws a pane of a plugin only the desktop app runs. */
  capture: string;
}

/**
 * A name a plugin or the registry feed gave, as one line that prints as it
 * reads: no escape sequence, control character or line break of its own.
 */
const printable = (value: string | undefined, fallback: string): string => plainUntrustedLine(value ?? "") || fallback;

/** "the desktop app", "the terminal app": where a plugin that does not run on the command line does. */
function whereItRuns(targets: readonly PluginTarget[] | undefined): string {
  const places = [
    targets?.includes("desktop") ? "the desktop app" : null,
    targets?.includes("tui") ? "the terminal app" : null,
    targets?.includes("web") ? "the web app" : null,
  ].filter((place): place is string => !!place);
  if (places.length === 0) return "the app";
  return places.length === 1 ? places[0]! : `${places.slice(0, -1).join(", ")} and ${places.at(-1)}`;
}

/** `HN opens the Hacker News plugin`, `AI opens AI Screener, from the BYOK AI plugin`. */
function opensText(code: string, label: string, pluginName: string): string {
  return label === pluginName ? `${code} opens the ${pluginName} plugin` : `${code} opens ${label}, from the ${pluginName} plugin`;
}

/**
 * Where to see a plugin that does not run on the command line: `shot` draws a
 * pane as the desktop app does, so one the desktop app runs is captured;
 * otherwise in the app's command bar.
 */
function elsewhereLines(code: string, targets: readonly PluginTarget[] | undefined, commands: PluginCodeCommands): string[] {
  const where = whereItRuns(targets);
  const desktop = !targets || targets.length === 0 || targets.includes("desktop");
  return desktop
    ? [`See it as the desktop app draws it: ${commands.capture}`, `Or type ${code} in ${where}'s command bar.`]
    : [`Type ${code} in ${where}'s command bar.`];
}

function idleStop(code: string, idle: readonly IdleCliPlugin[], commands: PluginCodeCommands): PluginCodeStop | null {
  for (const { plugin, reason } of idle) {
    if (reason === "failed") continue;
    const template = (plugin.paneTemplates ?? []).find((candidate) => (
      [candidate.shortcut?.prefix, ...candidate.shortcut?.aliases ?? []].some((prefix) => prefix?.trim().toUpperCase() === code)
    ));
    if (!template) continue;
    const name = printable(plugin.name, printable(plugin.id, code));
    const opens = opensText(code, printable(template.label, name), name);
    if (reason === "off") {
      return { message: `${opens}, which is switched off.`, details: `Turn it on: gloom plugin enable ${printable(plugin.id, name)}` };
    }
    // `shot` opens an installed plugin the desktop app runs, so only `fn` gets here for one.
    return {
      message: `${opens}, which runs in ${whereItRuns(plugin.targets)} only, not on the command line.`,
      details: elsewhereLines(code, plugin.targets, commands).join("\n"),
    };
  }
  return null;
}

/** A plugin that owns the code, from the registry or, for a code the feed does not list, the plugins that left the app. */
interface CodeOwner {
  id: string;
  name: string;
  label: string;
  repo: string;
  targets?: readonly PluginTarget[];
  installed: (entry: { id: string; directory?: string }) => boolean;
}

function registryOwner(registry: readonly RegistryPlugin[], code: string): CodeOwner | null {
  const found = findOfferedShortcut(registry, code);
  if (!found?.plugin.repo) return null;
  const { plugin, shortcut } = found;
  const name = printable(plugin.name, plugin.id);
  return {
    id: plugin.id,
    name,
    label: printable(shortcut.name, name),
    // `gloom-sh/<name>` and nothing else (install-offer.ts), so it prints as one word.
    repo: plugin.repo!,
    ...Array.isArray(plugin.targets) ? { targets: plugin.targets } : {},
    installed: (entry) => isRegistryPluginInstalled(plugin, [entry]),
  };
}

function extractedOwner(code: string): CodeOwner | null {
  const plugin = EXTRACTED_PLUGINS.find((entry) => (entry.codes as readonly string[]).includes(code));
  if (!plugin) return null;
  const folders = new Set(pluginDirectoryNames(plugin.directory).map((name) => name.toLowerCase()));
  return {
    id: plugin.id,
    name: plugin.name,
    label: plugin.name,
    repo: plugin.repo,
    installed: (entry) => entry.id === plugin.id || (!!entry.directory && folders.has(entry.directory.toLowerCase())),
  };
}

async function missingStop(
  code: string,
  sources: PluginCodeSources,
  commands: PluginCodeCommands,
): Promise<PluginCodeStop | null> {
  // Offline, the codes Gloom moved out of the app still answer from the list it ships.
  const registry = await sources.loadRegistry().catch(logFailure("cli.plugin-code", "Read the plugin registry for a plugin code failed", []));
  const owner = registryOwner(registry, code) ?? extractedOwner(code);
  if (!owner) return null;
  const opens = opensText(code, owner.label, owner.name);
  // Loaded and running, it would have opened: the code is no longer its.
  if (sources.running.includes(owner.id)) return null;
  const failed = sources.idle.find((entry) => entry.reason === "failed" && owner.installed({ id: entry.plugin.id, directory: entry.directory }));
  if (failed) {
    return {
      message: `${opens}, which is installed but did not load.`,
      details: `Check it: gloom plugin doctor ${printable(failed.directory, owner.id)}`,
    };
  }
  const install = `Install it: gloom install ${owner.repo}`;
  if (owner.targets && !owner.targets.includes("cli")) {
    const [first, ...rest] = elsewhereLines(code, owner.targets, commands);
    return {
      message: `${opens}, which is not installed, and runs in ${whereItRuns(owner.targets)} only, not on the command line.`,
      details: [install, `Then ${first!.charAt(0).toLowerCase()}${first!.slice(1)}`, ...rest].join("\n"),
    };
  }
  return {
    message: `${opens}, which is not installed.`,
    details: [install, `Then run: ${commands.rerun}`].join("\n"),
  };
}

/** The answer for a code that opens nothing because a plugin owns it, or null when no plugin does. */
export async function pluginCodeStop(name: string, sources: PluginCodeSources, commands: PluginCodeCommands): Promise<PluginCodeStop | null> {
  const code = name.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(code)) return null;
  return idleStop(code, sources.idle, commands) ?? await missingStop(code, sources, commands);
}

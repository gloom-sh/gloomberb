import { useEffect, useMemo, useState } from "react";
import type { PluginRegistry } from "../../../../plugins/registry";
import { findAbsorbedPlugin } from "../../../../plugins/absorbed";
import { isOfficialPluginRepo } from "../../../../plugins/auto-update";
import { getCurrentPluginTarget, runsExternalPlugins } from "../../../../plugins/current-target";
import { activateInstalledPlugin } from "../../../../plugins/builtin/plugin-marketplace/activation";
import { loadRegistry, registryPluginUrl } from "../../../../plugins/builtin/plugin-marketplace/feed";
import {
  installConsent,
  registryPin,
  type RegistryPlugin,
  type RegistryPluginShortcut,
} from "../../../../plugins/builtin/plugin-marketplace/model";
import {
  getMarketplaceHost,
  getPluginManager,
  type MarketplaceHost,
  type PluginManager,
} from "../../../../plugins/builtin/plugin-marketplace/store";
import type { PluginTarget } from "../../../../types/plugin";
import { requiredGloomberb } from "../../../../utils/semver";
import { getCommandPrefixes, type Command } from "../../commands/registry";
import { paneTemplateShortcutPrefixes } from "../../pane-templates/items";
import type { ResultItem } from "../../list/model";
import type { OpenInlineConfirm } from "../../routing/confirm";
import { PLUGIN_INSTALL_CATEGORY } from "../../view-model";
import { openUrl } from "../../../ui/external-link";

/** A typed code that belongs to an official plugin this app does not have. */
export interface PluginInstallOffer {
  plugin: RegistryPlugin;
  shortcut: RegistryPluginShortcut;
  /** What followed the code, handed to the function once it opens. */
  argText: string;
}

/**
 * Only plugins Gloom publishes. A typed word must never lead to installing
 * someone else's code, so the repository owner decides, not the feed's tier.
 * A plugin that is built in now (absorbed.ts) is never offered, whatever the
 * feed says: its code opens the built-in, and the installer refuses it.
 */
function isOfferable(plugin: RegistryPlugin): boolean {
  return plugin.tier === "official"
    && plugin.bundled !== true
    && isOfficialPluginRepo(plugin.repo)
    && !findAbsorbedPlugin({ id: plugin.id });
}

/** The feed is read defensively: an entry can come from any registry version. */
function declaredShortcuts(plugin: RegistryPlugin): RegistryPluginShortcut[] {
  const shortcuts = plugin.contributes?.shortcuts;
  if (!Array.isArray(shortcuts)) return [];
  return shortcuts.filter((shortcut): shortcut is RegistryPluginShortcut => (
    !!shortcut && typeof shortcut.code === "string" && typeof shortcut.name === "string"
  ));
}

/**
 * Matches the code alone or as the first word, with a ticker or query after
 * it, case-insensitively. A code the app already answers to (a built-in, or a
 * plugin that is installed) always wins, and an installed plugin is never
 * offered again, even when it is switched off or failed to load.
 */
export function matchPluginInstallOffer({
  query,
  registry,
  isClaimed,
  isInstalled,
}: {
  query: string;
  registry: readonly RegistryPlugin[];
  isClaimed: (code: string) => boolean;
  isInstalled: (plugin: RegistryPlugin) => boolean;
}): PluginInstallOffer | null {
  const trimmed = query.trim();
  const firstWord = trimmed.split(/\s+/, 1)[0] ?? "";
  const code = firstWord.toUpperCase();
  if (!code) return null;

  for (const plugin of registry) {
    if (!isOfferable(plugin)) continue;
    const shortcut = declaredShortcuts(plugin).find((entry) => entry.code.trim().toUpperCase() === code);
    if (!shortcut) continue;
    // Asked only once a code matched: both walk everything the app has loaded.
    if (isClaimed(code) || isInstalled(plugin)) return null;
    return { plugin, shortcut, argText: trimmed.slice(firstWord.length).trim() };
  }
  return null;
}

/**
 * Every code the app answers to right now: built-in commands, and the pane
 * templates and commands of every registered plugin, switched off or not.
 */
export function collectClaimedShortcutCodes(
  commands: readonly Command[],
  pluginRegistry: Pick<PluginRegistry, "paneTemplates" | "commands">,
): Set<string> {
  const codes = new Set<string>();
  for (const command of commands) {
    for (const prefix of getCommandPrefixes(command)) codes.add(prefix);
  }
  for (const template of pluginRegistry.paneTemplates.values()) {
    for (const prefix of paneTemplateShortcutPrefixes(template)) codes.add(prefix.trim().toUpperCase());
  }
  for (const command of pluginRegistry.commands.values()) {
    const shortcut = command.shortcut?.trim().toUpperCase();
    if (shortcut) codes.add(shortcut);
  }
  return codes;
}

/** Installed means loaded, listed under its id, or checked out under its repository's folder. */
export function isRegistryPluginInstalled(
  plugin: RegistryPlugin,
  installed: ReadonlyArray<{ id: string; directory?: string }>,
): boolean {
  const directory = plugin.repo?.split("/")[1]?.replace(/\.git$/, "").toLowerCase();
  return installed.some((entry) => (
    entry.id === plugin.id
    || (!!directory && entry.directory?.toLowerCase() === directory)
  ));
}

/**
 * The registry as last read; empty until the first answer, and on failure.
 * Read from the first typed character, and only once a renderer has declared
 * itself: a command bar rendered by a test stays off the network, and cannot
 * pick up rows from whatever the live registry holds that day.
 */
function useRegistryPlugins(active: boolean): readonly RegistryPlugin[] {
  const [plugins, setPlugins] = useState<readonly RegistryPlugin[] | null>(null);
  const load = active && plugins === null && getCurrentPluginTarget() !== "cli";
  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    void loadRegistry().then((result) => {
      if (!cancelled) setPlugins(result.plugins);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);
  return plugins ?? NO_PLUGINS;
}

const NO_PLUGINS: readonly RegistryPlugin[] = [];

function targetsOf(plugin: RegistryPlugin): PluginTarget[] {
  return Array.isArray(plugin.targets) ? plugin.targets : [];
}

/** "the desktop app and the terminal", for a plugin that cannot be installed here. */
function whereItRuns(plugin: RegistryPlugin): string {
  const targets = targetsOf(plugin);
  const desktop = targets.includes("desktop");
  const terminal = targets.includes("tui") || targets.includes("cli");
  if (desktop && !terminal) return "the desktop app";
  if (terminal && !desktop) return "the terminal";
  return "the desktop app and the terminal";
}

interface PluginInstallItemContext {
  target: PluginTarget;
  /** Null where this renderer cannot install plugins: the web app. */
  manager: PluginManager | null;
  host: MarketplaceHost | null;
  openInlineConfirm: OpenInlineConfirm;
  /** Submits the typed text again once the plugin is in, exactly as if typed and entered. */
  runQuery: (query: string) => void;
  notify: (body: string, type: "info" | "error") => void;
  openUrl: (url: string) => void;
}

/**
 * One row: the function's name and description, then what Enter does. Where
 * the plugin cannot be installed, Enter opens its page instead of an install
 * that would fail.
 */
function buildPluginInstallItem(
  offer: PluginInstallOffer,
  query: string,
  context: PluginInstallItemContext,
): ResultItem {
  const { plugin, shortcut } = offer;
  const { manager, host } = context;
  const repo = plugin.repo ?? "";
  const pageUrl = registryPluginUrl(plugin.id);
  const installable = !!manager && !!host && !!repo
    && runsExternalPlugins(context.target)
    && targetsOf(plugin).includes(context.target);
  const required = installable ? requiredGloomberb(plugin.minGloomberb) : null;

  const actionLine = !installable
    ? `Get it in ${whereItRuns(plugin)}: ${pageUrl.replace(/^https:\/\//, "")}`
    : required
      ? `Needs Gloomberb ${required}. Update Gloomberb first.`
      : `Install ${plugin.name}`;

  const install = () => {
    if (!manager || !host) return;
    const pin = registryPin({ availableVersion: plugin.ref, availableCommit: plugin.commit });
    const consent = installConsent({
      name: plugin.name,
      tier: plugin.tier,
      hosts: Array.isArray(plugin.hosts) ? plugin.hosts : [],
      repo,
    }, pin);
    let opens = false;
    context.openInlineConfirm({
      confirmId: `install-plugin:${plugin.id}`,
      title: consent.title,
      body: consent.body,
      confirmLabel: "Install",
      tone: "default",
      onConfirm: async () => {
        const result = await manager.install(repo, pin);
        if (!result.ok) throw new Error(`Could not install ${plugin.name}: ${result.error}`);
        const activated = await activateInstalledPlugin(result.directory, host, manager);
        if (!activated.ok) throw new Error(`${plugin.name} installed but did not load: ${activated.error}`);
        if (activated.restart) {
          context.notify(`Restart to finish installing ${plugin.name}.`, "info");
          return;
        }
        opens = true;
      },
      // After the bar has closed, so the function opens through the same path
      // as typing its code with the plugin installed, argument and all.
      onSuccess: () => {
        if (opens) context.runQuery(query);
      },
    });
  };

  return {
    id: `plugin-install:${plugin.id}:${shortcut.code}`,
    label: shortcut.name,
    detail: shortcut.description,
    category: PLUGIN_INSTALL_CATEGORY,
    kind: "action",
    right: shortcut.code,
    searchText: [shortcut.code, shortcut.name, plugin.name].join(" "),
    lines: [
      ...(shortcut.description ? [{ segments: [{ text: shortcut.description, emphasis: "muted" as const }] }] : []),
      { segments: [{ text: actionLine, emphasis: required ? "muted" as const : "match" as const }] },
    ],
    disabled: !!required,
    action: installable ? install : () => context.openUrl(pageUrl),
  };
}

/**
 * The install row for the root query, or null. `enabled` is false whenever
 * something else already claimed the query or the bar shows another route,
 * such as the install confirmation, so coming back from one re-reads what is
 * installed.
 */
export function useRootPluginInstallItem({
  enabled,
  query,
  commands,
  pluginRegistry,
  openInlineConfirm,
  rerunQuery,
  closeBar,
}: {
  enabled: boolean;
  query: string;
  commands: readonly Command[];
  pluginRegistry: PluginRegistry;
  openInlineConfirm: OpenInlineConfirm;
  rerunQuery: (query: string) => void;
  closeBar: () => void;
}): ResultItem | null {
  const registry = useRegistryPlugins(enabled && query.trim().length > 0);
  const offer = useMemo(() => {
    if (!enabled || registry.length === 0) return null;
    return matchPluginInstallOffer({
      query,
      registry,
      isClaimed: (code) => collectClaimedShortcutCodes(commands, pluginRegistry).has(code),
      isInstalled: (plugin) => isRegistryPluginInstalled(
        plugin,
        getMarketplaceHost()?.listInstalled() ?? [...pluginRegistry.allPlugins.keys()].map((id) => ({ id })),
      ),
    });
  }, [commands, enabled, pluginRegistry, query, registry]);

  return useMemo(() => offer
    ? buildPluginInstallItem(offer, query, {
      target: getCurrentPluginTarget(),
      manager: getPluginManager(),
      host: getMarketplaceHost(),
      openInlineConfirm,
      runQuery: rerunQuery,
      notify: (body, type) => pluginRegistry.notify({ body, type }),
      openUrl: (url) => {
        openUrl(url);
        closeBar();
      },
    })
    : null, [closeBar, offer, openInlineConfirm, pluginRegistry, query, rerunQuery]);
}

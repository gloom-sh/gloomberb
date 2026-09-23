import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Button,
  ConfirmDialog,
  DataTableStackView,
  EmptyState,
  KeyValueRow,
  PaneStatusBody,
  QueryBar,
  useExternalLinkFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type PaneFooterSegment,
  type PaneHint,
} from "../../../components";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, TextAttributes, type InputRenderable } from "../../../ui";
import { type PromptContext, useDialog } from "../../../ui/dialog";
import { isPlainKeyboardEvent } from "../../../utils/keyboard";
import { formatRelativeAge } from "../../../utils/relative-time";
import { getCurrentPluginTarget, runsExternalPlugins } from "../../current-target";
import { pluginSetupCommandId } from "../../registry/setup-command";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import { DEBUG_LOG_TEMPLATE_ID } from "../debug/template";
import { loadRegistry, registryPluginUrl } from "./feed";
import {
  buildRows,
  collectCategories,
  filterEntries,
  hasUpdate,
  isInstallable,
  isManaged,
  mergeCatalog,
  needsRemoteCheck,
  registryPin,
  SECTION_LABELS,
  sortEntries,
  statusOf,
  versionLabel,
  type MarketplaceEntry,
  type MarketplaceRow,
  type MarketplaceStatusKind,
  type RegistryPlugin,
} from "./model";
import { getMarketplaceHost, getPluginManager, type MarketplaceHost, type PluginManager } from "./store";

import { PLUGIN_MARKETPLACE_PANE_ID } from "./ids";

export { PLUGIN_MARKETPLACE_PANE_ID } from "./ids";

type Column = DataTableColumn & { id: "name" | "tagline" | "version" | "status" };

const ALL_CATEGORIES = "all";
/** Category ids are lowercase words; these read wrong title-cased. */
const CATEGORY_LABELS: Record<string, string> = { ai: "AI" };

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
}

function buildColumns(width: number): Column[] {
  const nameWidth = Math.min(24, Math.max(14, Math.floor(width * 0.22)));
  // The description takes what the other columns leave.
  return [
    { id: "name", label: "PLUGIN", width: nameWidth, align: "left" },
    { id: "tagline", label: "DESCRIPTION", width: 16, align: "left", flexGrow: 1 },
    { id: "version", label: "VERSION", width: 16, align: "right" },
    { id: "status", label: "STATUS", width: 14, align: "left" },
  ];
}

const STATUS_COLORS: Record<MarketplaceStatusKind, string> = {
  failed: colors.negative,
  "needs-restart": colors.warning,
  unsupported: colors.warning,
  "needs-setup": colors.warning,
  update: colors.textBright,
  errors: colors.warning,
  enabled: colors.positive,
  disabled: colors.textDim,
  none: colors.textDim,
};

function rowKey(row: MarketplaceRow): string {
  return row.type === "header" ? `header:${row.section}` : row.entry.id;
}

const isEntryRow = (row: MarketplaceRow) => row.type === "entry";

function renderRowSectionHeader(row: MarketplaceRow) {
  return row.type === "header"
    ? { text: `${SECTION_LABELS[row.section]} (${row.count})` }
    : null;
}

function renderCell(
  row: MarketplaceRow,
  column: Column,
  rowState: { selected: boolean },
  busyId: string | null,
): DataTableCell {
  if (row.type === "header") return { text: "" };
  const { entry } = row;
  const selected = rowState.selected ? colors.selectedText : undefined;

  switch (column.id) {
    case "name":
      return {
        text: entry.name,
        color: selected ?? (entry.featured ? colors.textBright : colors.text),
        ...(entry.featured ? { attributes: TextAttributes.BOLD } : {}),
      };
    case "tagline":
      return { text: entry.tagline, color: selected ?? colors.textDim };
    case "version": {
      const update = hasUpdate(entry);
      return { text: versionLabel(entry), color: selected ?? (update ? colors.textBright : colors.textDim) };
    }
    case "status": {
      if (busyId === entry.id) return { text: "working", color: selected ?? colors.textDim };
      const status = statusOf(entry);
      return { text: status.text, color: selected ?? STATUS_COLORS[status.kind] };
    }
  }
}

function describeContributions(entry: MarketplaceEntry, host: MarketplaceHost | null): string[] {
  const parts: string[] = [];
  const live = entry.installed && host ? host.contributions(entry.id) : null;
  const panes = live ? live.panes.length : entry.contributes?.panes.length ?? 0;
  const capabilities = live ? live.capabilities : entry.contributes?.capabilities.length ?? 0;
  const commands = live ? live.commands.length : 0;
  if (panes > 0) parts.push(`${panes} pane${panes === 1 ? "" : "s"}`);
  if (capabilities > 0) parts.push(`${capabilities} data source${capabilities === 1 ? "" : "s"}`);
  if (commands > 0) parts.push(`${commands} command${commands === 1 ? "" : "s"}`);
  if (live ? live.broker : entry.contributes?.broker) parts.push("a broker integration");
  return parts;
}

function EntryDetail({ entry, width, host }: { entry: MarketplaceEntry; width: number; host: MarketplaceHost | null }) {
  const contributes = describeContributions(entry, host);
  const live = entry.installed && host ? host.contributions(entry.id) : null;
  const opensWith = live
    ? live.templates.map((template) => template.prefix ?? template.label).filter(Boolean)
    : [];
  const rowWidth = Math.max(1, width - 2);
  const status = statusOf(entry);

  return (
    <ScrollBox flexDirection="column" width={width} paddingLeft={1} paddingRight={1}>
      <Box flexDirection="row" gap={2} height={1}>
        <Text fg={colors.textDim}>{entry.tier}</Text>
        {entry.categories.length > 0 ? <Text fg={colors.textDim}>{entry.categories.join(", ")}</Text> : null}
        {versionLabel(entry) ? <Text fg={hasUpdate(entry) ? colors.textBright : colors.textDim}>{versionLabel(entry)}</Text> : null}
        {!entry.bundled && entry.stars > 0 ? <Text fg={colors.textDim}>{`${entry.stars} star${entry.stars === 1 ? "" : "s"}`}</Text> : null}
        {status.text ? <Text fg={STATUS_COLORS[status.kind]}>{status.text}</Text> : null}
      </Box>

      {entry.description ? (
        <Box paddingTop={1} flexDirection="column">
          <Text fg={colors.text}>{entry.description}</Text>
        </Box>
      ) : null}

      <Box paddingTop={1} flexDirection="column">
        {contributes.length > 0 ? <KeyValueRow labelWidth={10} width={rowWidth} emphasis={false} label="Adds" value={contributes.join(", ")} /> : null}
        {opensWith.length > 0 ? <KeyValueRow labelWidth={10} width={rowWidth} emphasis={false} label="Opens with" value={opensWith.join(", ")} /> : null}
        {/*
          * Declared by the plugin author and not enforced: plugins are not
          * sandboxed, so this is a hint about intent, not a limit. Labelled
          * "Declares" rather than "Network" so it does not read as a guarantee.
          */}
        {entry.hosts.length > 0 ? <KeyValueRow labelWidth={10} width={rowWidth} emphasis={false} label="Declares" value={entry.hosts.join(", ")} /> : null}
        {entry.repo ? <KeyValueRow labelWidth={10} width={rowWidth} emphasis={false} label="Source" value={`github.com/${entry.repo}`} /> : null}
        {entry.minGloomberb ? <KeyValueRow labelWidth={10} width={rowWidth} emphasis={false} label="Requires" value={`Gloomberb ${entry.minGloomberb}`} /> : null}
        {entry.linked ? <KeyValueRow labelWidth={10} width={rowWidth} emphasis={false} label="Linked" value={entry.directory ?? "local checkout"} /> : null}
        {entry.installedCommit ? <KeyValueRow labelWidth={10} width={rowWidth} emphasis={false} label="Commit" value={entry.installedCommit.slice(0, 7)} /> : null}
        {!entry.installed && entry.availableCommit ? <KeyValueRow labelWidth={10} width={rowWidth} emphasis={false} label="Pinned" value={`${entry.availableVersion ?? ""} ${entry.availableCommit.slice(0, 7)}`.trim()} /> : null}
        {entry.needsSetup ? <KeyValueRow labelWidth={10} width={rowWidth} emphasis={false} label="Setup" value="Missing a required setting. Press s." /> : null}
        {entry.loadError ? <KeyValueRow labelWidth={10} width={rowWidth} emphasis={false} label="Error" value={entry.loadError} /> : null}
        {entry.lastError && !entry.loadError ? <KeyValueRow labelWidth={10} width={rowWidth} emphasis={false} label="Last error" value={entry.lastError} /> : null}
      </Box>

      {!entry.installed && !entry.bundled && entry.repo ? (
        runsExternalPlugins() ? (
          <Box paddingTop={1} flexDirection="column">
            <Text fg={colors.textDim}>Runs with your full permissions. Read the source first.</Text>
            <Text fg={colors.textBright}>{`gloomberb install ${entry.repo}`}</Text>
          </Box>
        ) : (
          // No shell here, so the install command would be a dead end. Say
          // where plugins run instead: the web app is the storefront.
          <Box paddingTop={1} flexDirection="column">
            <Text fg={colors.textDim}>Plugins run in the desktop app and the terminal.</Text>
            <Text fg={colors.textBright}>gloom.sh</Text>
          </Box>
        )
      ) : null}
    </ScrollBox>
  );
}

type Busy = { id: string; verb: "installing" | "updating" | "removing" } | null;

export function PluginMarketplacePane({ focused, width, height }: PaneProps) {
  const dialog = useDialog();
  const { createPaneFromTemplate, showPane, openPluginCommandWorkflow, notify } = usePluginAppActions();
  const [query, setQuery] = useState("");
  const [category, setCategory] = usePluginPaneState<string | null>("category", null);
  const [showBuiltin, setShowBuiltin] = useState(false);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedId", null);
  const [detailOpen, setDetailOpen] = usePluginPaneState<boolean>("detailOpen", false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchInputRef = useRef<InputRenderable | null>(null);

  const [registry, setRegistry] = useState<RegistryPlugin[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  // Bumped after any local change so the list is re-read from the host.
  const [localRevision, setLocalRevision] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  // Remote heads for plugins the registry does not pin, so a private or
  // side-loaded install can report an update like every other row.
  const [remoteHeads, setRemoteHeads] = useState<Record<string, string>>({});
  const [checkingRemotes, setCheckingRemotes] = useState(false);
  const busyId = busy?.id ?? null;
  const renderRow = useCallback((
    row: MarketplaceRow,
    column: Column,
    _index: number,
    rowState: { selected: boolean },
  ) => renderCell(row, column, rowState, busyId), [busyId]);

  const refresh = useCallback((force: boolean) => {
    setStatus((current) => (current === "ready" ? current : "loading"));
    void loadRegistry({ force }).then((result) => {
      setRegistry(result.plugins);
      setStale(result.stale);
      setFetchedAt(result.fetchedAt);
      setStatus(result.error && result.plugins.length === 0 ? "error" : "ready");
    });
  }, []);

  useEffect(() => refresh(false), [refresh]);

  const host = getMarketplaceHost();
  const manager = getPluginManager();
  const target = getCurrentPluginTarget();
  const entries = useMemo(() => {
    void localRevision;
    const installed = host?.listInstalled() ?? [];
    return sortEntries(mergeCatalog({ registry, installed, target, remoteHeads }));
  }, [host, registry, target, localRevision, remoteHeads]);

  // Keyed by the folders themselves: the entries array is rebuilt whenever an
  // answer lands, and re-running the check on its own result would never stop.
  const unlistedDirectories = useMemo(
    () => entries.filter(needsRemoteCheck).map((entry) => entry.directory!).sort(),
    [entries],
  );
  const unlistedKey = unlistedDirectories.join(",");

  useEffect(() => {
    const check = manager?.remoteHeads;
    if (!check || unlistedKey.length === 0) return;
    let cancelled = false;
    setCheckingRemotes(true);
    void check(unlistedKey.split(","))
      // Offline, or a private repository this machine has no credentials for:
      // the row keeps whatever it knew, without an error in the way.
      .catch(() => ({}))
      .then((heads) => {
        if (cancelled) return;
        setRemoteHeads(heads);
        setCheckingRemotes(false);
      });
    return () => {
      cancelled = true;
      setCheckingRemotes(false);
    };
  }, [manager, unlistedKey, localRevision]);

  const visible = useMemo(
    () => filterEntries(entries, { query, category, showBuiltin }),
    [entries, query, category, showBuiltin],
  );
  const categories = useMemo(
    () => collectCategories(filterEntries(entries, { query: "", category: null, showBuiltin })),
    [entries, showBuiltin],
  );
  const rows = useMemo(() => buildRows(visible), [visible]);

  const selected = useMemo(
    () => visible.find((entry) => entry.id === selectedId) ?? visible[0] ?? null,
    [visible, selectedId],
  );

  const bump = useCallback(() => setLocalRevision((value) => value + 1), []);

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((token) => token + 1);
  }, []);
  const blurSearch = useCallback(() => setSearchFocused(false), []);

  const confirm = useCallback((options: {
    title: string;
    body: string[];
    confirmLabel: string;
    danger?: boolean;
  }) => dialog.prompt<boolean>({
    closeOnClickOutside: true,
    content: (ctx: PromptContext<boolean>) => (
      <ConfirmDialog
        {...ctx}
        title={options.title}
        body={options.body}
        confirmLabel={options.confirmLabel}
        cancelLabel="Cancel"
        confirmVariant={options.danger ? "danger" : "primary"}
        width={Math.min(64, Math.max(44, width - 8))}
        footer={`Enter ${options.confirmLabel.toLowerCase()} · Esc cancel`}
      />
    ),
  }).catch(() => false), [dialog, width]);

  /**
   * Brings a freshly installed or updated checkout into this session. What
   * cannot be activated is still recorded, with its error, so the row says
   * `failed` and the detail says why rather than the plugin simply not
   * appearing until a restart.
   */
  const activate = useCallback(async (
    directory: string,
    activeHost: MarketplaceHost,
    activeManager: PluginManager,
  ): Promise<{ ok: true; pluginId: string; name: string } | { ok: false; error: string }> => {
    const loaded = await activeManager.load(directory);
    if (!loaded) return { ok: false, error: "The plugin has no entry file." };
    if (loaded.error) {
      await activeHost.activate(loaded).catch(() => {});
      return { ok: false, error: loaded.error };
    }
    // Where data calls execute first, so a pane that renders can also fetch.
    if (activeManager.activate && !loaded.unsupportedTarget) {
      const backend = await activeManager.activate(directory);
      if (!backend.ok) {
        await activeHost.activate({ ...loaded, error: backend.error }).catch(() => {});
        return { ok: false, error: backend.error };
      }
    }
    try {
      await activeHost.activate(loaded);
      return { ok: true, pluginId: loaded.plugin.id, name: loaded.plugin.name };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, []);

  const announceAdded = useCallback((pluginId: string, name: string, verb: string, activeHost: MarketplaceHost) => {
    const added = activeHost.contributions(pluginId);
    const parts: string[] = [];
    if (added.panes.length > 0) parts.push(`${added.panes.length} pane${added.panes.length === 1 ? "" : "s"}`);
    if (added.commands.length > 0) parts.push(`${added.commands.length} command${added.commands.length === 1 ? "" : "s"}`);
    if (added.capabilities > 0) parts.push(`${added.capabilities} data source${added.capabilities === 1 ? "" : "s"}`);
    if (added.broker) parts.push("a broker");
    const firstTemplate = added.templates[0];
    const firstPane = added.panes[0];
    notify({
      body: parts.length > 0 ? `${verb} ${name}: ${parts.join(", ")}.` : `${verb} ${name}.`,
      type: "success",
      ...(firstTemplate || firstPane
        ? {
          action: {
            label: "Open",
            onClick: () => {
              if (firstTemplate) createPaneFromTemplate(firstTemplate.id);
              else if (firstPane) showPane(firstPane.id);
            },
          },
        }
        : {}),
    });
  }, [createPaneFromTemplate, notify, showPane]);

  const installSelected = useCallback(async () => {
    if (!selected || !isInstallable(selected) || !manager || !host || busy) return;
    // Installs address the repository, not the plugin id: there is no central
    // name resolution, so owner/repo is the only unambiguous reference.
    const repo = selected.repo;
    if (!repo) return;
    const pin = registryPin(selected);
    const body = [
      `${selected.name} runs with your full permissions. It is not sandboxed.`,
      `Source: github.com/${repo}${pin?.ref ? ` at ${pin.ref}` : ""}${pin?.commit ? ` (${pin.commit.slice(0, 7)})` : ""}`,
      selected.tier === "official" ? "Published by Gloom." : selected.tier === "verified" ? "Reviewed by Gloom." : "Community plugin, not reviewed.",
      ...(selected.hosts.length > 0 ? [`Declares access to ${selected.hosts.join(", ")}.`] : []),
    ];
    const confirmed = await confirm({ title: `Install ${selected.name}?`, body, confirmLabel: "Install" });
    if (!confirmed) return;

    const entry = selected;
    setBusy({ id: entry.id, verb: "installing" });
    setLastError(null);
    const result = await manager.install(repo, pin);
    if (!result.ok) {
      setBusy(null);
      setLastError(result.error);
      notify({ body: `Could not install ${entry.name}: ${result.error}`, type: "error" });
      return;
    }
    const activated = await activate(result.directory, host, manager);
    setBusy(null);
    bump();
    if (activated.ok) announceAdded(activated.pluginId, activated.name, "Installed", host);
    else notify({ body: `${entry.name} installed but did not load: ${activated.error}`, type: "error" });
  }, [activate, announceAdded, bump, busy, confirm, host, manager, notify, selected]);

  const updateSelected = useCallback(async () => {
    if (!selected || !isManaged(selected) || !manager || !host || busy || selected.linked) return;
    const directory = selected.directory!;
    const entry = selected;
    const reinstall = !!entry.loadError;
    setBusy({ id: entry.id, verb: "updating" });
    setLastError(null);
    const result = await manager.update(directory, registryPin(entry));
    if (!result.ok) {
      setBusy(null);
      setLastError(result.error);
      notify({ body: `Could not update ${entry.name}: ${result.error}`, type: "error" });
      return;
    }
    const activated = await activate(directory, host, manager);
    setBusy(null);
    bump();
    if (activated.ok) announceAdded(activated.pluginId, activated.name, reinstall ? "Reloaded" : "Updated", host);
    else notify({ body: `${entry.name} updated but did not load: ${activated.error}`, type: "error" });
  }, [activate, announceAdded, bump, busy, host, manager, notify, selected]);

  const removeSelected = useCallback(async () => {
    if (!selected || !isManaged(selected) || !manager || !host || busy) return;
    const entry = selected;
    const confirmed = await confirm({
      title: `Remove ${entry.name}?`,
      body: entry.linked
        ? ["Removes the link. Your local checkout is left alone."]
        : [`Deletes ~/.gloomberb/plugins/${entry.directory}.`, "Its panes close now. Settings it saved are kept."],
      confirmLabel: "Remove",
      danger: true,
    });
    if (!confirmed) return;
    setBusy({ id: entry.id, verb: "removing" });
    setLastError(null);
    await host.deactivate(entry.id, entry.directory).catch(() => {});
    await manager.deactivate?.(entry.id).catch(() => {});
    const result = await manager.remove(entry.directory!);
    setBusy(null);
    bump();
    if (result.ok) notify({ body: `Removed ${entry.name}.`, type: "success" });
    else {
      setLastError(result.error);
      notify({ body: `Could not remove ${entry.name}: ${result.error}`, type: "error" });
    }
  }, [bump, busy, confirm, host, manager, notify, selected]);

  const toggleSelected = useCallback(() => {
    if (!host || !selected || !selected.installed || !selected.toggleable || selected.loadError) return;
    host.setPluginEnabled(selected.id, !selected.enabled);
    bump();
  }, [bump, host, selected]);

  const setupSelected = useCallback(() => {
    if (!selected || !selected.installed || !selected.hasSetup || !selected.enabled) return;
    openPluginCommandWorkflow(pluginSetupCommandId(selected.id));
  }, [openPluginCommandWorkflow, selected]);

  const openSelected = useCallback(() => {
    if (!host || !selected || !selected.installed || !selected.enabled || selected.loadError) return;
    const added = host.contributions(selected.id);
    const template = added.templates[0];
    const pane = added.panes[0];
    if (template) createPaneFromTemplate(template.id);
    else if (pane) showPane(pane.id);
  }, [createPaneFromTemplate, host, selected, showPane]);

  const openLog = useCallback(() => {
    if (!selected || !selected.installed) return;
    createPaneFromTemplate(DEBUG_LOG_TEMPLATE_ID, { values: { source: selected.id } });
  }, [createPaneFromTemplate, selected]);

  const canOpen = !!selected && !!host && selected.installed && selected.enabled && !selected.loadError
    && (host.contributions(selected.id).templates.length > 0 || host.contributions(selected.id).panes.length > 0);
  const canInstall = !!selected && isInstallable(selected) && !!manager && !busy;
  const canUpdate = !!selected && isManaged(selected) && !selected.linked && !!manager && !busy
    && (hasUpdate(selected) || !!selected.loadError);
  const canRemove = !!selected && isManaged(selected) && !!manager && !busy;
  const canToggle = !!selected && selected.installed && selected.toggleable && !selected.loadError;
  const canSetup = !!selected && selected.installed && selected.enabled && selected.hasSetup;
  const canLog = !!selected && selected.installed && (selected.errorCount > 0 || !!selected.loadError);

  const handleKey = useCallback((key: string): boolean => {
    switch (key) {
      case "i": void installSelected(); return true;
      case "u": void updateSelected(); return true;
      case "x": void removeSelected(); return true;
      case "e": toggleSelected(); return true;
      case "s": setupSelected(); return true;
      case "p": openSelected(); return true;
      case "d": openLog(); return true;
      case "r": refresh(true); return true;
      case "b": setShowBuiltin((value) => !value); return true;
      case "/": focusSearch(); return true;
      default: return false;
    }
  }, [focusSearch, installSelected, openLog, openSelected, refresh, removeSelected, setupSelected, toggleSelected, updateSelected]);

  /**
   * Pane keys go through the table's key handler, which runs while the pane
   * is focused whether the list is full or empty, and through the detail
   * view's when that is open. A global `useShortcut` on top would see the
   * same press a second time and undo every toggle.
   */
  const handleRootKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (searchFocused || !isPlainKeyboardEvent(event)) return;
    return handleKey((event.name ?? "").toLowerCase()) ? true : undefined;
  }, [handleKey, searchFocused]);

  const info: PaneFooterSegment[] = [];
  if (status === "loading") info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
  if (status === "error") info.push({ id: "error", parts: [{ text: "catalog unavailable", tone: "warning" }] });
  if (stale) info.push({ id: "stale", parts: [{ text: "stale catalog", tone: "warning" }] });
  if (checkingRemotes) info.push({ id: "remote-check", parts: [{ text: "checking unlisted plugins", tone: "muted" }] });
  if (busy) {
    const name = entries.find((entry) => entry.id === busy.id)?.name ?? busy.id;
    info.push({ id: "busy", parts: [{ text: `${busy.verb} ${name}`, tone: "muted" }] });
  }
  if (lastError && !busy) info.push({ id: "op-error", parts: [{ text: lastError, tone: "warning" }] });
  const restartCount = entries.filter((entry) => entry.needsRestart).length;
  if (restartCount > 0 && !busy) {
    info.push({ id: "restart", parts: [{ text: "restart to finish loading", tone: "warning" }] });
  }
  if (status === "ready" && fetchedAt && !stale && !busy) {
    info.push({ id: "updated", parts: [{ text: formatRelativeAge(fetchedAt), tone: "muted" }] });
  }

  const hints: PaneHint[] = [];
  if (canInstall) hints.push({ id: "install", key: "i", label: "nstall", onPress: () => { void installSelected(); } });
  if (canUpdate) hints.push({ id: "update", key: "u", label: selected?.loadError ? "reload" : "pdate", onPress: () => { void updateSelected(); } });
  if (canToggle) hints.push({ id: "toggle", key: "e", label: selected?.enabled ? "disable" : "nable", onPress: toggleSelected });
  if (canSetup) hints.push({ id: "setup", key: "s", label: "etup", onPress: setupSelected });
  if (canOpen) hints.push({ id: "open-pane", key: "p", label: "ane", onPress: openSelected });
  if (canLog) hints.push({ id: "log", key: "d", label: "ebug log", onPress: openLog });
  if (canRemove) hints.push({ id: "remove", key: "x", label: " remove", onPress: () => { void removeSelected(); } });

  useExternalLinkFooter({
    registrationId: PLUGIN_MARKETPLACE_PANE_ID,
    focused,
    url: selected && !selected.bundled && selected.repo ? registryPluginUrl(selected.id) : null,
    source: selected && !selected.bundled && selected.repo ? "gloom.sh" : null,
    info,
    hints,
  });

  const columns = useMemo(() => buildColumns(width), [width]);
  // The pick is saved with the pane, so keep it listed (and resettable) even
  // when the catalog no longer has plugins in it.
  const categoryOptions = useMemo(
    () => [
      { label: "All", value: ALL_CATEGORIES },
      ...(category && !categories.includes(category) ? [...categories, category] : categories)
        .map((entry) => ({ label: categoryLabel(entry), value: entry })),
    ],
    [categories, category],
  );
  // `b` stays the keyboard way to flip the built-in filter; the bar shows it.
  const emptyState = status === "error" ? (
    <EmptyState
      title="Plugin catalog unavailable."
      status="error"
      actions={<Button label="Retry" variant="primary" compact onPress={() => refresh(true)} />}
    />
  ) : query || category ? (
    <EmptyState title="No plugins match." />
  ) : (
    <EmptyState
      title="Nothing installed yet."
      actions={showBuiltin ? undefined : (
        <Button label="Show built in" variant="secondary" compact onPress={() => setShowBuiltin(true)} />
      )}
    />
  );

  if (status === "loading" && entries.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <PaneStatusBody loading align="center" loadingLabel="" />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <DataTableStackView<MarketplaceRow, Column>
        focused={focused && !searchFocused}
        detailOpen={detailOpen && !!selected}
        onBack={() => setDetailOpen(false)}
        detailContent={selected ? <EntryDetail entry={selected} width={width} host={host} /> : null}
        detailTitle={selected?.name}
        rootBefore={(
          <QueryBar
            width={width}
            search={{
              value: query,
              onChange: setQuery,
              placeholder: "name",
              focused: focused && !detailOpen,
              active: searchFocused,
              onActiveChange: (active) => { if (active) focusSearch(); else blurSearch(); },
              focusToken: searchFocusToken,
              inputRef: searchInputRef,
              onNavigateDown: blurSearch,
            }}
            filters={[
              ...(categories.length > 1 || category ? [{
                id: "category",
                label: "Category",
                value: category ?? ALL_CATEGORIES,
                defaultValue: ALL_CATEGORIES,
                options: categoryOptions,
                onChange: (value: string) => setCategory(value === ALL_CATEGORIES ? null : value),
              }] : []),
              { kind: "toggle" as const, id: "builtin", label: "Built in", value: showBuiltin, onChange: setShowBuiltin },
            ]}
          />
        )}
        selection={{
          kind: "id",
          selectedId: selected?.id ?? null,
          getId: rowKey,
          onChange: (_id, row) => {
            if (row.type === "entry") setSelectedId(row.entry.id);
          },
        }}
        isNavigable={isEntryRow}
        onRootKeyDown={handleRootKeyDown}
        onDetailKeyDown={handleRootKeyDown}
        onActivate={(row) => {
          if (row.type === "entry") setDetailOpen(true);
        }}
        rootWidth={width}
        rootHeight={height}
        columns={columns}
        items={rows}
        getItemKey={rowKey}
        sortColumnId={null}
        sortDirection="asc"
        renderSectionHeader={renderRowSectionHeader}
        renderCell={renderRow}
        emptyContent={<Box width="100%" paddingX={1} paddingY={1}>{emptyState}</Box>}
        emptyStateTitle={status === "error" ? "Plugin catalog unavailable." : query || category ? "No plugins match." : "Nothing installed yet."}
      />
    </Box>
  );
}

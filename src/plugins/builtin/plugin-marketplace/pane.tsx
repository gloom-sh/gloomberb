import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import {
  Button,
  ChoiceDialog,
  confirmDialog,
  DetailScrollBody,
  DataTableStackView,
  EmptyState,
  KeyValueRow,
  openUrl,
  PaneStatusBody,
  QueryBar,
  RemoteImage,
  Section,
  SectionHeading,
  useExternalLinkFooter,
  useQueryBarSearch,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type PaneHint,
} from "../../../components";
import { loadingErrorFooterInfo } from "../../../components/data-table/table-pane";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, TextAttributes, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { useDialog, type PromptContext } from "../../../ui/dialog";
import { isPlainKeyboardEvent } from "../../../utils/keyboard";
import { formatRelativeAge } from "../../../utils/datetime-format";
import { requiredGloomberb } from "../../../utils/semver";
import { VERSION } from "../../../version";
import { getCurrentPluginTarget, runsExternalPlugins } from "../../current-target";
import { pluginSetupCommandId } from "../../registry/setup-command";
import { useAppSelector } from "../../../state/app/context";
import { BUILTIN_EDITORIAL } from "../../builtin-editorial";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import { DEBUG_LOG_TEMPLATE_ID } from "../debug/template";
import { loadRegistry, registryPluginUrl } from "./feed";
import { highlightedCodes, pluginFunctions, proFunctionCount, type PluginFunction } from "../../plugin-functions";
import {
  matchingPack,
  packChange,
  packToggles,
  restoreToggles,
  STARTER_PACKS,
  type PackChange,
  type StarterPack,
} from "./packs";
import {
  buildRows,
  collectCategories,
  CORE_PLUGIN_ID,
  filterEntries,
  hasUpdate,
  installConsent,
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
import { activateInstall, activateInstalledPlugin } from "./activation";
import { getMarketplaceHost, getPluginManager, type MarketplaceHost } from "./store";

import { PLUGIN_MARKETPLACE_PANE_ID } from "./ids";

type Column = DataTableColumn & { id: "name" | "tagline" | "panes" | "functions" | "pro" | "status" };

const ALL_CATEGORIES = "all";
/** Category ids are lowercase words; these read wrong title-cased. */
const CATEGORY_LABELS: Record<string, string> = { ai: "AI" };

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
}

/**
 * A row reads as a name, a short line and three chips: how many panes, the
 * codes that open them, and how many of its functions Pro unlocks. Narrow
 * panes give up the Pro count, then the codes. Versions are in the detail;
 * a waiting update shows in the status.
 */
function buildColumns(width: number, fit: { functions: number; status: number }): Column[] {
  const nameWidth = Math.min(23, Math.max(14, Math.floor(width * 0.2)));
  // The description takes what the other columns leave; the chips take what they need.
  return [
    { id: "name", label: "PLUGIN", width: nameWidth, align: "left" },
    { id: "tagline", label: "DESCRIPTION", width: 16, align: "left", flexGrow: 1 },
    { id: "panes", label: "PANES", width: 5, align: "right" },
    ...(width >= 80 ? [{ id: "functions" as const, label: "FUNCTIONS", width: fit.functions, align: "left" as const }] : []),
    ...(width >= 96 ? [{ id: "pro" as const, label: "PRO", width: 3, align: "right" as const }] : []),
    { id: "status", label: "STATUS", width: fit.status, align: "left" },
  ];
}

/** What a row's chips say about a plugin. */
interface EntryFacts {
  panes: number;
  paneNames: string[];
  functions: PluginFunction[];
  /** At most three codes, for the row. */
  codes: string[];
  /** Functions Free cannot fully open. */
  pro: number;
}

/**
 * Read from what the plugin registered when it is loaded here, so a built-in
 * reads the way this build has it; from what the feed says otherwise.
 */
function entryFacts(entry: MarketplaceEntry, host: MarketplaceHost | null): EntryFacts {
  const live = entry.installed && host && !entry.loadError ? host.contributions(entry.id) : null;
  const functions = live
    ? pluginFunctions({ templates: live.templates, commands: live.commands })
    : (entry.contributes?.shortcuts ?? []).map((shortcut) => ({
      code: shortcut.code,
      name: shortcut.name,
      description: shortcut.description,
      ...(shortcut.access ? { access: shortcut.access } : {}),
    }));
  return {
    panes: live ? live.panes.length : entry.contributes?.panes.length ?? 0,
    paneNames: live ? live.panes.map((pane) => pane.name) : [],
    functions,
    codes: entry.bundled ? highlightedCodes(entry.id, functions) : functions.slice(0, 3).map((fn) => fn.code),
    pro: proFunctionCount(functions),
  };
}

const ACCESS_LABELS = { pro: "Pro", preview: "Pro, free preview" } as const;

const STATUS_COLORS: Record<MarketplaceStatusKind, string> = {
  failed: colors.negative,
  "needs-restart": colors.warning,
  unsupported: colors.warning,
  "needs-setup": colors.warning,
  update: colors.textBright,
  "needs-gloomberb": colors.warning,
  errors: colors.warning,
  // On is the normal state, so it stays quiet and what is off stands out.
  enabled: colors.textDim,
  disabled: colors.textBright,
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
  facts: (entry: MarketplaceEntry) => EntryFacts,
): DataTableCell {
  if (row.type === "header") return { text: "" };
  const { entry } = row;
  const selected = rowState.selected ? colors.selectedText : undefined;

  switch (column.id) {
    case "panes": {
      const panes = facts(entry).panes;
      return { text: panes > 0 ? String(panes) : "", color: selected ?? colors.textDim };
    }
    case "functions":
      return { text: facts(entry).codes.join(" "), color: selected ?? colors.text };
    case "pro": {
      const pro = facts(entry).pro;
      return { text: pro > 0 ? String(pro) : "", color: selected ?? colors.warning };
    }
    case "name":
      return {
        text: entry.name,
        color: selected ?? (entry.featured ? colors.textBright : colors.text),
        ...(entry.featured ? { attributes: TextAttributes.BOLD } : {}),
      };
    case "tagline":
      return { text: entry.tagline, color: selected ?? colors.textDim };
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
    <ScrollBox flexDirection="column" width={width} flexGrow={1} flexBasis={0} minHeight={0} paddingLeft={1} paddingRight={1} scrollY focusable={false}>
      <Box flexDirection="row" gap={2} height={1}>
        <Text fg={colors.textDim}>{entry.tier}</Text>
        {entry.categories.length > 0 ? <Text fg={colors.textDim}>{entry.categories.join(", ")}</Text> : null}
        {versionLabel(entry) ? <Text fg={hasUpdate(entry) ? colors.textBright : colors.textDim}>{versionLabel(entry)}</Text> : null}
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
        {entry.minGloomberb ? <KeyValueRow labelWidth={10} width={rowWidth} emphasis={false} label="Requires" value={requiredGloomberb(entry.minGloomberb) ? `Gloomberb ${entry.minGloomberb}, this is ${VERSION}` : `Gloomberb ${entry.minGloomberb}`} /> : null}
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

/** gloom.sh keeps a reviewed capture of these functions. */
function functionShotUrl(code: string): string {
  return `https://gloom.sh/screenshots/fn/${encodeURIComponent(code)}.png`;
}

/**
 * A built-in: what it adds and what Pro opens, function by function. The
 * desktop shows a capture or two; the terminal leaves them to gloom.sh.
 */
function BuiltinDetail({ entry, width, facts, scrollRef }: {
  entry: MarketplaceEntry;
  width: number;
  facts: EntryFacts;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  // DetailScrollBody pads a cell on each side, and its scrollbar takes one.
  const rowWidth = Math.max(1, width - 4);
  const nameWidth = Math.max(12, Math.min(34, rowWidth - 8 - 20));
  const status = statusOf(entry);
  const shots = nativePaneChrome ? (BUILTIN_EDITORIAL[entry.id]?.screenshots ?? []).slice(0, 2) : [];
  const shotWidth = Math.min(rowWidth, 72);
  const summary = [
    `${facts.panes} pane${facts.panes === 1 ? "" : "s"}`,
    `${facts.functions.length} function${facts.functions.length === 1 ? "" : "s"}`,
    ...(facts.pro > 0 ? [`${facts.pro} Pro`] : []),
  ];

  return (
    <DetailScrollBody ref={scrollRef} resetScrollKey={entry.id}>
      <Box flexDirection="row" gap={2} height={1}>
        <Text fg={STATUS_COLORS[status.kind]}>{status.text}</Text>
        <Text fg={colors.textDim}>{summary.join(" · ")}</Text>
      </Box>

      {entry.description ? (
        <Box paddingTop={1} flexDirection="column">
          <Text fg={colors.text}>{entry.description}</Text>
        </Box>
      ) : null}

      {shots.length > 0 ? (
        <Box paddingTop={1} flexDirection="column" gap={1}>
          {shots.map((code) => (
            <RemoteImage
              key={code}
              src={functionShotUrl(code)}
              alt={`${code} in Gloomberb`}
              label={code}
              width={shotWidth}
              height={Math.max(8, Math.floor(shotWidth * 0.3))}
            />
          ))}
        </Box>
      ) : null}

      {facts.functions.length > 0 ? (
        <Section title="Functions" width={rowWidth}>
          {facts.functions.map((fn) => (
            // The code is what people type, so it leads; Pro reads in the PRO column's colour.
            <Box key={fn.code} flexDirection="row" height={1} width={rowWidth} overflow="hidden">
              <Box width={8} flexShrink={0}><Text fg={colors.textBright}>{fn.code}</Text></Box>
              <Box width={nameWidth} flexShrink={0} overflow="hidden"><Text fg={colors.text}>{fn.name}</Text></Box>
              {fn.access ? <Box flexShrink={1} minWidth={0} overflow="hidden"><Text fg={colors.warning}>{ACCESS_LABELS[fn.access]}</Text></Box> : null}
            </Box>
          ))}
        </Section>
      ) : null}

      {facts.paneNames.length > 0 ? (
        <Box paddingTop={1} flexDirection="column">
          <SectionHeading title="Panes" width={rowWidth} />
          <Text fg={colors.textDim}>{facts.paneNames.join(", ")}</Text>
        </Box>
      ) : null}
    </DetailScrollBody>
  );
}

/** The strip's labels; the full names are in the menu, the confirmation and the toast. */
const PACK_SHORT_LABELS: Record<string, string> = {
  everything: "Everything",
  "equity-research": "Equity",
  "options-desk": "Options",
  "macro-rates": "Macro",
  "credit-bonds": "Credit",
  "alt-data-quant": "Alt data",
};
/** The strip's value when the plugins on match no pack. */
const CUSTOM_PACK = "custom";

/** One line per kind of change, with the plugins it names. */
function PackChangeBody({ change, name, width }: { change: PackChange; name: (id: string) => string; width: number }) {
  const lines = [
    { label: "Turn off", ids: change.turnOff },
    { label: "Turn on", ids: change.turnOn },
    { label: "Keep", ids: change.keep },
  ].filter((line) => line.ids.length > 0);
  return (
    <Box flexDirection="column" width={width} gap={1}>
      {lines.map((line) => (
        <Box key={line.label} flexDirection="row" width={width}>
          <Box width={12} flexShrink={0}>
            <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{`${line.label} ${line.ids.length}`}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text fg={colors.text} wrapText>{line.ids.map(name).join(", ")}</Text>
          </Box>
        </Box>
      ))}
      {change.turnOff.length > 0 ? (
        <Text fg={colors.textDim} wrapText>Panes are hidden, not closed. Undo brings them back.</Text>
      ) : null}
    </Box>
  );
}

type Busy = { id: string; verb: "installing" | "updating" | "removing" } | null;

export function PluginMarketplacePane({ focused, width, height }: PaneProps) {
  const dialog = useDialog();
  const { createPaneFromTemplate, showPane, openPluginCommandWorkflow, notify } = usePluginAppActions();
  const [query, setQuery] = useState("");
  const [category, setCategory] = usePluginPaneState<string | null>("category", null);
  // Built-ins are what Gloomberb is made of, so they show unless filtered out.
  const [showBuiltin, setShowBuiltin] = usePluginPaneState<boolean>("showBuiltin", true);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedId", null);
  const [detailOpen, setDetailOpen] = usePluginPaneState<boolean>("detailOpen", false);
  const { active: searchFocused, focus: focusSearch, blur: blurSearch, searchProps } = useQueryBarSearch();
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);

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
  // A switch from anywhere (a pack, a toast, a sync) re-reads the list.
  const disabledPlugins = useAppSelector((state) => state.config.disabledPlugins);
  const entries = useMemo(() => {
    void localRevision;
    void disabledPlugins;
    const installed = host?.listInstalled() ?? [];
    return sortEntries(mergeCatalog({ registry, installed, target, remoteHeads }));
  }, [host, registry, target, localRevision, remoteHeads, disabledPlugins]);
  const currentPack = useMemo(() => matchingPack(disabledPlugins), [disabledPlugins]);
  // Rebuilt with the entries, which a switch or an install already refreshes.
  const factsFor = useMemo(() => {
    const cache = new Map<string, EntryFacts>();
    return (entry: MarketplaceEntry): EntryFacts => {
      const cached = cache.get(entry.id);
      if (cached) return cached;
      const facts = entryFacts(entry, host);
      cache.set(entry.id, facts);
      return facts;
    };
  }, [entries, host]);
  const renderRow = useCallback((
    row: MarketplaceRow,
    column: Column,
    _index: number,
    rowState: { selected: boolean },
  ) => renderCell(row, column, rowState, busyId, factsFor), [busyId, factsFor]);

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

  // The terminal's default dialog is 60 columns, 54 inside its border and
  // padding; a wider body runs over the border.
  const confirmWidth = Math.min(54, Math.max(44, width - 8));

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

  /**
   * The registry's code for this plugin needs a newer Gloomberb. Installing or
   * updating would land it anyway and it would then fail to compile, so say
   * what to do instead. Also leaves a working older checkout alone, and does
   * not update one that already needs a newer Gloomberb: updates only move
   * forward, so that would not help either.
   */
  const refuseTooNew = useCallback((entry: MarketplaceEntry): boolean => {
    const required = requiredGloomberb(entry.minGloomberb) ?? entry.needsGloomberb;
    if (!required) return false;
    notify({ body: `${entry.name} needs Gloomberb ${required}. Update Gloomberb first.`, type: "error" });
    return true;
  }, [notify]);

  const installSelected = useCallback(async () => {
    if (!selected || !isInstallable(selected) || !manager || !host || busy) return;
    // Installs address the repository, not the plugin id: there is no central
    // name resolution, so owner/repo is the only unambiguous reference.
    const repo = selected.repo;
    if (!repo) return;
    if (refuseTooNew(selected)) return;
    const pin = registryPin(selected);
    const consent = installConsent({ ...selected, repo }, pin);
    const confirmed = await confirmDialog(dialog, {
      title: consent.title,
      body: consent.body,
      confirmLabel: "Install",
      confirmVariant: "primary",
      width: confirmWidth,
    });
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
    const activated = await activateInstall(result, host, manager);
    setBusy(null);
    bump();
    if (activated.ok && activated.restart) notify({ body: `Restart to finish installing ${entry.name}.`, type: "info" });
    else if (activated.ok) announceAdded(activated.pluginId, activated.name, "Installed", host);
    else notify({ body: `${entry.name} installed but did not load: ${activated.error}`, type: "error" });
  }, [announceAdded, bump, busy, confirmWidth, dialog, host, manager, notify, refuseTooNew, selected]);

  const updateSelected = useCallback(async () => {
    if (!selected || !isManaged(selected) || !manager || !host || busy || selected.linked) return;
    if (refuseTooNew(selected)) return;
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
    if (result.kept) {
      setBusy(null);
      notify({ body: `Kept ${entry.name}: ${result.kept}.`, type: "info" });
      return;
    }
    const activated = await activateInstalledPlugin(directory, host, manager);
    setBusy(null);
    bump();
    if (activated.ok && activated.restart) {
      notify({ body: `Restart to finish ${reinstall ? "reloading" : "updating"} ${entry.name}.`, type: "info" });
    } else if (activated.ok) {
      announceAdded(activated.pluginId, activated.name, reinstall ? "Reloaded" : "Updated", host);
    } else {
      notify({ body: `${entry.name} updated but did not load: ${activated.error}`, type: "error" });
    }
  }, [announceAdded, bump, busy, host, manager, notify, refuseTooNew, selected]);

  const removeSelected = useCallback(async () => {
    if (!selected || !isManaged(selected) || !manager || !host || busy) return;
    const entry = selected;
    const confirmed = await confirmDialog(dialog, {
      title: `Remove ${entry.name}?`,
      body: entry.linked
        ? ["Removes the link. Your local checkout is left alone."]
        : [`Deletes ${entry.path ?? `the ${entry.directory} plugin folder`}.`, "Its panes close now. Settings it saved are kept."],
      confirmLabel: "Remove",
      width: confirmWidth,
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
  }, [bump, busy, confirmWidth, dialog, host, manager, notify, selected]);

  const toggleSelected = useCallback(async () => {
    if (!host || !selected || !selected.installed || !selected.toggleable || selected.loadError) return;
    const entry = selected;
    if (entry.id === CORE_PLUGIN_ID && entry.bundled && entry.enabled) {
      const confirmed = await confirmDialog(dialog, {
        title: `Turn off ${entry.name}?`,
        body: ["DES, G and the research pane stop working until you turn it back on."],
        confirmLabel: "Turn off",
        width: confirmWidth,
      });
      if (!confirmed) return;
    }
    host.setPluginEnabled(entry.id, !entry.enabled);
    bump();
  }, [bump, confirmWidth, dialog, host, selected]);

  const pluginName = useCallback(
    (id: string) => entries.find((entry) => entry.id === id)?.name ?? id,
    [entries],
  );

  /**
   * Says exactly what the pack turns off and on, applies it in one switch,
   * and offers Undo: nothing is closed, so the old set comes back as it was.
   */
  const applyPack = useCallback(async (pack: StarterPack) => {
    if (!host) return;
    const previous = [...disabledPlugins];
    const change = packChange(previous, pack);
    const toggles = packToggles(change);
    if (Object.keys(toggles).length === 0) {
      notify({ body: `${pack.name} is already what you have on.`, type: "info" });
      return;
    }
    const confirmed = await confirmDialog(dialog, {
      title: `Switch to ${pack.name}?`,
      body: <PackChangeBody change={change} name={pluginName} width={confirmWidth} />,
      confirmLabel: "Switch",
      confirmVariant: "primary",
      width: confirmWidth,
    });
    if (!confirmed) return;
    host.setPluginsEnabled(toggles);
    bump();
    const parts = [
      ...(change.turnOff.length > 0 ? [`${change.turnOff.length} off`] : []),
      ...(change.turnOn.length > 0 ? [`${change.turnOn.length} back on`] : []),
    ];
    notify({
      body: `${pack.name}: ${parts.join(", ")}.`,
      type: "success",
      // Long enough to reach for Undo after looking at the list.
      duration: 12_000,
      action: {
        label: "Undo",
        onClick: () => {
          host.setPluginsEnabled(restoreToggles(previous));
          bump();
        },
      },
    });
  }, [bump, confirmWidth, dialog, disabledPlugins, host, notify, pluginName]);

  const choosePack = useCallback(async () => {
    const id = await dialog.prompt<string>({
      closeOnClickOutside: true,
      content: (context: PromptContext<string>) => (
        <ChoiceDialog
          {...context}
          title="Starter packs"
          selectedChoiceId={currentPack?.id}
          choices={STARTER_PACKS.map((pack) => ({ id: pack.id, label: pack.name, description: pack.tagline }))}
        />
      ),
    }).catch(() => null);
    const pack = STARTER_PACKS.find((candidate) => candidate.id === id);
    if (pack) await applyPack(pack);
  }, [applyPack, currentPack, dialog]);

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
  const tooNew = !!selected && (!!requiredGloomberb(selected.minGloomberb) || !!selected.needsGloomberb);
  const canInstall = !!selected && isInstallable(selected) && !!manager && !busy && !tooNew;
  const canUpdate = !!selected && isManaged(selected) && !selected.linked && !!manager && !busy && !tooNew
    && (hasUpdate(selected) || !!selected.loadError);
  const canRemove = !!selected && isManaged(selected) && !!manager && !busy;
  const canToggle = !!selected && selected.installed && selected.toggleable && !selected.loadError;
  const canSetup = !!selected && selected.installed && selected.enabled && selected.hasSetup;
  const canLog = !!selected && selected.installed && (selected.errorCount > 0 || !!selected.loadError);

  const handleKey = useCallback((key: string): boolean => {
    switch (key) {
      case "i": void installSelected(); return true;
      // Not u: that installs an app update whenever one is waiting.
      case "g": void updateSelected(); return true;
      case "x": void removeSelected(); return true;
      case "e": void toggleSelected(); return true;
      case "a": void choosePack(); return true;
      case "s": setupSelected(); return true;
      case "p": openSelected(); return true;
      case "d": openLog(); return true;
      case "r": refresh(true); return true;
      case "b": setShowBuiltin((value) => !value); return true;
      default: return false;
    }
  }, [choosePack, installSelected, openLog, openSelected, refresh, removeSelected, setShowBuiltin, setupSelected, toggleSelected, updateSelected]);

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

  // The search bar lives above the list, so `/` in a detail goes back to it.
  const handleDetailKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (searchFocused || !isPlainKeyboardEvent(event)) return;
    if (event.name === "/") {
      setDetailOpen(false);
      focusSearch();
      return true;
    }
    return handleKey((event.name ?? "").toLowerCase()) ? true : undefined;
  }, [focusSearch, handleKey, searchFocused, setDetailOpen]);
  useEffect(() => {
    if (detailOpen && searchFocused) blurSearch();
  }, [blurSearch, detailOpen, searchFocused]);

  const info = loadingErrorFooterInfo(status === "loading", status === "error" ? "catalog unavailable" : null);
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
  if (canUpdate) {
    hints.push(selected?.loadError
      ? { id: "update", key: "g", label: " reload", title: "Reload", onPress: () => { void updateSelected(); } }
      : { id: "update", key: "g", label: "et update", onPress: () => { void updateSelected(); } });
  }
  if (canToggle) hints.push({ id: "toggle", key: "e", label: selected?.enabled ? "disable" : "nable", title: selected?.enabled ? "Disable" : "Enable", onPress: () => { void toggleSelected(); } });
  if (canSetup) hints.push({ id: "setup", key: "s", label: "etup", onPress: setupSelected });
  if (canOpen) hints.push({ id: "open-pane", key: "p", label: "ane", onPress: openSelected });
  if (canLog) hints.push({ id: "log", key: "d", label: "ebug log", onPress: openLog });
  if (canRemove) hints.push({ id: "remove", key: "x", label: " remove", onPress: () => { void removeSelected(); } });
  if (host) hints.push({ id: "packs", key: "a", label: " packs", title: "Starter packs", onPress: () => { void choosePack(); } });
  // A built-in has no repository; its page on gloom.sh shows it at work.
  const seeItUrl = selected?.bundled ? registryPluginUrl(selected.id) : null;
  if (seeItUrl) hints.push({ id: "see-it", key: "o", label: " see it", title: "See it on gloom.sh", onPress: () => openUrl(seeItUrl) });

  useExternalLinkFooter({
    registrationId: PLUGIN_MARKETPLACE_PANE_ID,
    focused,
    url: selected && !selected.bundled && selected.repo ? registryPluginUrl(selected.id) : null,
    source: selected && !selected.bundled && selected.repo ? "gloom.sh" : null,
    info,
    hints,
  });

  const fit = useMemo(() => ({
    functions: Math.min(16, Math.max(9, ...visible.map((entry) => factsFor(entry).codes.join(" ").length))),
    status: Math.min(14, Math.max(7, ...visible.map((entry) => statusOf(entry).text.length))),
  }), [factsFor, visible]);
  const columns = useMemo(() => buildColumns(width, fit), [fit, width]);
  const packOptions = useMemo(() => [
    ...STARTER_PACKS.map((pack) => ({ value: pack.id, label: pack.name, short: PACK_SHORT_LABELS[pack.id], description: pack.tagline })),
    ...(currentPack ? [] : [{ value: CUSTOM_PACK, label: "Custom", description: "Your own set of plugins.", disabled: true }]),
  ], [currentPack]);
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
        detailScrollRef={selected?.bundled ? detailScrollRef : undefined}
        onBack={() => setDetailOpen(false)}
        detailContent={selected
          ? selected.bundled
            ? <BuiltinDetail entry={selected} width={width} facts={factsFor(selected)} scrollRef={detailScrollRef} />
            : <EntryDetail entry={selected} width={width} host={host} />
          : null}
        detailTitle={selected?.name}
        rootBefore={(
          <Box flexDirection="column" flexShrink={0}>
          <QueryBar
            width={width}
            filters={[{
              id: "pack",
              label: "Starter pack",
              inline: true,
              value: currentPack?.id ?? CUSTOM_PACK,
              options: packOptions,
              onChange: (value: string) => {
                const pack = STARTER_PACKS.find((candidate) => candidate.id === value);
                if (pack) void applyPack(pack);
              },
            }]}
          />
          <QueryBar
            width={width}
            search={{
              value: query,
              onChange: setQuery,
              placeholder: "name",
              focused: focused && !detailOpen,
              ...searchProps,
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
              { kind: "toggle" as const, id: "builtin", label: "Built in", value: showBuiltin, defaultValue: true, onChange: setShowBuiltin },
            ]}
          />
          </Box>
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
        onDetailKeyDown={handleDetailKeyDown}
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

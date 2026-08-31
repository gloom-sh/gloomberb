import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DataTableStackView,
  EmptyState,
  InputSearchBar,
  Spinner,
  Tabs,
  useExternalLinkFooter,
  type DataTableCell,
  type DataTableColumn,
  type PaneFooterSegment,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, TextAttributes, type InputRenderable } from "../../../ui";
import { formatCompact } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { formatRelativeAge } from "../../../utils/relative-time";
import { canInstallPlugins, getCurrentPluginTarget } from "../../current-target";
import { loadRegistry, registryPluginUrl } from "./feed";
import {
  collectCategories,
  filterEntries,
  mergeCatalog,
  sortEntries,
  unsupportedLabel,
  type MarketplaceEntry,
  type MarketplaceSection,
  type RegistryPlugin,
} from "./model";
import { getMarketplaceHost } from "./store";

export const PLUGIN_MARKETPLACE_PANE_ID = "plugin-marketplace";

type Column = DataTableColumn & { id: "name" | "tagline" | "stars" | "status" };

const SECTIONS: { label: string; value: MarketplaceSection }[] = [
  { label: "Installed", value: "installed" },
  { label: "Browse", value: "browse" },
];

function buildColumns(width: number): Column[] {
  const starsWidth = 6;
  const statusWidth = 14;
  const nameWidth = Math.min(26, Math.max(14, Math.floor(width * 0.24)));
  const taglineWidth = Math.max(16, width - nameWidth - starsWidth - statusWidth - 8);
  return [
    { id: "name", label: "PLUGIN", width: nameWidth, align: "left" },
    { id: "tagline", label: "DESCRIPTION", width: taglineWidth, align: "left" },
    { id: "stars", label: "STARS", width: starsWidth, align: "right" },
    { id: "status", label: "STATUS", width: statusWidth, align: "left" },
  ];
}

function statusOf(entry: MarketplaceEntry): { text: string; color: string } {
  if (entry.loadError) return { text: "failed", color: colors.negative };
  const unsupported = unsupportedLabel(entry);
  if (unsupported) return { text: unsupported.toLowerCase(), color: colors.warning };
  if (entry.bundled) return { text: "included", color: colors.textDim };
  if (entry.installed) {
    return entry.enabled
      ? { text: "enabled", color: colors.positive }
      : { text: "disabled", color: colors.textDim };
  }
  return { text: "available", color: colors.textBright };
}

function renderCell(entry: MarketplaceEntry, column: Column, rowState: { selected: boolean }): DataTableCell {
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
    case "stars":
      return {
        text: entry.bundled || entry.stars === 0 ? "—" : formatCompact(entry.stars),
        color: selected ?? colors.textDim,
      };
    case "status": {
      const status = statusOf(entry);
      return { text: status.text, color: rowState.selected ? colors.selectedText : status.color };
    }
  }
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Box flexDirection="row" height={1} gap={1}>
      <Text fg={colors.textDim}>{`${label}:`}</Text>
      <Text fg={colors.text}>{value}</Text>
    </Box>
  );
}

function EntryDetail({ entry, width }: { entry: MarketplaceEntry; width: number }) {
  const contributes: string[] = [];
  if (entry.contributes) {
    const { panes, capabilities, broker } = entry.contributes;
    if (panes.length > 0) contributes.push(`${panes.length} pane${panes.length === 1 ? "" : "s"}`);
    if (capabilities.length > 0) contributes.push(`${capabilities.length} data source${capabilities.length === 1 ? "" : "s"}`);
    if (broker) contributes.push("a broker integration");
  }

  return (
    <ScrollBox flexDirection="column" width={width} paddingLeft={1} paddingRight={1}>
      <Box flexDirection="row" gap={2} height={1}>
        <Text fg={colors.textDim}>{entry.tier}</Text>
        <Text fg={colors.textDim}>{entry.categories.join(", ")}</Text>
        {entry.installedVersion ? <Text fg={colors.textDim}>{`v${entry.installedVersion}`}</Text> : null}
        {!entry.bundled && entry.stars > 0 ? <Text fg={colors.textDim}>{`${entry.stars} stars`}</Text> : null}
      </Box>

      {entry.description ? (
        <Box paddingTop={1} flexDirection="column">
          <Text fg={colors.text}>{entry.description}</Text>
        </Box>
      ) : null}

      <Box paddingTop={1} flexDirection="column">
        {contributes.length > 0 ? <DetailRow label="Adds" value={contributes.join(", ")} /> : null}
        {/* Shown before install, because it is the one thing a user should weigh. */}
        <DetailRow
          label="Network"
          value={entry.hosts.length > 0 ? entry.hosts.join(", ") : "no third-party requests"}
        />
        {entry.repo ? <DetailRow label="Source" value={`github.com/${entry.repo}`} /> : null}
        {entry.loadError ? <DetailRow label="Error" value={entry.loadError} /> : null}
      </Box>

      {!entry.installed && !entry.bundled ? (
        <Box paddingTop={1} flexDirection="column">
          <Text fg={colors.textDim}>Install with</Text>
          <Text fg={colors.textBright}>{`gloomberb install ${entry.id}`}</Text>
        </Box>
      ) : null}
    </ScrollBox>
  );
}

export function PluginMarketplacePane({ focused, width, height }: PaneProps) {
  const [section, setSection] = useState<MarketplaceSection>("installed");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  // null keeps the curated order: featured first, then tier, then stars.
  const [sortColumn, setSortColumn] = useState<"name" | "stars" | null>(null);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchInputRef = useRef<InputRenderable | null>(null);

  const [registry, setRegistry] = useState<RegistryPlugin[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  // Bumped after a toggle so the installed list is re-read from the host.
  const [localRevision, setLocalRevision] = useState(0);

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

  const target = getCurrentPluginTarget();
  const entries = useMemo(() => {
    void localRevision;
    const installed = getMarketplaceHost()?.listInstalled() ?? [];
    return sortEntries(mergeCatalog({ registry, installed, target }));
  }, [registry, target, localRevision]);

  const rows = useMemo(() => {
    const filtered = filterEntries(entries, { section, query, category: null });
    if (sortColumn === "name") return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    if (sortColumn === "stars") return [...filtered].sort((a, b) => b.stars - a.stars);
    return filtered;
  }, [entries, query, section, sortColumn]);

  const selected = useMemo(
    () => rows.find((entry) => entry.id === selectedId) ?? rows[0] ?? null,
    [rows, selectedId],
  );

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((token) => token + 1);
  }, []);
  const blurSearch = useCallback(() => setSearchFocused(false), []);

  const toggleSelected = useCallback(() => {
    const host = getMarketplaceHost();
    if (!host || !selected || !selected.installed || !selected.toggleable) return;
    host.setPluginEnabled(selected.id, !selected.enabled);
    setLocalRevision((value) => value + 1);
  }, [selected]);

  useShortcut((event) => {
    if (!focused || searchFocused) return;
    const key = (event.name ?? event.key ?? "").toLowerCase();
    if (key === "r" && isPlainKey(event)) {
      event.preventDefault?.();
      refresh(true);
      return;
    }
    if (key === "e" && isPlainKey(event)) {
      event.preventDefault?.();
      toggleSelected();
      return;
    }
    if (key === "/" && isPlainKey(event)) {
      event.preventDefault?.();
      focusSearch();
    }
  });

  const info: PaneFooterSegment[] = [];
  if (status === "loading") info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
  if (status === "error") info.push({ id: "error", parts: [{ text: "catalog unavailable", tone: "warning" }] });
  if (stale) info.push({ id: "stale", parts: [{ text: "stale catalog", tone: "warning" }] });
  if (!canInstallPlugins() && section === "browse") {
    // Installing shells out to git and bun, which only the terminal build can do.
    info.push({ id: "install", parts: [{ text: "install from the terminal", tone: "muted" }] });
  }
  if (status === "ready" && fetchedAt && !stale) {
    info.push({ id: "updated", parts: [{ text: formatRelativeAge(fetchedAt), tone: "muted" }] });
  }

  useExternalLinkFooter({
    registrationId: PLUGIN_MARKETPLACE_PANE_ID,
    focused,
    url: selected ? registryPluginUrl(selected.id) : null,
    source: selected ? "gloom.sh" : null,
    info,
    hints: selected?.installed && selected.toggleable
      ? [{ id: "toggle", key: "e", label: selected.enabled ? "disable" : "nable", onPress: toggleSelected }]
      : [],
  });

  const columns = useMemo(() => buildColumns(width), [width]);

  const tabs = (
    <Tabs
      tabs={SECTIONS}
      activeValue={section}
      onSelect={(value) => {
        setSection(value as MarketplaceSection);
        setDetailOpen(false);
      }}
      focused={focused && !detailOpen}
      variant="underline"
      dense
    />
  );

  if (status === "loading" && entries.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Spinner />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs}
      <DataTableStackView<MarketplaceEntry, Column>
        focused={focused && !searchFocused}
        detailOpen={detailOpen && !!selected}
        onBack={() => setDetailOpen(false)}
        detailContent={selected ? <EntryDetail entry={selected} width={width} /> : null}
        detailTitle={selected?.name}
        rootBefore={(
          <InputSearchBar
            value={query}
            focused={focused && !detailOpen}
            active={searchFocused}
            width={width}
            focusToken={searchFocusToken}
            inputRef={searchInputRef}
            placeholder="name or category"
            debounceMs={80}
            onFocus={focusSearch}
            onBlur={blurSearch}
            onNavigateDown={blurSearch}
            onQueryChange={setQuery}
          />
        )}
        selection={{
          kind: "id",
          selectedId: selected?.id ?? null,
          getId: (entry) => entry.id,
          onChange: (id) => setSelectedId(typeof id === "string" ? id : null),
        }}
        onActivate={() => setDetailOpen(true)}
        rootWidth={width}
        rootHeight={Math.max(1, height - 1)}
        columns={columns}
        items={rows}
        getItemKey={(entry) => entry.id}
        sortColumnId={sortColumn}
        sortDirection={sortColumn === "name" ? "asc" : "desc"}
        onHeaderClick={(columnId) => {
          // Only these two columns have a meaningful order; the rest keep the
          // curated ranking rather than pretending to be sortable.
          if (columnId === "name" || columnId === "stars") {
            setSortColumn((current) => (current === columnId ? null : columnId));
          }
        }}
        renderCell={(entry, column, _index, rowState) => renderCell(entry, column, rowState)}
        emptyStateTitle={
          status === "error"
            ? "Plugin catalog unavailable."
            : section === "browse"
              ? "Everything in the catalog is installed."
              : "No plugins match."
        }
        emptyStateHint={status === "error" ? "Press r to retry." : undefined}
      />
    </Box>
  );
}

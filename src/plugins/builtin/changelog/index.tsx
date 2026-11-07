import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Box, TextAttributes, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { usePaneInstance } from "../../../state/app/context";
import {
  DataTableStackView,
  DataTableView,
  MarkdownText,
  PaneLinkMenu,
  PaneStatusBody,
  useExternalLinkFooter,
  type DataTableCell,
  type DataTableColumn,
} from "../../../components";
import { DetailReader } from "../../../components/reader/detail-reader";
import { DESKTOP_LINE_HEIGHT, READER_COLUMN_FONT, READER_MEASURE } from "../../../components/reader/reader-text";
import { loadingErrorFooterInfo, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { getReleaseSummaries } from "../../../api-client/release-summaries";
import { createTtlCache } from "../../../data/ttl-cache";
import {
  fetchChangelogReleases,
  fetchChangelogSummaries,
  type ChangelogRelease,
} from "../../../updater/github-releases";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { usePluginPaneState } from "../../runtime";
import { formatShortDate } from "../../../utils/datetime-format";
import { logFailure } from "../../../utils/log-failure";
import {
  DEFAULT_CHANGELOG_SORT,
  nextChangelogSortPreference,
  resolveSelectedReleaseIndex,
  sortChangelogReleases,
  type ChangelogColumnId,
  type ChangelogSortPreference,
} from "./model";
import {
  DEFAULT_CHANGELOG_VERSION_SORT,
  groupChangelogVersions,
  highlightsMarkdown,
  nextChangelogVersionSort,
  parseVersionSummaries,
  sortChangelogVersions,
  versionOfRelease,
  type ChangelogVersion,
  type ChangelogVersionColumnId,
} from "./versions";

/**
 * The releases read: one page of GitHub's list holds them beside the nightly
 * builds, so a load is one request unless nightlies crowd the page. The
 * oldest version, maybe cut short, is left out.
 */
const CHANGELOG_LIMIT = 80;
/** GitHub can hang or be blocked outright; the pane must still reach a verdict. */
const CHANGELOG_TIMEOUT_MS = 5_000;
const CHANGELOG_CACHE_TTL_MS = 10 * 60 * 1000;

interface ChangelogData {
  releases: ChangelogRelease[];
  /** CHANGELOG.md, or null when it is missing or could not be read. */
  summaries: string | null;
}

// Process-lifetime cache. Move it into the updater module if other
// surfaces start reading releases too.
const changelogCache = createTtlCache<ChangelogData>({ ttlMs: CHANGELOG_CACHE_TTL_MS });
const CHANGELOG = "changelog";

/** Every test reads its own answers, whichever file ran first. */
export function resetChangelogCacheForTests(): void {
  changelogCache.clear();
}

/**
 * CHANGELOG.md from Gloom Cloud, which reads GitHub with its own credentials,
 * else from GitHub itself; null when neither has it, and then each version
 * shows its updates' own highlights.
 */
async function readSummaries(signal: AbortSignal): Promise<string | null> {
  try {
    return await getReleaseSummaries(signal);
  } catch (error) {
    logFailure("changelog", "Read release summaries from Gloom Cloud failed")(error);
  }
  return fetchChangelogSummaries(signal).catch(logFailure("changelog", "Read CHANGELOG.md from GitHub failed", null));
}

type VersionColumn = DataTableColumn & { id: ChangelogVersionColumnId };
type ReleaseColumn = DataTableColumn & { id: ChangelogColumnId };
type LoadStatus = "loading" | "loaded" | "error";

const DATE_WIDTH = 12;

function buildVersionColumns(versions: ChangelogVersion[]): VersionColumn[] {
  const versionWidth = Math.min(Math.max(7, ...versions.map((version) => version.id.length)), 14);
  return [
    { id: "date", label: "Date", width: DATE_WIDTH, align: "left" },
    { id: "version", label: "Version", width: versionWidth, align: "left" },
    { id: "title", label: "Title", width: 18, align: "left", flexGrow: 1 },
    { id: "updates", label: "Updates", width: 7, align: "right" },
  ];
}

function buildReleaseColumns(releases: ChangelogRelease[]): ReleaseColumn[] {
  const versionWidth = Math.min(Math.max(7, ...releases.map((release) => release.version.length)), 14);
  return [
    { id: "date", label: "Date", width: DATE_WIDTH, align: "left" },
    { id: "version", label: "Version", width: versionWidth, align: "left" },
    { id: "title", label: "Title", width: 18, align: "left", flexGrow: 1 },
  ];
}

function detailTitle(version: string, title: string): string {
  return title === version ? version : `${version} ${title}`;
}

function renderVersionCell(version: ChangelogVersion, column: VersionColumn): DataTableCell {
  switch (column.id) {
    case "date":
      return { text: formatShortDate(version.lastPublishedAt, { fallback: "" }), color: colors.textDim };
    case "version":
      return { text: version.id, color: colors.textBright, attributes: TextAttributes.BOLD };
    case "title":
      return { text: version.title, color: colors.text };
    case "updates":
      return { text: String(version.releases.length), color: colors.textDim };
  }
}

function renderReleaseCell(release: ChangelogRelease, column: ReleaseColumn): DataTableCell {
  switch (column.id) {
    case "date":
      return { text: formatShortDate(release.publishedAt, { fallback: "" }), color: colors.textDim };
    case "version":
      return { text: release.version, color: colors.textBright, attributes: TextAttributes.BOLD };
    case "title":
      return { text: release.title, color: colors.text };
  }
}

function ReleaseNotes({
  release,
  width,
  scrollRef,
}: {
  release: ChangelogRelease;
  width: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
}) {
  // The stack title already carries the version.
  return (
    <PaneLinkMenu>
      <DetailReader
        ref={scrollRef}
        resetScrollKey={release.id}
        width={width}
        meta={[formatShortDate(release.publishedAt, { fallback: "" })]}
        body={release.body}
        bodyFormat="markdown"
      />
    </PaneLinkMenu>
  );
}

/** The pane's inset around the highlights, as a detail reader has: 12px above, 16px below. */
const HIGHLIGHTS_BOX_STYLE = { padding: "var(--gloom-space-md) var(--gloom-inset) var(--gloom-space-lg)" } as const;
/** The reader's type and measure; markdown lines take the reader's line height (the host sets Text line height from --cell-h). */
const HIGHLIGHTS_COLUMN_STYLE = {
  fontSize: READER_COLUMN_FONT,
  lineHeight: DESKTOP_LINE_HEIGHT,
  maxWidth: READER_MEASURE,
  "--cell-h": `${DESKTOP_LINE_HEIGHT}em`,
} as const;

/**
 * A version's highlights above its updates. The desktop and the web set them
 * in the reader's type at the reading measure, as the notes an update opens
 * are, lined up with the table's left edge; the terminal wraps them at `width`.
 */
function VersionHighlights({ markdown, width }: { markdown: string; width: number }) {
  const { nativePaneChrome } = useUiCapabilities();
  if (nativePaneChrome) {
    return (
      <Box flexDirection="column" width="100%" flexShrink={0} style={HIGHLIGHTS_BOX_STYLE} data-gloom-ui="changelog-highlights">
        <Box flexDirection="column" width="100%" style={HIGHLIGHTS_COLUMN_STYLE}>
          <MarkdownText text={markdown} />
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
      <MarkdownText text={markdown} lineWidth={Math.max(12, width - 2)} />
    </Box>
  );
}

/**
 * An open version: its highlights, each naming the updates it shipped in,
 * over the table of those updates. Enter opens an update's notes.
 */
function VersionDetail({
  version,
  focused,
  width,
  selectedReleaseId,
  onSelectRelease,
  onOpenRelease,
  sortPreference,
  onSortChange,
}: {
  version: ChangelogVersion;
  focused: boolean;
  width: number;
  selectedReleaseId: string | null;
  onSelectRelease: (id: string) => void;
  onOpenRelease: (id: string) => void;
  /** The pane's, so it outlasts an update's notes opened over the table. */
  sortPreference: ChangelogSortPreference;
  onSortChange: (update: (current: ChangelogSortPreference) => ChangelogSortPreference) => void;
}) {
  const releases = useMemo(
    () => sortChangelogReleases(version.releases, sortPreference),
    [version.releases, sortPreference],
  );
  const selectedIndex = resolveSelectedReleaseIndex(releases, selectedReleaseId);
  const columns = useMemo(() => buildReleaseColumns(version.releases), [version.releases]);
  const highlights = useMemo(() => highlightsMarkdown(version), [version]);

  return (
    <DataTableView<ChangelogRelease, ReleaseColumn>
      focused={focused}
      rootBefore={highlights ? <VersionHighlights markdown={highlights} width={width} /> : undefined}
      selection={{
        kind: "id",
        selectedId: releases[selectedIndex]?.id ?? null,
        getId: (release) => release.id,
        onChange: (id) => onSelectRelease(id),
      }}
      onActivate={(release) => onOpenRelease(release.id)}
      rootWidth={width}
      resetScrollKey={version.id}
      columns={columns}
      items={releases}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={(columnId) => onSortChange((current) => nextChangelogSortPreference(current, columnId))}
      getItemKey={(release) => release.id}
      renderCell={renderReleaseCell}
      selectedTextOverridesCellColor
      emptyStateTitle="No updates."
      showHorizontalScrollbar={false}
    />
  );
}

/**
 * The Changelog, as its own pane (CHG) and as ROADMAP's Changelog view: one
 * row per minor version, then a version's highlights and updates, then an
 * update's notes, one Back at a time.
 */
export function ChangelogPane({ focused, width, height }: PaneProps) {
  const paneInstance = usePaneInstance();
  const requestedVersion = paneInstance?.params?.version ?? null;
  const [data, setData] = useState<ChangelogData | null>(() => changelogCache.peek(CHANGELOG, { stale: true }) ?? null);
  // The mount effect starts the request immediately, so the first paint is a
  // spinner and never "No changelog entries found".
  const [status, setStatus] = useState<LoadStatus>(() => (changelogCache.peek(CHANGELOG, { stale: true }) ? "loaded" : "loading"));
  const [error, setError] = useState<string | null>(null);
  // The selected rows and what is open are pane state, so a reload or a
  // shared layout comes back to the same version and update.
  const [selectedVersionId, setSelectedVersionId] = usePluginPaneState<string | null>("selectedVersionId", null);
  const [openVersionId, setOpenVersionId] = usePluginPaneState<string | null>("openVersionId", null);
  const [selectedReleaseId, setSelectedReleaseId] = usePluginPaneState<string | null>("selectedReleaseId", null);
  const [openReleaseId, setOpenReleaseId] = usePluginPaneState<string | null>("openReleaseId", null);
  const [sortPreference, setSortPreference] = useState(DEFAULT_CHANGELOG_VERSION_SORT);
  const [updateSort, setUpdateSort] = useState<ChangelogSortPreference>(DEFAULT_CHANGELOG_SORT);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestedVersionOpenedRef = useRef(false);

  const load = useCallback(async (force = false) => {
    const fresh = force ? undefined : changelogCache.peek(CHANGELOG);
    if (fresh) {
      setData(fresh);
      setError(null);
      setStatus("loaded");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CHANGELOG_TIMEOUT_MS);
    setStatus("loading");
    setError(null);

    try {
      const [releases, summaries] = await Promise.all([
        fetchChangelogReleases(CHANGELOG_LIMIT, controller.signal),
        readSummaries(controller.signal),
      ]);
      const next = { releases, summaries };
      changelogCache.set(CHANGELOG, next);
      setData(next);
      setStatus("loaded");
    } catch (loadError) {
      // A newer load or an unmount owns the state now; a timeout does not.
      if (!timedOut && abortRef.current !== controller) return;
      setError(timedOut
        ? "GitHub did not answer in time"
        : loadError instanceof Error ? loadError.message : "Failed to load changelog");
      setStatus("error");
    } finally {
      clearTimeout(timer);
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [load]);

  const versions = useMemo(
    () => data
      ? groupChangelogVersions(data.releases, parseVersionSummaries(data.summaries), { cut: data.releases.length >= CHANGELOG_LIMIT })
      : [],
    [data],
  );
  const sortedVersions = useMemo(() => sortChangelogVersions(versions, sortPreference), [versions, sortPreference]);
  const activeSelectedVersionId = (sortedVersions.find((version) => version.id === selectedVersionId) ?? sortedVersions[0])?.id ?? null;

  useEffect(() => {
    if (activeSelectedVersionId !== selectedVersionId) {
      setSelectedVersionId(activeSelectedVersionId);
    }
  }, [activeSelectedVersionId, selectedVersionId]);

  const openRelease = useMemo(
    () => (openReleaseId ? data?.releases.find((release) => release.id === openReleaseId) ?? null : null),
    [data, openReleaseId],
  );
  // A layout saved with only an open release (before versions) opens its version too.
  const openVersion = useMemo(
    () => versions.find((version) => version.id === openVersionId) ?? versionOfRelease(versions, openReleaseId),
    [openReleaseId, openVersionId, versions],
  );

  useEffect(() => {
    if (!data) return;
    if (openReleaseId && (!openRelease || !openVersion?.releases.includes(openRelease))) setOpenReleaseId(null);
    if (openVersionId && !openVersion) setOpenVersionId(null);
  }, [data, openRelease, openReleaseId, openVersion, openVersionId]);

  // Opened via "what's new after update": straight to that release's notes, in its version.
  useEffect(() => {
    if (!requestedVersion || requestedVersionOpenedRef.current) return;
    const tag = requestedVersion.replace(/^v/, "");
    const match = data?.releases.find((release) => release.version.replace(/^v/, "") === tag);
    const version = match ? versionOfRelease(versions, match.id) : null;
    if (!match || !version) return;
    requestedVersionOpenedRef.current = true;
    setSelectedVersionId(version.id);
    setOpenVersionId(version.id);
    setSelectedReleaseId(match.id);
    setOpenReleaseId(match.id);
  }, [data, requestedVersion, versions]);

  usePaneRefreshKey(() => void load(true), { focused });

  const columns = useMemo(() => buildVersionColumns(versions), [versions]);

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextChangelogVersionSort(current, columnId));
  }, []);

  const openVersionRow = useCallback((version: ChangelogVersion) => {
    setOpenVersionId(version.id);
    // The version opens on its newest update, or on the one last read in it.
    if (!version.releases.some((release) => release.id === selectedReleaseId)) {
      setSelectedReleaseId(version.releases[0]?.id ?? null);
    }
  }, [selectedReleaseId]);

  const goBack = useCallback(() => {
    if (openRelease) {
      setOpenReleaseId(null);
      return;
    }
    setOpenReleaseId(null);
    setOpenVersionId(null);
  }, [openRelease]);

  const footerInfo = useMemo(
    () => loadingErrorFooterInfo(status === "loading", status === "error" ? "error" : null),
    [status],
  );

  // The stack title names the release, so the footer offers only [o]pen.
  useExternalLinkFooter({
    registrationId: "changelog",
    focused,
    url: openRelease?.url,
    info: footerInfo,
  });

  if (versions.length === 0 && (status === "loading" || status === "error")) {
    return (
      <PaneStatusBody
        loading={status === "loading"}
        error={status === "error" ? error ?? "unknown error" : null}
        subject="Changelog"
      />
    );
  }

  return (
    <DataTableStackView<ChangelogVersion, VersionColumn>
      focused={focused}
      detailOpen={!!openVersion}
      onBack={goBack}
      detailContent={openRelease ? (
        <ReleaseNotes release={openRelease} width={width} scrollRef={detailScrollRef} />
      ) : openVersion ? (
        <VersionDetail
          version={openVersion}
          focused={focused}
          width={width}
          selectedReleaseId={selectedReleaseId}
          onSelectRelease={setSelectedReleaseId}
          onOpenRelease={setOpenReleaseId}
          sortPreference={updateSort}
          onSortChange={setUpdateSort}
        />
      ) : (
        <Box flexGrow={1} />
      )}
      detailTitle={openRelease
        ? detailTitle(openRelease.version, openRelease.title)
        : openVersion ? detailTitle(openVersion.id, openVersion.title) : undefined}
      selection={{
        kind: "id",
        selectedId: activeSelectedVersionId,
        getId: (version) => version.id,
        onChange: (id) => setSelectedVersionId(id),
      }}
      onActivate={openVersionRow}
      detailScrollRef={openRelease ? detailScrollRef : undefined}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={sortedVersions}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={(version) => version.id}
      renderCell={renderVersionCell}
      selectedTextOverridesCellColor
      emptyStateTitle="No changelog entries."
      showHorizontalScrollbar={false}
    />
  );
}

export const changelogModule: PluginModule = {
  panes: [
    {
      id: "changelog",
      name: "Changelog",
      icon: "L",
      component: ChangelogPane,
      reportFreshness: { status: "not-a-feed", basis: "release notes", local: true },
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 32 },
    },
  ],

  paneTemplates: [
    {
      id: "changelog-pane",
      paneId: "changelog",
      label: "Changelog",
      description: "Browse version history and release notes.",
      keywords: ["changelog", "release", "releases", "version", "updates"],
      shortcut: { prefix: "CHG" },
      createInstance: (_context, options) => {
        const version = options?.values?.version;
        return version ? { params: { version } } : {};
      },
    },
  ],
};

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Box, ScrollBox, Text, TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import { useShortcut } from "../../../react/input";
import { usePaneInstance } from "../../../state/app/context";
import {
  DataTableStackView,
  Spinner,
  useExternalLinkFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type PaneFooterSegment,
  type PaneHint,
} from "../../../components";
import { MarkdownText } from "../../../components/markdown-text";
import { fetchChangelogReleases, type ChangelogRelease } from "../../../updater/github-releases";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { isPlainKey } from "../../../utils/keyboard";
import {
  DEFAULT_CHANGELOG_SORT,
  nextChangelogSortPreference,
  resolveSelectedReleaseIndex,
  sortChangelogReleases,
  type ChangelogColumnId,
} from "./model";

const CHANGELOG_LIMIT = 40;

type ChangelogColumn = DataTableColumn & { id: ChangelogColumnId };
type LoadStatus = "idle" | "loading" | "loaded" | "error";

function formatReleaseDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function buildColumns(width: number, releases: ChangelogRelease[]): ChangelogColumn[] {
  const dateWidth = 12;
  const versionWidth = Math.min(
    Math.max(7, ...releases.map((release) => release.version.length)),
    14,
  );
  const titleWidth = Math.max(
    18,
    width - (dateWidth + 1) - (versionWidth + 1) - 3,
  );

  return [
    { id: "date", label: "Date", width: dateWidth, align: "left" },
    { id: "version", label: "Version", width: versionWidth, align: "left" },
    { id: "title", label: "Title", width: titleWidth, align: "left" },
  ];
}

function releaseDetailTitle(release: ChangelogRelease): string {
  return release.title === release.version
    ? release.version
    : `${release.version} ${release.title}`;
}

function ChangelogDetail({
  release,
  width,
  scrollRef,
}: {
  release: ChangelogRelease;
  width: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
}) {
  const lineWidth = Math.max(width - 2, 12);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      minHeight={0}
      overflow="hidden"
      paddingX={1}
      paddingY={1}
    >
      <ScrollBox
        ref={scrollRef}
        flexGrow={1}
        flexBasis={0}
        minHeight={0}
        scrollY
        focusable={false}
      >
        <Box flexDirection="column" width={lineWidth}>
          <Text fg={colors.textMuted}>
            {`${formatReleaseDate(release.publishedAt)} | ${release.version}`}
          </Text>
          <Text>{" "}</Text>
          <MarkdownText text={release.body} lineWidth={lineWidth} />
        </Box>
      </ScrollBox>
    </Box>
  );
}

function ChangelogPane({ focused, width, height }: PaneProps) {
  const paneInstance = usePaneInstance();
  const requestedVersion = paneInstance?.params?.version ?? null;
  const [releases, setReleases] = useState<ChangelogRelease[]>([]);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
  const [sortPreference, setSortPreference] = useState(DEFAULT_CHANGELOG_SORT);
  const [openReleaseId, setOpenReleaseId] = useState<string | null>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestedVersionOpenedRef = useRef(false);

  const loadReleases = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");
    setError(null);

    try {
      const nextReleases = await fetchChangelogReleases(CHANGELOG_LIMIT, controller.signal);
      setReleases(nextReleases);
      setStatus("loaded");
    } catch (loadError) {
      if (
        loadError instanceof Error
        && loadError.name === "AbortError"
      ) {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : "Failed to load changelog");
      setStatus("error");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    void loadReleases();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [loadReleases]);

  const sortedReleases = useMemo(
    () => sortChangelogReleases(releases, sortPreference),
    [releases, sortPreference],
  );
  const activeSelectedIdx = resolveSelectedReleaseIndex(sortedReleases, selectedReleaseId);
  const activeSelectedReleaseId = sortedReleases[activeSelectedIdx]?.id ?? null;

  useEffect(() => {
    if (activeSelectedReleaseId !== selectedReleaseId) {
      setSelectedReleaseId(activeSelectedReleaseId);
    }
  }, [activeSelectedReleaseId, selectedReleaseId]);

  const openRelease = useMemo(
    () =>
      openReleaseId
        ? releases.find((release) => release.id === openReleaseId) ?? null
        : null,
    [openReleaseId, releases],
  );

  useEffect(() => {
    if (openReleaseId && !openRelease) {
      setOpenReleaseId(null);
    }
  }, [openRelease, openReleaseId]);

  // Opened via "what's new after update": jump straight to that release's notes.
  useEffect(() => {
    if (!requestedVersion || requestedVersionOpenedRef.current) return;
    const match = releases.find((release) => release.version.replace(/^v/, "") === requestedVersion.replace(/^v/, ""));
    if (!match) return;
    requestedVersionOpenedRef.current = true;
    setSelectedReleaseId(match.id);
    setOpenReleaseId(match.id);
  }, [releases, requestedVersion]);

  useEffect(() => {
    if (!openReleaseId) return;
    const scrollBox = detailScrollRef.current;
    if (scrollBox) scrollBox.scrollTop = 0;
  }, [openReleaseId]);

  useShortcut((event) => {
    if (!focused || !isPlainKey(event, "r")) return;
    event.stopPropagation?.();
    event.preventDefault?.();
    void loadReleases();
  });

  const columns = useMemo(() => buildColumns(width, releases), [releases, width]);

  const scrollDetailBy = useCallback((delta: number) => {
    const scrollBox = detailScrollRef.current;
    if (!scrollBox?.viewport) return;
    const maxScrollTop = Math.max(
      0,
      scrollBox.scrollHeight - scrollBox.viewport.height,
    );
    scrollBox.scrollTop = Math.max(
      0,
      Math.min(maxScrollTop, scrollBox.scrollTop + delta),
    );
  }, []);

  const handleDetailKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (isPlainKey(event, "j", "down")) {
      event.stopPropagation?.();
      event.preventDefault?.();
      scrollDetailBy(1);
      return true;
    }
    if (isPlainKey(event, "k", "up")) {
      event.stopPropagation?.();
      event.preventDefault?.();
      scrollDetailBy(-1);
      return true;
    }
    return false;
  }, [scrollDetailBy]);

  const renderCell = useCallback((
    release: ChangelogRelease,
    column: ChangelogColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "date":
        return {
          text: formatReleaseDate(release.publishedAt),
          color: selectedColor ?? colors.textDim,
        };
      case "version":
        return {
          text: release.version,
          color: selectedColor ?? colors.textBright,
          attributes: TextAttributes.BOLD,
        };
      case "title":
        return {
          text: release.title,
          color: selectedColor ?? colors.text,
        };
    }
  }, []);

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextChangelogSortPreference(current, columnId));
  }, []);

  const selectRelease = useCallback((release: ChangelogRelease) => {
    setSelectedReleaseId(release.id);
  }, []);

  const footerInfo = useMemo<PaneFooterSegment[]>(() => {
    const segments: PaneFooterSegment[] = [];
    if (status === "loading") {
      segments.push({
        id: "loading",
        parts: [{ text: "loading", tone: "muted" }],
      });
    }
    if (status === "error") {
      segments.push({
        id: "error",
        parts: [{ text: "error", tone: "warning" }],
      });
    }
    return segments;
  }, [status]);

  const footerHints = useMemo<PaneHint[]>(() => [{
    id: "refresh",
    key: "r",
    label: "efresh",
    onPress: () => {
      void loadReleases();
    },
  }], [loadReleases]);

  useExternalLinkFooter({
    registrationId: "changelog",
    focused,
    url: openRelease?.url,
    source: openRelease?.version,
    label: "release",
    info: footerInfo,
    hints: footerHints,
  });

  if (status === "loading" && releases.length === 0) {
    return <Spinner label="Loading changelog..." />;
  }

  if (status === "error" && releases.length === 0) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text fg={colors.textDim}>
          {`Failed to load changelog: ${error ?? "unknown error"}`}
        </Text>
      </Box>
    );
  }

  if (sortedReleases.length === 0) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text fg={colors.textDim}>No changelog entries found.</Text>
      </Box>
    );
  }

  return (
    <DataTableStackView<ChangelogRelease, ChangelogColumn>
      focused={focused}
      detailOpen={!!openRelease}
      onBack={() => setOpenReleaseId(null)}
      detailContent={openRelease ? (
        <ChangelogDetail
          release={openRelease}
          width={width}
          scrollRef={detailScrollRef}
        />
      ) : (
        <Box flexGrow={1} />
      )}
      detailTitle={openRelease ? releaseDetailTitle(openRelease) : undefined}
      selection={{
        kind: "id",
        selectedId: activeSelectedReleaseId,
        getId: (release) => release.id,
        onChange: (_id, release) => selectRelease(release),
      }}
      onActivate={(release) => setOpenReleaseId(release.id)}
      onDetailKeyDown={handleDetailKeyDown}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={sortedReleases}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={(release) => release.id}
      renderCell={renderCell}
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

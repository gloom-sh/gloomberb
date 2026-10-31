import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { apiClient } from "../../../api-client";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { RoadmapItem, RoadmapVote } from "../../../api-client/roadmap";
import {
  buildSectionedRows,
  DataTableStackView,
  EMPTY_TABLE_CELL,
  isSectionedItemRow,
  PaneFooterScope,
  renderSectionedRowHeader,
  usePaneTabs,
  usePaneStatusFooter,
  useRowNotes,
  type DataTableCell,
  type DataTableColumn,
  type PaneFooterSegment,
  type PaneHint,
  type SectionedRow,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { DetailReader, type DetailFact } from "../../../components/reader/detail-reader";
import { useAsyncResource, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import { formatShortDate } from "../../../utils/datetime-format";
import { ChangelogPane } from "../changelog";
import {
  isVotable,
  optimisticVote,
  ROADMAP_STATUS_LABELS,
  roadmapSections,
  voteFailure,
  votesText,
  withLocalVotes,
  type VoteFailure,
} from "./model";

/** The roadmap calls the pane makes; tests hand it their own. */
export type RoadmapClient = Pick<typeof apiClient, "getRoadmap" | "setRoadmapVote">;
export const RoadmapClientContext = createContext<RoadmapClient | null>(null);

type Row = SectionedRow<RoadmapItem>;
type ColumnId = "title" | "blurb" | "votes" | "shipped";
type Column = DataTableColumn & { id: ColumnId };

const rowKey = (row: Row) => row.key;
const itemKey = (item: RoadmapItem) => item.id;
const voteSignature = (item: RoadmapItem) => `${item.votes}:${item.voted}`;

/** Said once, quietly, to everyone who cannot vote: no upgrade pitch. */
const PRO_VOTES_SEGMENT: PaneFooterSegment = { id: "pro-votes", parts: [{ text: "Pro members vote", tone: "muted" }] };
const NO_SEGMENTS: PaneFooterSegment[] = [];

function shippedDate(item: RoadmapItem): string {
  return item.shippedAt ? formatShortDate(item.shippedAt, { fallback: "" }) : "";
}

/** `votesCell` is what the votes cell says: the count, or a vote's failure on that row. */
function buildColumns(items: readonly RoadmapItem[], width: number, votesCell: (item: RoadmapItem) => string): Column[] {
  const longest = Math.max(8, ...items.map((item) => item.title.length));
  const narrow = width < 64;
  const columns: Column[] = narrow
    ? [{ id: "title", label: "Feature", width: Math.min(longest, 24), flexGrow: 1, align: "left" }]
    : [
      { id: "title", label: "Feature", width: Math.min(longest, width >= 120 ? 36 : 26), align: "left" },
      { id: "blurb", label: "Summary", width: 16, flexGrow: 1, align: "left" },
    ];
  columns.push({ id: "votes", label: "Votes", width: Math.max(5, ...items.map((item) => votesCell(item).length)), align: "right" });
  if (!narrow && items.some((item) => item.shippedAt)) {
    columns.push({ id: "shipped", label: "Shipped", width: 12, align: "left" });
  }
  return columns;
}

function RoadmapDetail({ item, failure, width, scrollRef }: {
  item: RoadmapItem;
  failure: VoteFailure | null;
  width: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
}) {
  const colors = useThemeColors();
  // The stack title names the item; the facts and the blurb follow.
  const facts: DetailFact[] = [
    { label: "Status", value: ROADMAP_STATUS_LABELS[item.status] },
    { label: "Votes", value: item.voted ? `${item.votes}, yours included` : String(item.votes) },
    ...(item.shippedAt ? [{ label: "Shipped", value: shippedDate(item) }] : []),
    ...(failure ? [{ label: "Vote", value: failure.reason, color: colors.negative }] : []),
  ];
  return (
    <DetailReader
      ref={scrollRef}
      resetScrollKey={item.id}
      width={width}
      facts={facts}
      body={item.blurb || null}
      bodyFormat="text"
    />
  );
}

function RoadmapView({ focused, width, height }: PaneProps) {
  const colors = useThemeColors();
  const client = useContext(RoadmapClientContext) ?? apiClient;
  const access = usePlanAccess();
  // A sign-in, a sign-out or a new plan asks again: the votes and the right to
  // cast one are the account's. The new loader starts from no list, so the
  // last account's marks and vote hint go at once, not when (or if) the new
  // read lands. A refresh of the same session keeps its list.
  const sessionKey = JSON.stringify([apiClient.getCurrentUser()?.id ?? null, access.emailVerified, access.hasProAccess]);
  const loader = useCallback((_force: boolean) => client.getRoadmap(), [client, sessionKey]);
  const resource = useAsyncResource(loader);
  const sessionRef = useRef(sessionKey);
  sessionRef.current = sessionKey;
  const payload = resource.data;
  const canVote = payload?.canVote === true;

  // This session's votes, over the list until the next read replaces it.
  const [localVotes, setLocalVotes] = useState<Record<string, RoadmapVote>>({});
  useEffect(() => setLocalVotes({}), [resource.updatedAt]);
  const items = useMemo(() => withLocalVotes(payload, localVotes), [payload, localVotes]);
  const rows = useMemo(() => buildSectionedRows(roadmapSections(items), itemKey), [items]);
  const { noteFor, setNote, clearNotes } = useRowNotes<RoadmapItem, VoteFailure>(items, { key: itemKey, signature: voteSignature });
  // Another account's votes and refusals are not this one's.
  useEffect(() => {
    setLocalVotes({});
    clearNotes();
  }, [sessionKey, clearNotes]);

  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedItemId", null);
  const [openId, setOpenId] = usePluginPaneState<string | null>("openItemId", null);
  const selected = items.find((item) => item.id === selectedId) ?? rows.find(isSectionedItemRow)?.item ?? null;
  const open = openId ? items.find((item) => item.id === openId) ?? null : null;
  useEffect(() => {
    // An item that left the roadmap closes once the list that dropped it is in.
    if (openId && payload && !open) setOpenId(null);
  }, [open, openId, payload]);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);

  const inFlight = useRef(new Set<string>());
  const reload = resource.reload;
  const toggleVote = useCallback(async (item: RoadmapItem) => {
    if (!canVote || !isVotable(item) || inFlight.current.has(item.id)) return;
    const voted = !item.voted;
    const session = sessionRef.current;
    inFlight.current.add(item.id);
    setNote(item.id, null);
    setLocalVotes((current) => ({ ...current, [item.id]: optimisticVote(item, voted) }));
    try {
      const answer = await client.setRoadmapVote(item.id, voted);
      // An answer for the account that just left changes nothing on screen.
      if (sessionRef.current !== session) return;
      setLocalVotes((current) => ({ ...current, [item.id]: answer }));
    } catch (error) {
      if (sessionRef.current !== session) return;
      setLocalVotes((current) => ({ ...current, [item.id]: { id: item.id, votes: item.votes, voted: item.voted } }));
      setNote(item.id, voteFailure(error, voted));
    } finally {
      inFlight.current.delete(item.id);
    }
  }, [canVote, client, setNote]);

  usePaneRefreshKey(() => void reload(), { focused });

  const target = open ?? selected;
  const hints = useMemo<PaneHint[]>(() => (
    canVote && target && isVotable(target)
      ? [{ id: "vote", key: "v", label: target.voted ? " unvote" : "ote", title: target.voted ? "Take vote back" : "Vote", onPress: () => void toggleVote(target) }]
      : []
  ), [canVote, target, toggleVote]);
  usePaneStatusFooter({
    registrationId: "roadmap",
    // A failed refresh keeps the list; the failure goes in the footer.
    loading: resource.loading && !!payload,
    error: payload ? resource.error : null,
    info: !canVote && items.length > 0 ? [PRO_VOTES_SEGMENT] : NO_SEGMENTS,
    hints,
  });

  const columns = useMemo(
    () => buildColumns(items, width, (item) => noteFor(item)?.status ?? votesText(item)),
    [items, noteFor, width],
  );
  const renderCell = useCallback((row: Row, column: Column): DataTableCell => {
    if (!isSectionedItemRow(row)) return EMPTY_TABLE_CELL;
    const item = row.item;
    switch (column.id) {
      case "title":
        return { text: item.title, color: colors.textBright };
      case "blurb":
        return { text: item.blurb, color: colors.textDim };
      case "votes": {
        const failure = noteFor(item);
        if (failure) return { text: failure.status, color: colors.negative };
        return {
          text: votesText(item),
          value: item.votes,
          color: item.voted ? colors.positive : isVotable(item) ? colors.text : colors.textDim,
          ...(item.voted ? { attributes: TextAttributes.BOLD } : {}),
        };
      }
      case "shipped":
        return { text: shippedDate(item), color: colors.textDim };
    }
  }, [colors, noteFor]);

  return (
    <DataTableStackView<Row, Column>
      focused={focused}
      detailOpen={!!open}
      onBack={() => setOpenId(null)}
      detailTitle={open?.title}
      detailContent={open ? (
        <RoadmapDetail item={open} failure={noteFor(open)} width={width} scrollRef={detailScrollRef} />
      ) : <Box flexGrow={1} />}
      detailScrollRef={detailScrollRef}
      rootWidth={width}
      rootHeight={height}
      // A refresh keeps the list on screen; only a first read waits or fails in the body.
      status={payload ? undefined : {
        loading: resource.loading,
        error: resource.error,
        subject: "Roadmap",
        retry: { onRetry: reload, pending: resource.loading },
      }}
      emptyStateTitle="Nothing on the roadmap yet."
      columns={columns}
      items={rows}
      getItemKey={rowKey}
      isNavigable={isSectionedItemRow}
      renderSectionHeader={renderSectionedRowHeader}
      selection={{
        kind: "id",
        selectedId: selected?.id ?? null,
        getId: rowKey,
        onChange: (id) => setSelectedId(String(id)),
      }}
      onActivate={(row) => { if (isSectionedItemRow(row)) setOpenId(row.item.id); }}
      sortColumnId={null}
      sortDirection="asc"
      renderCell={renderCell}
      selectedTextOverridesCellColor
      showHorizontalScrollbar={false}
    />
  );
}

/** What is coming and what came: the roadmap, and the Changelog as CHG shows it. */
const VIEWS = [
  { value: "roadmap", label: "Roadmap" },
  { value: "changelog", label: "Changelog" },
] as const;
type ViewId = (typeof VIEWS)[number]["value"];
const VIEW_PANES: Record<ViewId, (props: PaneProps) => ReactNode> = {
  roadmap: RoadmapView,
  changelog: ChangelogPane,
};

export function RoadmapPane(props: PaneProps) {
  const [storedView, setView] = usePluginPaneState<string>("view", "roadmap");
  const view: ViewId = storedView === "changelog" ? "changelog" : "roadmap";
  // A view stays mounted once shown, so coming back to it keeps its place.
  const [mounted, setMounted] = useState<ReadonlySet<ViewId>>(() => new Set([view]));
  useEffect(() => {
    setMounted((current) => (current.has(view) ? current : new Set([...current, view])));
  }, [view]);
  const { strip, rows } = usePaneTabs({ tabs: [...VIEWS], activeValue: view, onSelect: setView, focused: props.focused, dense: true });
  const bodyHeight = Math.max(1, props.height - rows);

  return (
    <Box width={props.width} height={props.height} flexDirection="column" overflow="hidden">
      {strip}
      {VIEWS.map(({ value }) => {
        if (!mounted.has(value) && value !== view) return null;
        const View = VIEW_PANES[value];
        const active = value === view;
        return (
          <Box key={value} visible={active} height={bodyHeight} flexGrow={1} flexBasis={0} overflow="hidden" data-gloom-role="nested-pane-content">
            <PaneFooterScope active={active}>
              <View {...props} height={bodyHeight} focused={props.focused && active} />
            </PaneFooterScope>
          </Box>
        );
      })}
    </Box>
  );
}

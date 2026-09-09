import { useCallback, useEffect, useMemo, useState } from "react";
import type { CloudFilingEventPayload } from "../../../api-client";
import { apiClient } from "../../../api-client";
import {
  DataTableStackView,
  EmptyState, PaneStatusBody, Prose, SectionHeading, usePaneFooter,
  type DataTableCell,
  type DataTableKeyEvent,
  type PaneFooterSegment
} from "../../../components";
import { colors } from "../../../theme/colors";
import { Box, Text, useRendererHost } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { useBoundTicker } from "../shared/ticker-request";

export const FILING_EVENTS_PANE_ID = "filing-events";

interface EventColumn {
  id: string;
  label: string;
  width: number;
  align: "left" | "right";
}

function buildColumns(width: number): EventColumn[] {
  const dateWidth = 9;
  const itemsWidth = 11;
  const headlineWidth = Math.max(16, width - dateWidth - itemsWidth - 6);
  return [
    { id: "date", label: "FILED", width: dateWidth, align: "left" },
    { id: "items", label: "ITEMS", width: itemsWidth, align: "left" },
    {
      id: "headline",
      label: "WHAT HAPPENED",
      width: headlineWidth,
      align: "left",
    },
  ];
}

function formatFiled(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "2-digit",
  });
}

/** The items that say something; exhibits are on every filing. */
function itemCodes(event: CloudFilingEventPayload): string {
  return event.items.filter((code) => code !== "9.01").join(" ") || "—";
}

function renderCell(
  event: CloudFilingEventPayload,
  column: EventColumn,
): DataTableCell {
  switch (column.id) {
    case "date":
      return { text: formatFiled(event.filedAt), color: colors.textDim };
    case "items":
      return {
        text: itemCodes(event),
        color: event.material ? colors.warning : colors.textDim,
      };
    case "headline":
      return {
        text: event.headline ?? event.labels.join(", "),
        color: event.read ? colors.textBright : colors.text,
      };
    default:
      return { text: "" };
  }
}

export function FilingEventsPane({
  focused,
  width,
  height,
}: {
  focused: boolean;
  width: number;
  height: number;
}) {
  const { symbol } = useBoundTicker();
  const ticker = symbol ? symbol.toUpperCase() : null;
  const rendererHost = useRendererHost();

  const [events, setEvents] = useState<CloudFilingEventPayload[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setStatus("loading");
    apiClient
      .getFilingEvents(ticker, 100)
      .then((payload) => {
        if (cancelled) return;
        setEvents(payload.events);
        setStatus("loaded");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  const selected = useMemo(
    () => events.find((event) => event.id === selectedId) ?? null,
    [events, selectedId],
  );
  const columns = useMemo(() => buildColumns(width), [width]);

  const openFiling = useCallback(() => {
    if (selected?.docUrl) void rendererHost.openExternal(selected.docUrl);
  }, [rendererHost, selected]);

  const handleKey = useCallback(
    (event: DataTableKeyEvent) => {
      if (isPlainKey(event, "o")) {
        openFiling();
        return true;
      }
      return false;
    },
    [openFiling],
  );

  usePaneFooter(FILING_EVENTS_PANE_ID, () => {
    const info: PaneFooterSegment[] = [];
    if (status === "loading")
      info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    const material = events.filter((event) => event.material).length;
    if (events.length > 0) {
      info.push({
        id: "count",
        parts: [
          {
            text: `${events.length} filings, ${material} with news`,
            tone: "muted",
          },
        ],
      });
    }
    const hints = selected
      ? [{ id: "open", key: "o", label: "pen filing", onPress: openFiling }]
      : [];
    return { info, hints };
  }, [status, events, selected, openFiling]);

  if (!ticker)
    return <EmptyState title="Pick a ticker to see its 8-K filings." />;
  if (status === "loading" && events.length === 0) {
    return (
      <PaneStatusBody loading align="center" loadingLabel="Loading 8-Ks..." />
    );
  }
  if (status === "error")
    return (
      <PaneStatusBody error={error ?? "Could not load 8-K filings."} errorTitle="Could not load 8-K filings." />
    );
  if (status === "loaded" && events.length === 0) {
    return (
      <EmptyState
        title={`No 8-K on file for ${ticker} in the last six months.`}
      />
    );
  }

  const proseWidth = Math.min(Math.max(12, width - 2), 100);
  const detail = selected ? (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Prose
        text={[
          formatFiled(selected.filedAt),
          ...selected.labels.filter((label) => label !== "Exhibits"),
        ].join("  ·  ")}
        width={proseWidth}
        color={colors.textDim}
      />
      {selected.headline ? (
        <Box marginTop={1}>
          <Prose
            text={selected.headline}
            width={proseWidth}
            color={colors.textBright}
          />
        </Box>
      ) : null}
      {selected.summary ? (
        <Box flexDirection="column" marginTop={1}>
          {selected.summary.split("\n").map((point) => (
            <Prose
              key={point}
              text={point}
              width={proseWidth}
              color={colors.text}
              prefix="• "
            />
          ))}
        </Box>
      ) : null}
      {selected.people.length > 0 ? (
        <Box flexDirection="column">
          <SectionHeading marginTop={1} title="PEOPLE" />
          {selected.people.map((person) => (
            <Prose
              key={`${person.name}-${person.action}`}
              text={[
                person.role,
                person.action,
                person.effective ? `effective ${person.effective}` : null,
              ]
                .filter(Boolean)
                .join(", ")}
              width={proseWidth}
              color={colors.textDim}
              prefix={`${person.name}  `}
              prefixColor={colors.textBright}
            />
          ))}
        </Box>
      ) : null}
      {!selected.read ? (
        <Box marginTop={1}>
          <Text fg={colors.textDim}>
            Routine filing; the headline is the item label. Press o to read it.
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text fg={colors.textDim}>
            Read from the filing by a model; names checked against the text.
            Press o to open it.
          </Text>
        </Box>
      )}
    </Box>
  ) : null;

  return (
    <DataTableStackView<CloudFilingEventPayload, EventColumn>
      focused={focused}
      detailOpen={detailOpen && !!selected}
      onBack={() => setDetailOpen(false)}
      detailContent={detail}
      detailTitle={
        selected
          ? `${formatFiled(selected.filedAt)}  ${itemCodes(selected)}`
          : undefined
      }
      onRootKeyDown={handleKey}
      onDetailKeyDown={handleKey}
      selection={{
        kind: "id",
        selectedId,
        getId: (event) => event.id,
        onChange: setSelectedId,
      }}
      onActivate={() => setDetailOpen(true)}
      rootWidth={width}
      rootHeight={Math.max(2, height)}
      columns={columns}
      items={events}
      sortColumnId="date"
      sortDirection="desc"
      onHeaderClick={() => {}}
      getItemKey={(event) => event.id}
      renderCell={renderCell}
      emptyStateTitle="No filings."
    />
  );
}

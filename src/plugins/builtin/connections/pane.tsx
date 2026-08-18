import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, ScrollBox, Text, TextAttributes } from "../../../ui";
import {
  DataTableStackView,
  type DataTableCell,
  type DataTableColumn,
  usePaneFooter,
} from "../../../components";
import { useConnectionHealth } from "../../runtime";
import { useShortcut } from "../../../react/input";
import type { PaneProps } from "../../../types/plugin";
import type {
  ConnectionHealthState,
  ConnectionHealthStatus,
} from "../../../core/connection-health";
import { colors } from "../../../theme/colors";
import { formatRelativeAge } from "../../../utils/relative-time";
import { truncateToDisplayWidth } from "../../../utils/format";

interface ConnectionColumn extends DataTableColumn {
  id: "service" | "status" | "request" | "latency" | "last";
}

const SORT_COLUMNS: ConnectionColumn["id"][] = ["status", "service", "request", "latency", "last"];

const STATUS_ORDER: Record<ConnectionHealthStatus, number> = {
  error: 0,
  disconnected: 1,
  connecting: 2,
  connected: 3,
  idle: 4,
};

function statusLabel(status: ConnectionHealthStatus): string {
  if (status === "connected") return "Connected";
  if (status === "connecting") return "Connecting";
  if (status === "disconnected") return "Disconnected";
  if (status === "error") return "Error";
  return "Idle";
}

function statusColor(status: ConnectionHealthStatus): string {
  if (status === "connected") return colors.positive;
  if (status === "connecting") return colors.warning;
  if (status === "disconnected" || status === "error") return colors.negative;
  return colors.textMuted;
}

function formatLatency(latencyMs: number | null): string {
  if (latencyMs == null) return "-";
  return latencyMs < 1000 ? `${Math.round(latencyMs)}ms` : `${(latencyMs / 1000).toFixed(1)}s`;
}

function columnsForWidth(width: number): ConnectionColumn[] {
  const statusWidth = 13;
  const latencyWidth = 8;
  const lastWidth = 9;
  const requestWidth = width >= 72 ? 18 : 0;
  const serviceWidth = Math.max(16, width - statusWidth - latencyWidth - lastWidth - requestWidth - 4);
  return [
    { id: "service", label: "SERVICE", width: serviceWidth, align: "left" },
    { id: "status", label: "STATUS", width: statusWidth, align: "left" },
    ...(requestWidth > 0 ? [{ id: "request", label: "REQUEST", width: requestWidth, align: "left" } as ConnectionColumn] : []),
    { id: "latency", label: "LATENCY", width: latencyWidth, align: "right" },
    { id: "last", label: "LAST", width: lastWidth, align: "right" },
  ];
}

function DetailLine({ label, value, color = colors.text }: { label: string; value: string; color?: string }) {
  return (
    <Box height={1} flexDirection="row">
      <Box width={16}><Text fg={colors.textDim}>{label}</Text></Box>
      <Text fg={color}>{value}</Text>
    </Box>
  );
}

function ConnectionDetail({ source, width, now }: { source: ConnectionHealthState; width: number; now: number }) {
  const lineWidth = Math.max(24, width - 2);
  return (
    <ScrollBox scrollY focusable={false} flexGrow={1} paddingX={1}>
      <Box flexDirection="column" width={lineWidth}>
        <DetailLine label="Status" value={statusLabel(source.status)} color={statusColor(source.status)} />
        <DetailLine label="Type" value={source.kind} color={colors.textDim} />
        {source.ownerId ? <DetailLine label="Owner" value={source.ownerId} color={colors.textDim} /> : null}
        {source.socketState ? <DetailLine label="Socket" value={source.socketState} color={statusColor(source.status)} /> : null}
        {source.lastTransitionAt ? (
          <DetailLine label="Transition" value={formatRelativeAge(source.lastTransitionAt, now)} color={colors.textMuted} />
        ) : null}
        <DetailLine label="Last request" value={source.lastRequestAt ? formatRelativeAge(source.lastRequestAt, now) : "never"} color={colors.textMuted} />
        <DetailLine label="Operation" value={source.lastOperation ?? "-"} color={colors.textDim} />
        <DetailLine label="Latency" value={formatLatency(source.lastLatencyMs)} color={colors.textMuted} />
        {source.currentDetail ? (
          <DetailLine label="Detail" value={truncateToDisplayWidth(source.currentDetail, Math.max(8, lineWidth - 16))} color={source.status === "error" ? colors.negative : colors.textDim} />
        ) : null}
        {source.lastSuccess ? (
          <DetailLine
            label="Last success"
            value={`${formatRelativeAge(source.lastSuccess.at, now)} · ${formatLatency(source.lastSuccess.latencyMs)} · ${source.lastSuccess.operation}`}
            color={colors.positive}
          />
        ) : null}
        {source.lastError ? (
          <DetailLine
            label="Last error"
            value={`${formatRelativeAge(source.lastError.at, now)} · ${source.lastError.error ?? source.lastError.operation}`}
            color={colors.negative}
          />
        ) : null}
        {source.recentRequests.length > 0 ? (
          <>
            <Box height={1} />
            <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>Recent requests</Text>
            {source.recentRequests.slice(0, 8).map((request, index) => (
              <Box key={`${request.at}:${index}`} height={1} flexDirection="row">
                <Box width={7}><Text fg={request.success ? colors.positive : colors.negative}>{request.success ? "ok" : "error"}</Text></Box>
                <Box width={9}><Text fg={colors.textMuted}>{formatLatency(request.latencyMs)}</Text></Box>
                <Box width={10}><Text fg={colors.textMuted}>{formatRelativeAge(request.at, now)}</Text></Box>
                <Text fg={colors.textDim}>{truncateToDisplayWidth(request.error ?? request.operation, Math.max(8, lineWidth - 26))}</Text>
              </Box>
            ))}
          </>
        ) : null}
      </Box>
    </ScrollBox>
  );
}

export function ConnectionsPane({ focused, width, height }: PaneProps) {
  const health = useConnectionHealth();
  const [snapshot, setSnapshot] = useState(() => health.getSnapshot());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [sort, setSort] = useState<{ columnId: ConnectionColumn["id"]; direction: "asc" | "desc" }>({
    columnId: "status",
    direction: "asc",
  });
  const [now, setNow] = useState(Date.now());

  useEffect(() => health.subscribe(() => setSnapshot(health.getSnapshot())), [health]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const sources = useMemo(() => [...snapshot.sources].sort((left, right) => {
    let comparison = 0;
    if (sort.columnId === "status") comparison = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
    else if (sort.columnId === "service") comparison = left.name.localeCompare(right.name);
    else if (sort.columnId === "request") comparison = (left.lastOperation ?? "").localeCompare(right.lastOperation ?? "");
    else if (sort.columnId === "latency") comparison = (left.lastLatencyMs ?? Number.POSITIVE_INFINITY) - (right.lastLatencyMs ?? Number.POSITIVE_INFINITY);
    else comparison = (left.lastRequestAt ?? 0) - (right.lastRequestAt ?? 0);
    return (sort.direction === "asc" ? comparison : -comparison)
      || (left.priority ?? 1000) - (right.priority ?? 1000)
      || left.name.localeCompare(right.name);
  }), [snapshot, sort]);
  const selected = sources.find((source) => source.id === selectedId) ?? sources[0] ?? null;
  const issues = sources.filter((source) => source.status === "error" || source.status === "disconnected").length;
  const connecting = sources.filter((source) => source.status === "connecting").length;

  useEffect(() => {
    if (!selectedId && sources[0]) setSelectedId(sources[0].id);
    if (selectedId && !sources.some((source) => source.id === selectedId)) {
      setSelectedId(sources[0]?.id ?? null);
      setDetailOpen(false);
    }
  }, [selectedId, sources]);

  const cycleSort = useCallback(() => {
    setSort((current) => {
      const currentIndex = SORT_COLUMNS.indexOf(current.columnId);
      return current.direction === "asc"
        ? { ...current, direction: "desc" }
        : { columnId: SORT_COLUMNS[(currentIndex + 1) % SORT_COLUMNS.length]!, direction: "asc" };
    });
  }, []);

  useShortcut((event) => {
    if (!focused || detailOpen || event.name !== "s") return;
    event.stopPropagation();
    cycleSort();
  });

  usePaneFooter("connections", () => ({
    info: [
      ...(issues > 0 ? [{ id: "issues", parts: [{ text: `${issues} issue${issues === 1 ? "" : "s"}`, tone: "warning" as const }] }] : []),
      ...(connecting > 0 ? [{ id: "connecting", parts: [{ text: `${connecting} connecting`, tone: "muted" as const }] }] : []),
    ],
    hints: [{ id: "sort", key: "s", label: "ort", onPress: cycleSort }],
  }), [connecting, cycleSort, issues]);

  const renderCell = useCallback((source: ConnectionHealthState, column: ConnectionColumn): DataTableCell => {
    if (column.id === "service") return { text: truncateToDisplayWidth(source.name, column.width), color: colors.text };
    if (column.id === "status") return { text: statusLabel(source.status), color: statusColor(source.status) };
    if (column.id === "request") return { text: truncateToDisplayWidth(source.lastOperation ?? "-", column.width), color: colors.textDim };
    if (column.id === "latency") return { text: formatLatency(source.lastLatencyMs), color: source.status === "error" ? colors.negative : colors.textMuted };
    return { text: source.lastRequestAt ? formatRelativeAge(source.lastRequestAt, now) : "-", color: colors.textMuted };
  }, [now]);

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <DataTableStackView<ConnectionHealthState, ConnectionColumn>
        focused={focused}
        detailOpen={detailOpen && !!selected}
        onBack={() => setDetailOpen(false)}
        detailTitle={selected?.name}
        detailContent={selected ? <ConnectionDetail source={selected} width={width} now={now} /> : <Box />}
        rootWidth={width}
        rootHeight={height}
        selection={{
          kind: "id",
          selectedId: selected?.id ?? null,
          getId: (source) => source.id,
          onChange: (id) => setSelectedId(id),
        }}
        onActivate={(source) => {
          setSelectedId(source.id);
          setDetailOpen(true);
        }}
        columns={columnsForWidth(width)}
        items={sources}
        sortColumnId={sort.columnId}
        sortDirection={sort.direction}
        onHeaderClick={(columnId) => {
          setSort((current) => current.columnId === columnId
            ? { ...current, direction: current.direction === "asc" ? "desc" : "asc" }
            : { columnId: columnId as ConnectionColumn["id"], direction: "asc" });
        }}
        getItemKey={(source) => source.id}
        renderCell={renderCell}
        emptyStateTitle="No connection activity yet."
        emptyStateHint="Sources appear when providers and services register."
        showHorizontalScrollbar={false}
      />
    </Box>
  );
}

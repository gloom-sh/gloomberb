import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CloudThesis, ThesisSignal } from "../../../../api-client";
import { Badge, ListView, openUrl, usePaneFooter, type ListViewItem, type PaneHint } from "../../../../components";
import { useShortcut } from "../../../../react/input";
import { colors } from "../../../../theme/colors";
import { Box, Text, TextAttributes } from "../../../../ui";
import { useDialog } from "../../../../ui/dialog";
import { displayWidth, truncateToDisplayWidth } from "../../../../utils/format";
import { isPlainKey } from "../../../../utils/keyboard";
import { usePluginAppActions } from "../../../runtime";
import { useCloudUpgradeAction } from "../../shared/cloud-upgrade";
import { usePlanAccess } from "../../shared/plan-access";
import { teamStore } from "../team/store";
import * as flows from "./flows";
import {
  catalystState,
  daysSince,
  describeDays,
  daysUntil,
  healthLabel,
  healthTone,
  latestReviewSummary,
  metricLabel,
  metricUnit,
  nextPillarStatus,
  openSignals,
  pillarGlyph,
  reviewDue,
  signalTargetText,
  verdictTone,
} from "./model";
import { promptChoice } from "./prompts";
import { thesisStore } from "./store";

type Row =
  | { kind: "heading"; id: string; label: string; section: Section }
  | { kind: "pillar"; id: string; section: Section; item: CloudThesis["document"]["pillars"][number] }
  | { kind: "kill"; id: string; section: Section; item: CloudThesis["document"]["killConditions"][number] }
  | { kind: "catalyst"; id: string; section: Section; item: CloudThesis["document"]["catalysts"][number] }
  | { kind: "signal"; id: string; section: Section; item: ThesisSignal }
  | { kind: "text"; id: string; section: Section; text: string; dim?: boolean }
  | { kind: "empty"; id: string; section: Section; text: string };

type Section = "pillars" | "kills" | "catalysts" | "signals" | "review";

const SECTION_LABEL: Record<Section, string> = {
  pillars: "Pillars",
  kills: "Kill conditions",
  catalysts: "Catalysts",
  signals: "Signals",
  review: "Latest review",
};

/** A bound the way an analyst would say it: "≥ 70%", "≥ 120B", "≤ 2.5x". */
function formatBound(metric: { key: string; op: string; value: number; unit?: string }): string {
  const unit = metric.unit ?? metricUnit(metric.key);
  const magnitude = Math.abs(metric.value);
  const value = magnitude >= 1e9
    ? `${(metric.value / 1e9).toFixed(magnitude >= 1e11 ? 0 : 1).replace(/\.0$/, "")}B`
    : magnitude >= 1e6
      ? `${(metric.value / 1e6).toFixed(magnitude >= 1e8 ? 0 : 1).replace(/\.0$/, "")}M`
      : String(metric.value);
  return `${metric.op === ">=" ? "≥" : "≤"} ${value}${unit}`;
}

function relative(iso: string | null | undefined): string {
  const days = daysSince(iso ?? null);
  if (days === null) return "";
  if (days === 0) return "today";
  return `${days}d ago`;
}

function wrap(text: string, width: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (displayWidth(candidate) <= width) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = truncateToDisplayWidth(`${lines[maxLines - 1]}…`, width);
  }
  return lines;
}

function buildRows(thesis: CloudThesis, signals: readonly ThesisSignal[], width: number): Row[] {
  const document = thesis.document;
  const rows: Row[] = [];
  const open = openSignals(signals);
  rows.push({ kind: "heading", id: "h:signals", label: `${SECTION_LABEL.signals}${open.length ? ` (${open.length} open)` : ""}`, section: "signals" });
  if (open.length === 0) {
    rows.push({ kind: "empty", id: "e:signals", section: "signals", text: "Nothing to rule on." });
  }
  for (const signal of open) rows.push({ kind: "signal", id: `s:${signal.id}`, section: "signals", item: signal });

  rows.push({ kind: "heading", id: "h:pillars", label: SECTION_LABEL.pillars, section: "pillars" });
  if (document.pillars.length === 0) rows.push({ kind: "empty", id: "e:pillars", section: "pillars", text: "No pillars yet. Press n to add what must stay true." });
  for (const pillar of document.pillars) rows.push({ kind: "pillar", id: `p:${pillar.id}`, section: "pillars", item: pillar });

  rows.push({ kind: "heading", id: "h:kills", label: SECTION_LABEL.kills, section: "kills" });
  if (document.killConditions.length === 0) rows.push({ kind: "empty", id: "e:kills", section: "kills", text: "No kill conditions. What would make you sell?" });
  for (const condition of document.killConditions) rows.push({ kind: "kill", id: `k:${condition.id}`, section: "kills", item: condition });

  rows.push({ kind: "heading", id: "h:catalysts", label: SECTION_LABEL.catalysts, section: "catalysts" });
  if (document.catalysts.length === 0) rows.push({ kind: "empty", id: "e:catalysts", section: "catalysts", text: "No dated expectations." });
  for (const catalyst of document.catalysts) rows.push({ kind: "catalyst", id: `c:${catalyst.id}`, section: "catalysts", item: catalyst });

  const review = latestReviewSummary(signals);
  if (review) {
    rows.push({ kind: "heading", id: "h:review", label: `${SECTION_LABEL.review} (${relative(review.createdAt)})`, section: "review" });
    for (const [index, line] of wrap(review.reason, width - 3, 6).entries()) {
      rows.push({ kind: "text", id: `r:${index}`, section: "review", text: line, dim: true });
    }
  }
  return rows;
}

function isSelectable(row: Row): boolean {
  return row.kind === "pillar" || row.kind === "kill" || row.kind === "catalyst" || row.kind === "signal";
}

function twoColumn(left: string, right: string, width: number): { left: string; right: string } {
  const rightWidth = displayWidth(right);
  const leftWidth = Math.max(8, width - rightWidth - 1);
  return { left: truncateToDisplayWidth(left, leftWidth), right };
}

export interface ThesisDetailProps {
  thesis: CloudThesis;
  width: number;
  height: number;
  focused: boolean;
  /** Footer registration id, so a tab and a pane can both host the detail. */
  footerId: string;
  onDeleted?: () => void;
}

export function ThesisDetail({ thesis, width, height, focused, footerId, onDeleted }: ThesisDetailProps) {
  const dialog = useDialog();
  const { notify } = usePluginAppActions();
  const plan = usePlanAccess();
  const openUpgrade = useCloudUpgradeAction();
  const [signals, setSignals] = useState<ThesisSignal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const ctx = useMemo<flows.FlowContext>(() => ({ dialog, notify, hasProAccess: plan.hasProAccess, openUpgrade }), [dialog, notify, openUpgrade, plan.hasProAccess]);

  const reloadSignals = useCallback(async () => {
    const current = ++generation.current;
    const detail = await thesisStore.loadDetail(thesis.id).catch(() => null);
    if (generation.current !== current || !detail) return;
    setSignals(detail.signals);
  }, [thesis.id]);

  useEffect(() => {
    void reloadSignals();
  }, [reloadSignals, thesis.revision, thesis.openSignals]);

  useEffect(() => thesisStore.onSignals((id) => {
    if (id === thesis.id) void reloadSignals();
  }), [reloadSignals, thesis.id]);

  // Two cells of padding plus the list scrollbar column.
  const contentWidth = Math.max(20, width - 3);
  const rows = useMemo(() => buildRows(thesis, signals, contentWidth), [contentWidth, signals, thesis]);
  const selectedIndex = Math.max(0, rows.findIndex((row) => row.id === selectedId));
  const selectedRow = rows[selectedIndex] ?? null;

  // Until the person moves, the cursor follows the most urgent row, so the
  // open signal that arrives a beat after the document is what is selected.
  const userPicked = useRef(false);
  useEffect(() => {
    userPicked.current = false;
  }, [thesis.id]);
  useEffect(() => {
    const first = rows.find(isSelectable);
    if (!userPicked.current) {
      if (first && first.id !== selectedId) setSelectedId(first.id);
      return;
    }
    if (selectedId && rows.some((row) => row.id === selectedId && isSelectable(row))) return;
    setSelectedId(first?.id ?? null);
  }, [rows, selectedId]);

  const move = useCallback((delta: number) => {
    userPicked.current = true;
    let index = selectedIndex;
    for (let step = 0; step < rows.length; step += 1) {
      index += delta;
      if (index < 0 || index >= rows.length) return;
      if (isSelectable(rows[index]!)) {
        setSelectedId(rows[index]!.id);
        return;
      }
    }
  }, [rows, selectedIndex]);

  const run = useCallback(async (task: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const current = () => thesisStore.get(thesis.id) ?? thesis;
  const sectionOf = selectedRow?.section ?? "pillars";

  const addToSection = useCallback((section: Section) => run(async () => {
    if (section === "kills") await flows.addKillCondition(ctx, current());
    else if (section === "catalysts") await flows.addCatalyst(ctx, current());
    else if (section === "pillars") await flows.addPillar(ctx, current());
    else {
      const which = await promptChoice(ctx.dialog, "Add", [
        { id: "pillars", label: "Pillar", description: "A claim that must stay true." },
        { id: "kills", label: "Kill condition", description: "What would make you sell." },
        { id: "catalysts", label: "Catalyst", description: "A dated expectation." },
      ]);
      if (which === "pillars") await flows.addPillar(ctx, current());
      if (which === "kills") await flows.addKillCondition(ctx, current());
      if (which === "catalysts") await flows.addCatalyst(ctx, current());
    }
  }), [ctx, run]);

  const activate = useCallback(() => run(async () => {
    const row = selectedRow;
    if (!row) return;
    if (row.kind === "pillar") await flows.editPillar(ctx, current(), row.item);
    else if (row.kind === "kill") await flows.editKillCondition(ctx, current(), row.item);
    else if (row.kind === "catalyst") await flows.editCatalyst(ctx, current(), row.item);
    else if (row.kind === "signal") {
      await flows.resolveSignal(ctx, current(), row.item);
      await reloadSignals();
    }
  }), [ctx, reloadSignals, run, selectedRow]);

  const cycleStatus = useCallback(() => run(async () => {
    const row = selectedRow;
    if (!row) return;
    if (row.kind === "pillar") await flows.setPillarStatus(ctx, current(), row.item, nextPillarStatus(row.item.status));
    else if (row.kind === "kill") await flows.toggleKillCondition(ctx, current(), row.item);
    else if (row.kind === "catalyst") {
      const next = row.item.status === "pending" ? "hit" : row.item.status === "hit" ? "missed" : "pending";
      await flows.setCatalystStatus(ctx, current(), row.item, next);
    }
  }), [ctx, run, selectedRow]);

  const remove = useCallback(() => run(async () => {
    const row = selectedRow;
    if (!row || (row.kind !== "pillar" && row.kind !== "kill" && row.kind !== "catalyst")) return;
    await flows.removeItem(ctx, current(), { kind: row.kind, item: row.item } as flows.DocumentItem);
  }), [ctx, run, selectedRow]);

  const challengeSelected = useCallback(() => run(async () => {
    const row = selectedRow;
    const target = row && (row.kind === "pillar" || row.kind === "kill" || row.kind === "catalyst")
      ? ({ kind: row.kind, item: row.item } as flows.DocumentItem)
      : null;
    if (await flows.challenge(ctx, current(), target)) await reloadSignals();
  }), [ctx, reloadSignals, run, selectedRow]);

  // The review lands over realtime; onSignals below refetches when it does.
  const review = useCallback(() => run(() => flows.runReview(ctx, current())), [ctx, run]);

  const editMenu = useCallback(() => run(async () => {
    const choice = await promptChoice(ctx.dialog, thesis.title, [
      { id: "meta", label: "Edit title, summary, conviction…" },
      { id: "instrument", label: "Add an instrument" },
      { id: "evidence", label: "Add an evidence ticker" },
      { id: "remove-symbol", label: "Remove a symbol" },
      { id: "reviewed", label: "Mark as reviewed", description: "You re-read it and it still holds." },
      ...(thesis.status !== "closed" ? [{ id: "close", label: "Close with a post-mortem" }] : [{ id: "reopen", label: "Reopen" }]),
      { id: "delete", label: "Delete" },
    ]);
    if (!choice) return;
    if (choice === "meta") await flows.editMeta(ctx, current());
    else if (choice === "instrument") await flows.addInstrument(ctx, current(), "instrument");
    else if (choice === "evidence") await flows.addInstrument(ctx, current(), "evidence");
    else if (choice === "remove-symbol") await flows.removeSymbol(ctx, current());
    else if (choice === "reviewed") await flows.markReviewed(ctx, current());
    else if (choice === "close") await flows.closeThesis(ctx, current());
    else if (choice === "reopen") await flows.savePatch(ctx, current(), { status: "active" });
    else if (choice === "delete" && (await flows.deleteThesis(ctx, current()))) onDeleted?.();
  }), [ctx, onDeleted, run, thesis.status, thesis.title]);

  const openSource = useCallback(() => {
    const row = selectedRow;
    if (row?.kind === "signal" && row.item.source?.url) openUrl(row.item.source.url);
  }, [selectedRow]);

  useShortcut((event) => {
    if (!focused || busy) return;
    if (isPlainKey(event, "j", "down")) move(1);
    else if (isPlainKey(event, "k", "up")) move(-1);
    else if (isPlainKey(event, "return", "enter")) void activate();
    else if (isPlainKey(event, "n")) void addToSection(sectionOf);
    else if (isPlainKey(event, "s")) void cycleStatus();
    else if (isPlainKey(event, "d")) void remove();
    else if (isPlainKey(event, "c")) void challengeSelected();
    else if (isPlainKey(event, "r")) void review();
    else if (isPlainKey(event, "e")) void editMenu();
    else if (isPlainKey(event, "o")) openSource();
    else return;
    event.stopPropagation?.();
    event.preventDefault?.();
  });

  const isTeam = thesis.owner.kind === "team";
  const hints = useMemo<PaneHint[]>(() => {
    const kind = selectedRow?.kind;
    const list: PaneHint[] = [];
    if (kind === "signal") {
      if (selectedRow?.kind === "signal" && selectedRow.item.source?.url) list.push({ id: "open", key: "o", label: "pen source", onPress: openSource });
    } else if (kind === "pillar" || kind === "catalyst") {
      list.push({ id: "status", key: "s", label: "tatus", onPress: () => void cycleStatus() });
      list.push({ id: "remove", key: "d", label: "elete", onPress: () => void remove() });
    } else if (kind === "kill") {
      list.push({ id: "status", key: "s", label: selectedRow?.kind === "kill" && selectedRow.item.triggered ? " reset" : " fired", onPress: () => void cycleStatus() });
      list.push({ id: "remove", key: "d", label: "elete", onPress: () => void remove() });
    }
    list.push({ id: "add", key: "n", label: "ew", onPress: () => void addToSection(sectionOf) });
    if (isTeam) list.push({ id: "challenge", key: "c", label: "hallenge", onPress: () => void challengeSelected() });
    list.push({ id: "review", key: "r", label: plan.hasProAccess ? "eview" : "eview (Pro)", onPress: () => void review() });
    list.push({ id: "edit", key: "e", label: "dit", onPress: () => void editMenu() });
    return list;
  }, [addToSection, challengeSelected, cycleStatus, editMenu, isTeam, openSource, plan.hasProAccess, remove, review, sectionOf, selectedRow]);

  usePaneFooter(footerId, () => ({
    info: [
      ...(busy ? [{ id: "busy", parts: [{ text: "working", tone: "muted" as const }] }] : []),
      ...(thesis.status === "closed" ? [{ id: "closed", parts: [{ text: "closed", tone: "muted" as const }] }] : []),
    ],
    hints,
  }), [busy, hints, thesis.status]);

  const items = useMemo<ListViewItem[]>(() => rows.map((row) => ({ id: row.id, label: row.id, disabled: !isSelectable(row) })), [rows]);

  const renderRow = useCallback((item: ListViewItem, state: { selected: boolean }) => {
    const row = rows.find((entry) => entry.id === item.id);
    if (!row) return null;
    const fg = state.selected ? colors.selectedText : colors.text;
    const dim = state.selected ? colors.selectedText : colors.textDim;
    // Every row is a full-width row box, so the DOM host lays headings and
    // prose out flush left like the pillar rows instead of centering them.
    if (row.kind === "heading") {
      return (
        <Box flexDirection="row" width={contentWidth}>
          <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>{truncateToDisplayWidth(row.label, contentWidth)}</Text>
        </Box>
      );
    }
    if (row.kind === "empty" || row.kind === "text") {
      return (
        <Box flexDirection="row" width={contentWidth}>
          <Text fg={colors.textDim}>{`   ${truncateToDisplayWidth(row.text, contentWidth - 3)}`}</Text>
        </Box>
      );
    }
    if (row.kind === "pillar") {
      const pillar = row.item;
      const right = pillar.metric ? `${formatBound(pillar.metric)}  ${pillar.status}` : pillar.status;
      const scope = pillar.scope ? `${pillar.scope}: ` : "";
      const { left, right: rightText } = twoColumn(` ${pillarGlyph(pillar.status)} ${scope}${pillar.text}`, right, contentWidth);
      const statusColor = pillar.status === "broken" ? colors.negative : pillar.status === "weakening" ? colors.warning : pillar.status === "intact" ? colors.positive : dim;
      return (
        <Box flexDirection="row" width={contentWidth} justifyContent="space-between">
          <Text fg={fg}>{left}</Text>
          <Text fg={state.selected ? fg : statusColor}>{rightText}</Text>
        </Box>
      );
    }
    if (row.kind === "kill") {
      const condition = row.item;
      const { left, right } = twoColumn(` ${condition.triggered ? "✗" : " "} ${condition.text}`, condition.triggered ? "FIRED" : "not fired", contentWidth);
      return (
        <Box flexDirection="row" width={contentWidth} justifyContent="space-between">
          <Text fg={condition.triggered && !state.selected ? colors.negative : fg}>{left}</Text>
          <Text fg={state.selected ? fg : condition.triggered ? colors.negative : dim}>{right}</Text>
        </Box>
      );
    }
    if (row.kind === "catalyst") {
      const catalyst = row.item;
      const stateLabel = catalystState(catalyst);
      const days = catalyst.date ? daysUntil(catalyst.date) : null;
      const when = catalyst.date ? `${catalyst.date}${days !== null && stateLabel !== "hit" && stateLabel !== "missed" ? ` · ${describeDays(days)}` : ""}` : "";
      const right = stateLabel === "hit" || stateLabel === "missed" ? `${when}  ${stateLabel}` : stateLabel === "passed" ? `${when}  slipped` : when;
      const { left, right: rightText } = twoColumn(`   ${catalyst.text}`, right, contentWidth);
      const tone = stateLabel === "missed" || stateLabel === "passed" ? colors.negative : stateLabel === "hit" ? colors.positive : stateLabel === "due" ? colors.warning : dim;
      return (
        <Box flexDirection="row" width={contentWidth} justifyContent="space-between">
          <Text fg={fg}>{left}</Text>
          <Text fg={state.selected ? fg : tone}>{rightText}</Text>
        </Box>
      );
    }
    const signal = row.item;
    const marker = signal.verdict === "breaks" ? "‼" : signal.verdict === "challenges" ? "▲" : signal.verdict === "supports" ? "✓" : "·";
    const who = signal.origin === "user" ? `@${signal.createdBy?.username ?? signal.createdBy?.displayName ?? "teammate"}` : signal.origin === "rule" ? "rule" : "ai";
    const target = signalTargetText(thesis.document, signal);
    const head = ` ${marker} ${signal.verdict} · ${target}`;
    const right = `${who} · ${relative(signal.createdAt)}`;
    const { left, right: rightText } = twoColumn(head, right, contentWidth);
    const tone = verdictTone(signal.verdict);
    const toneColor = tone === "negative" ? colors.negative : tone === "warning" ? colors.warning : tone === "positive" ? colors.positive : dim;
    return (
      <Box flexDirection="row" width={contentWidth} justifyContent="space-between">
        <Text fg={state.selected ? fg : toneColor}>{left}</Text>
        <Text fg={dim}>{rightText}</Text>
      </Box>
    );
  }, [contentWidth, rows, thesis.document]);

  const owner = isTeam ? teamStore.getTeam(thesis.owner.id)?.name ?? "team" : null;
  const nextDue = thesis.document.catalysts
    .filter((catalyst) => catalyst.status === "pending" && catalyst.date)
    .sort((a, b) => a.date!.localeCompare(b.date!))[0];
  const nextDays = nextDue?.date ? daysUntil(nextDue.date) : null;
  const meta = [
    `${thesis.document.instruments.map((entry) => `${entry.side === "short" ? "Short " : "Long "}${entry.symbol}${entry.role === "hedge" ? " (hedge)" : ""}`).join(", ")}`,
    `Conviction ${thesis.conviction}/10`,
    thesis.horizon ? `Horizon ${thesis.horizon}` : null,
    thesis.document.target?.price ? `Target ${thesis.document.target.price}` : null,
    `Rev ${thesis.revision}`,
    owner ? `${owner} · @${thesis.updatedBy.username ?? thesis.updatedBy.displayName}` : null,
  ].filter(Boolean).join(" · ");
  const reviewLine = thesis.reviewedAt ? `Reviewed ${relative(thesis.reviewedAt)}` : "Never reviewed";
  const due = reviewDue(thesis);
  const summaryLines = thesis.document.summary ? wrap(thesis.document.summary, contentWidth, 3) : [];
  const evidence = thesis.document.evidence.symbols.length ? `Listening to ${thesis.document.evidence.symbols.join(", ")}` : null;
  const headerHeight = 2 + summaryLines.length + (evidence ? 1 : 0) + 1;
  // The selected row's particulars live in a strip under the list, so every
  // row stays one line and the list never has to re-measure.
  const stripLines = useMemo(() => {
    const row = selectedRow;
    if (!row) return [] as Array<{ text: string; dim: boolean }>;
    const lines: Array<{ text: string; dim: boolean }> = [];
    if (row.kind === "signal") {
      const source = row.item.source;
      const sourceText = source?.title ?? (source?.kind === "user" ? "Filed by a teammate" : source?.kind ?? "");
      const when = source?.at ? ` · ${source.at.slice(0, 10)}` : "";
      if (sourceText) lines.push({ text: truncateToDisplayWidth(`${sourceText}${when}${source?.url ? "  (o opens)" : ""}`, contentWidth), dim: true });
      for (const line of wrap(row.item.reason, contentWidth, 3)) lines.push({ text: line, dim: false });
      if (row.item.confidence !== null) lines.push({ text: `confidence ${Math.round(row.item.confidence * 100)}%`, dim: true });
    } else if (row.kind === "pillar") {
      if (row.item.metric) lines.push({ text: `Checks itself: ${metricLabel(row.item.metric.key)} ${formatBound(row.item.metric)}`, dim: true });
      if (row.item.note) for (const line of wrap(row.item.note, contentWidth, 2)) lines.push({ text: line, dim: false });
    } else if (row.kind === "kill" && row.item.note) {
      for (const line of wrap(row.item.note, contentWidth, 2)) lines.push({ text: line, dim: false });
    }
    return lines;
  }, [contentWidth, selectedRow]);
  const stripHeight = stripLines.length ? stripLines.length + 1 : 0;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} width={width}>
      <Box height={1} flexDirection="row" gap={1}>
        <Badge label={healthLabel(thesis.health)} tone={healthTone(thesis.health)} variant="solid" />
        {thesis.status !== "active" && <Badge label={thesis.status} tone="neutral" />}
        <Text fg={due ? colors.warning : colors.textDim}>{reviewLine}</Text>
        {nextDue && nextDays !== null && (
          <Text fg={nextDays <= 14 ? colors.warning : colors.textDim}>{truncateToDisplayWidth(`Next: ${nextDue.text} ${describeDays(nextDays)}`, Math.max(10, contentWidth - 40))}</Text>
        )}
      </Box>
      <Box height={1}>
        <Text fg={colors.textDim}>{truncateToDisplayWidth(meta, contentWidth)}</Text>
      </Box>
      {summaryLines.map((line, index) => (
        <Box key={index} height={1}>
          <Text fg={colors.text}>{line}</Text>
        </Box>
      ))}
      {evidence && (
        <Box height={1}>
          <Text fg={colors.textMuted}>{truncateToDisplayWidth(evidence, contentWidth)}</Text>
        </Box>
      )}
      <Box height={1} />
      <ListView
        items={items}
        selectedIndex={selectedIndex}
        onSelect={(index) => {
          const row = rows[index];
          if (row && isSelectable(row)) {
            userPicked.current = true;
            setSelectedId(row.id);
          }
        }}
        onActivate={() => void activate()}
        renderRow={renderRow}
        scrollable
        surface="plain"
        rowGap={0}
        height={Math.max(3, height - headerHeight - stripHeight)}
        getRowBackgroundColor={(item, state) => (state.selected ? colors.selected : item.disabled ? colors.bg : undefined)}
        remoteRole="thesis"
        remoteLabel={thesis.title}
      />
      {stripLines.length > 0 && (
        <Box flexDirection="column" height={stripHeight} marginTop={1}>
          {stripLines.map((line, index) => (
            <Box key={index} height={1}>
              <Text fg={line.dim ? colors.textDim : colors.text}>{line.text}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

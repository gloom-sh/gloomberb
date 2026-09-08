import type { ASKGClientErrorCode } from "../../../../api-client/askg";
import type {
  ASKGLimits,
  ASKGSseEvent,
  ASKGToolCallEvent,
  JsonValue,
  ToolManifestSource,
  ToolResultPayload,
  ToolResultStatus,
  WriteTier,
} from "./protocol";

/** Lifecycle of one row in the tool timeline. */
export type ASKGToolRowStatus =
  | ToolResultStatus
  | "pending"
  | "awaiting-confirmation"
  | "running";

export type ASKGUndoStatus = "available" | "running" | "done" | "failed";

export interface ASKGUndoState {
  status: ASKGUndoStatus;
  note?: string;
}

export interface ASKGToolRow {
  toolCallId: string;
  name: string;
  /** One line rendering of the call arguments, e.g. `NVDA · range=5Y`. */
  argumentSummary: string;
  writeTier: WriteTier;
  /** Server tools are executed by the platform and marked as run by Gloom. */
  origin: "client" | "server";
  source?: ToolManifestSource;
  status: ASKGToolRowStatus;
  requiresConfirmation: boolean;
  /** Dry run description shown before a `user-data` or `broker` call runs. */
  preview?: JsonValue;
  rowCount?: number;
  elapsedMs?: number;
  truncated?: boolean;
  note?: string;
  /** Rows returned locally; server tools only report a sample. */
  result?: JsonValue;
  undoToken?: string;
  undo?: ASKGUndoState;
  expanded: boolean;
}

export type ASKGTurnStatus =
  | "streaming"
  | "complete"
  | "cancelled"
  | "error";

export interface ASKGErrorState {
  code: ASKGClientErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface ASKGTurn {
  id: string;
  /** Server turn id, known once the stream announces itself. */
  remoteTurnId: string | null;
  prompt: string;
  answer: string;
  tools: ASKGToolRow[];
  status: ASKGTurnStatus;
  error: ASKGErrorState | null;
  startedAt: number;
}

export interface ASKGConversationState {
  sessionId: string | null;
  model: string | null;
  limits: ASKGLimits | null;
  /** Tool names the session negotiated; anything else is refused locally. */
  acceptedTools: string[];
  turns: ASKGTurn[];
  /** Highest applied `seq`, so a resumed stream skips replayed events. */
  lastSeq: number;
}

export const EMPTY_ASKG_CONVERSATION: ASKGConversationState = {
  sessionId: null,
  model: null,
  limits: null,
  acceptedTools: [],
  turns: [],
  lastSeq: 0,
};

export type ASKGAction =
  | {
    type: "session-started";
    sessionId: string;
    model: string;
    limits: ASKGLimits;
    acceptedTools: string[];
  }
  | { type: "prompt"; turnId: string; prompt: string; at: number }
  | { type: "event"; event: ASKGSseEvent }
  | { type: "tool-awaiting-confirmation"; toolCallId: string }
  | { type: "tool-running"; toolCallId: string }
  | { type: "tool-result"; payload: ToolResultPayload }
  | { type: "tool-expanded"; toolCallId: string; expanded: boolean }
  | { type: "undo"; toolCallId: string; undo: ASKGUndoState }
  | { type: "turn-failed"; turnId: string; error: ASKGErrorState }
  | { type: "turn-cancelled"; turnId: string }
  | { type: "reset" };

/**
 * Tiers that never run without the user saying so. `read` is silent and
 * `ui-write` is reversible, so only account and broker writes stop the turn.
 */
export function requiresLocalConfirmation(call: {
  writeTier: WriteTier;
  requiresConfirmation: boolean;
}): boolean {
  return call.requiresConfirmation
    || call.writeTier === "user-data"
    || call.writeTier === "broker";
}

function scalarText(value: JsonValue): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(scalarText).filter(Boolean).join(",");
  return JSON.stringify(value);
}

/** Compact single line form of a tool call's arguments for the timeline. */
export function summarizeToolArguments(args: Record<string, JsonValue>): string {
  const parts: string[] = [];
  const leading = ["symbol", "symbols", "text", "query", "paneId", "resource"];
  const seen = new Set<string>();
  for (const key of leading) {
    if (!(key in args)) continue;
    seen.add(key);
    const text = scalarText(args[key] as JsonValue);
    if (text) parts.push(text);
  }
  for (const key of Object.keys(args).sort()) {
    if (seen.has(key)) continue;
    const text = scalarText(args[key] as JsonValue);
    if (!text) continue;
    parts.push(`${key}=${text}`);
  }
  return parts.join(" · ");
}

function rowFromToolCall(event: ASKGToolCallEvent): ASKGToolRow {
  return {
    toolCallId: event.toolCallId,
    name: event.name,
    argumentSummary: summarizeToolArguments(event.args),
    writeTier: event.writeTier,
    origin: "client",
    status: requiresLocalConfirmation(event) ? "awaiting-confirmation" : "pending",
    requiresConfirmation: requiresLocalConfirmation(event),
    ...(event.preview !== undefined && event.preview !== null ? { preview: event.preview } : {}),
    expanded: false,
  };
}

function patchTurn(
  state: ASKGConversationState,
  turnId: string | null,
  patch: (turn: ASKGTurn) => ASKGTurn,
): ASKGConversationState {
  // Newest first: a server that reuses a turn id must not reopen an old turn.
  const index = turnId
    ? state.turns.findLastIndex((turn) => turn.id === turnId || turn.remoteTurnId === turnId)
    : state.turns.length - 1;
  if (index < 0) return state;
  const turns = [...state.turns];
  const current = turns[index];
  if (!current) return state;
  turns[index] = patch(current);
  return { ...state, turns };
}

/** Applies a change to whichever turn owns the tool call. */
function patchToolRow(
  state: ASKGConversationState,
  toolCallId: string,
  patch: (row: ASKGToolRow) => ASKGToolRow,
): ASKGConversationState {
  const index = state.turns.findLastIndex((turn) => (
    turn.tools.some((row) => row.toolCallId === toolCallId)
  ));
  if (index < 0) return state;
  const turns = [...state.turns];
  const turn = turns[index];
  if (!turn) return state;
  turns[index] = {
    ...turn,
    tools: turn.tools.map((row) => (row.toolCallId === toolCallId ? patch(row) : row)),
  };
  return { ...state, turns };
}

function appendToolRow(turn: ASKGTurn, row: ASKGToolRow): ASKGTurn {
  const existing = turn.tools.findIndex((entry) => entry.toolCallId === row.toolCallId);
  if (existing < 0) return { ...turn, tools: [...turn.tools, row] };
  const tools = [...turn.tools];
  tools[existing] = { ...tools[existing], ...row } as ASKGToolRow;
  return { ...turn, tools };
}

function applyEvent(
  state: ASKGConversationState,
  event: ASKGSseEvent,
): ASKGConversationState {
  // Resumed streams replay what the client already applied.
  if (event.seq <= state.lastSeq) return state;
  const next = { ...state, lastSeq: event.seq };

  switch (event.type) {
    case "session":
      return patchTurn(
        { ...next, sessionId: event.sessionId, model: event.model },
        null,
        (turn) => (turn.remoteTurnId ? turn : { ...turn, remoteTurnId: event.turnId }),
      );
    case "text-delta":
      return patchTurn(next, event.turnId, (turn) => ({
        ...turn,
        remoteTurnId: turn.remoteTurnId ?? event.turnId,
        answer: turn.answer + event.delta,
      }));
    case "tool-call":
      return patchTurn(next, event.turnId, (turn) => appendToolRow(turn, rowFromToolCall(event)));
    case "tool-executed": {
      if (event.source === "server") {
        return patchTurn(next, event.turnId, (turn) => appendToolRow(turn, {
          toolCallId: event.toolCallId,
          name: event.name,
          argumentSummary: event.summary.note ?? "",
          writeTier: "read",
          origin: "server",
          source: event.source,
          status: event.status,
          requiresConfirmation: false,
          ...(event.summary.rowCount !== undefined ? { rowCount: event.summary.rowCount } : {}),
          elapsedMs: event.summary.elapsedMs,
          truncated: event.summary.truncated,
          ...(event.summary.note ? { note: event.summary.note } : {}),
          ...(event.summary.sample !== undefined ? { result: event.summary.sample } : {}),
          expanded: false,
        }));
      }
      // The client already holds the full result for its own tools; the server
      // echo only confirms the status it recorded.
      return patchToolRow(next, event.toolCallId, (row) => ({
        ...row,
        source: event.source,
        status: row.status === "running" || row.status === "pending" ? event.status : row.status,
        elapsedMs: row.elapsedMs ?? event.summary.elapsedMs,
      }));
    }
    case "tool-result-ack":
      return next;
    case "error":
      return patchTurn(next, event.turnId ?? null, (turn) => ({
        ...turn,
        status: "error",
        error: {
          code: event.code,
          message: event.message,
          retryable: event.retryable,
          ...(event.retryAfterMs !== undefined ? { retryAfterMs: event.retryAfterMs } : {}),
        },
      }));
    case "usage":
      return next;
    case "done":
      return patchTurn(next, event.turnId, (turn) => ({
        ...turn,
        status: event.reason === "complete"
          ? "complete"
          : event.reason === "cancelled"
            ? "cancelled"
            : turn.error
              ? "error"
              : event.reason === "timeout"
                ? "error"
                : "complete",
        error: turn.error ?? (event.reason === "timeout"
          ? {
            code: "turn_timeout",
            message: "Gloom ran out of time answering this question.",
            retryable: true,
          }
          : null),
        // A stream that stops mid tool call must not leave a row spinning.
        tools: turn.tools.map((row) => (
          row.status === "pending" || row.status === "running" || row.status === "awaiting-confirmation"
            ? { ...row, status: "cancelled" as const }
            : row
        )),
      }));
  }
}

export function askgReducer(
  state: ASKGConversationState,
  action: ASKGAction,
): ASKGConversationState {
  switch (action.type) {
    case "session-started":
      return {
        ...state,
        sessionId: action.sessionId,
        model: action.model,
        limits: action.limits,
        acceptedTools: action.acceptedTools,
      };
    case "prompt":
      return {
        ...state,
        // Each turn is its own stream, so sequence numbers restart with it.
        lastSeq: 0,
        turns: [...state.turns, {
          id: action.turnId,
          remoteTurnId: null,
          prompt: action.prompt,
          answer: "",
          tools: [],
          status: "streaming",
          error: null,
          startedAt: action.at,
        }],
      };
    case "event":
      return applyEvent(state, action.event);
    case "tool-awaiting-confirmation":
      return patchToolRow(state, action.toolCallId, (row) => ({
        ...row,
        status: "awaiting-confirmation",
      }));
    case "tool-running":
      return patchToolRow(state, action.toolCallId, (row) => ({ ...row, status: "running" }));
    case "tool-result":
      return patchToolRow(state, action.payload.toolCallId, (row) => ({
        ...row,
        status: action.payload.status,
        ...(action.payload.rowCount !== undefined ? { rowCount: action.payload.rowCount } : {}),
        elapsedMs: action.payload.elapsedMs,
        truncated: action.payload.truncated,
        ...(action.payload.note ? { note: action.payload.note } : {}),
        ...(action.payload.result !== undefined ? { result: action.payload.result } : {}),
        ...(action.payload.undoToken
          ? { undoToken: action.payload.undoToken, undo: { status: "available" as const } }
          : {}),
      }));
    case "tool-expanded":
      return patchToolRow(state, action.toolCallId, (row) => ({
        ...row,
        expanded: action.expanded,
      }));
    case "undo":
      return patchToolRow(state, action.toolCallId, (row) => ({ ...row, undo: action.undo }));
    case "turn-failed":
      return patchTurn(state, action.turnId, (turn) => ({
        ...turn,
        status: "error",
        error: action.error,
        tools: turn.tools.map((row) => (
          row.status === "pending" || row.status === "running" || row.status === "awaiting-confirmation"
            ? { ...row, status: "cancelled" as const }
            : row
        )),
      }));
    case "turn-cancelled":
      return patchTurn(state, action.turnId, (turn) => ({
        ...turn,
        status: turn.status === "streaming" ? "cancelled" : turn.status,
        tools: turn.tools.map((row) => (
          row.status === "pending" || row.status === "running" || row.status === "awaiting-confirmation"
            ? { ...row, status: "cancelled" as const }
            : row
        )),
      }));
    case "reset":
      return {
        ...EMPTY_ASKG_CONVERSATION,
        sessionId: state.sessionId,
        model: state.model,
        limits: state.limits,
        acceptedTools: state.acceptedTools,
      };
  }
}

/** The tool call the pane is currently blocking on, if any. */
export function pendingConfirmation(state: ASKGConversationState): ASKGToolRow | null {
  for (const turn of state.turns) {
    for (const row of turn.tools) {
      if (row.status === "awaiting-confirmation") return row;
    }
  }
  return null;
}

export function activeTurn(state: ASKGConversationState): ASKGTurn | null {
  const turn = state.turns[state.turns.length - 1];
  return turn ?? null;
}

export function isTurnRunning(state: ASKGConversationState): boolean {
  return activeTurn(state)?.status === "streaming";
}

export interface ASKGResultColumn {
  key: string;
  header: string;
  align?: "left" | "right" | "center";
  width?: number;
}

export interface ASKGResultTable {
  title?: string;
  columns: ASKGResultColumn[];
  rows: Record<string, JsonValue>[];
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function columnsFromRows(
  rows: Record<string, JsonValue>[],
  declared: JsonValue | undefined,
): ASKGResultColumn[] {
  if (Array.isArray(declared)) {
    const columns = declared
      .filter(isRecord)
      .map((column) => ({
        key: String(column.key ?? ""),
        header: String(column.header ?? column.key ?? ""),
        ...(typeof column.align === "string"
          ? { align: column.align as ASKGResultColumn["align"] }
          : {}),
        ...(typeof column.width === "number" ? { width: column.width } : {}),
      }))
      .filter((column) => column.key);
    if (columns.length > 0) return columns;
  }
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys.map((key) => ({ key, header: key }));
}

function rowRecords(value: JsonValue | undefined): Record<string, JsonValue>[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((entry, index) => (
    isRecord(entry) ? entry : { "#": index + 1, value: entry as JsonValue }
  ));
}

/**
 * Projects a tool result onto tables the shared data table can render. Headless
 * results already carry columns; anything else is described by its own keys so
 * a remote operation result is still readable.
 */
export function toolResultTables(result: JsonValue | undefined): ASKGResultTable[] {
  if (result === undefined || result === null) return [];
  if (Array.isArray(result)) {
    const rows = rowRecords(result) ?? [];
    return rows.length > 0 ? [{ columns: columnsFromRows(rows, undefined), rows }] : [];
  }
  if (!isRecord(result)) return [];

  const rows = rowRecords(result.rows) ?? rowRecords(result.items);
  if (rows) {
    return [{ columns: columnsFromRows(rows, result.columns), rows }];
  }

  if (Array.isArray(result.sections)) {
    const tables: ASKGResultTable[] = [];
    for (const section of result.sections) {
      if (!isRecord(section)) continue;
      const title = typeof section.title === "string" ? section.title : undefined;
      const sectionRows = rowRecords(section.rows);
      if (sectionRows) {
        tables.push({
          ...(title ? { title } : {}),
          columns: columnsFromRows(sectionRows, section.columns),
          rows: sectionRows,
        });
        continue;
      }
      const entries = Array.isArray(section.entries) ? section.entries.filter(isRecord) : [];
      if (entries.length === 0) continue;
      tables.push({
        ...(title ? { title } : {}),
        columns: [{ key: "label", header: "Item" }, { key: "value", header: "Value" }],
        rows: entries.map((entry) => ({
          label: (entry.label ?? entry.key ?? "") as JsonValue,
          value: (entry.formatted ?? entry.value ?? null) as JsonValue,
        })),
      });
    }
    return tables;
  }

  if (Array.isArray(result.series)) {
    const rows = result.series.filter(isRecord).map((series) => {
      const points = Array.isArray(series.points) ? series.points : [];
      const last = points[points.length - 1];
      return {
        series: (series.label ?? series.id ?? "") as JsonValue,
        points: points.length,
        last: isRecord(last) ? (last.value ?? last.close ?? null) : null,
      } satisfies Record<string, JsonValue>;
    });
    return rows.length > 0
      ? [{
        columns: [
          { key: "series", header: "Series" },
          { key: "points", header: "Points", align: "right" },
          { key: "last", header: "Last", align: "right" },
        ],
        rows,
      }]
      : [];
  }

  // A plain object result reads best as label and value pairs.
  const entries = Object.entries(result).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return [];
  return [{
    columns: [{ key: "label", header: "Field" }, { key: "value", header: "Value" }],
    rows: entries.map(([label, value]) => ({
      label,
      value: isRecord(value) || Array.isArray(value) ? JSON.stringify(value) : value,
    })),
  }];
}

/** Symbol a result row points at, used to open the ticker it describes. */
export function rowSymbol(row: Record<string, JsonValue>): string | null {
  for (const key of ["symbol", "ticker", "Symbol", "Ticker"]) {
    const value = row[key];
    if (typeof value === "string" && /^[A-Za-z0-9.\-^]{1,12}$/.test(value.trim())) {
      return value.trim().toUpperCase();
    }
  }
  return null;
}

export function formatCellValue(value: JsonValue | undefined): string {
  if (value == null) return "-";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

const ERROR_TITLES: Record<ASKGClientErrorCode, string> = {
  rate_limited: "Rate limited",
  daily_turn_cap: "Daily question limit reached",
  tool_budget_exhausted: "Tool budget used up",
  turn_timeout: "Answer timed out",
  model_usage_limit: "Model usage limit reached",
  model_unavailable: "Model unavailable",
  turn_already_recorded: "Turn already answered",
  transport_unsupported: "Streaming unavailable",
  tier_required: "Ask Gloom needs a paid plan",
  unauthorized: "Sign in required",
  network: "Connection lost",
  protocol: "Version mismatch",
  internal: "Ask Gloom failed",
};

/** Specific, actionable one line description of a failure. */
export function describeASKGError(error: ASKGErrorState): string {
  const title = ERROR_TITLES[error.code] ?? "Ask Gloom failed";
  const retry = error.retryAfterMs && error.retryAfterMs > 0
    ? ` Try again in ${Math.max(1, Math.round(error.retryAfterMs / 1000))}s.`
    : "";
  const detail = error.message.trim();
  return detail && detail.toLowerCase() !== title.toLowerCase()
    ? `${title}: ${detail}${retry}`
    : `${title}.${retry}`;
}

/** Wording for the tool row status column. */
export function describeToolStatus(row: ASKGToolRow): string {
  switch (row.status) {
    case "pending":
      return "queued";
    case "awaiting-confirmation":
      return "needs approval";
    case "running":
      return "running";
    case "ok":
      return row.rowCount === undefined
        ? "done"
        : `${row.rowCount} ${row.rowCount === 1 ? "row" : "rows"}`;
    case "partial":
      return row.rowCount === undefined ? "partial" : `${row.rowCount} rows · partial`;
    case "denied":
      return "declined";
    case "timeout":
      return "timed out";
    case "cancelled":
      return "cancelled";
    case "error":
      return "failed";
  }
}

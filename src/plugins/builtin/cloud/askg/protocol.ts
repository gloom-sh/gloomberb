// Wire declarations must match the Gloom Cloud /askg API.
import type {
  HeadlessPaneArgumentDef,
  HeadlessPaneColumn,
  HeadlessPaneOptionDef,
  HeadlessPaneShape,
} from "../../../../types/headless";
import type {
  RemoteJsonSchema,
  RemoteWriteTier,
} from "../../../../remote/types";

/** Major version of the ASKG client and server wire contract. */
export const ASKG_PROTOCOL_VERSION = 1;

/** Maximum accepted JSON-encoded client tool result size. */
export const MAX_TOOL_RESULT_BYTES = 262_144;

/** Source form for valid tool names advertised to ASKG. */
export const TOOL_NAME_PATTERN = "^[a-z0-9][a-z0-9_.]{0,47}$";

/**
 * The server tool that runs a script of tool calls in one step. The platform
 * owns the name: a client that advertises a tool called this is refused.
 */
export const SCRIPT_TOOL_NAME = "run_script";

/**
 * Optional protocol features. A client offers them at session start, the
 * server answers with the ones it will use, and the client repeats the
 * accepted set on every turn of that session. A missing key, or a server that
 * sends nothing, means the feature is off; unknown keys are ignored.
 */
export interface ASKGCapabilities {
  /** 1: the turn may answer by running scripts of tool calls. */
  scripts?: 1;
  /**
   * 1: answers can be rated. Only the session start carries it; a turn never
   * repeats it, and a reopened conversation says it on its own response.
   */
  feedback?: 1;
}

/** What this build offers at session start. */
export const ASKG_CLIENT_CAPABILITIES: ASKGCapabilities = { scripts: 1, feedback: 1 };

/** A thumbs up or down on one answer. */
export type ASKGFeedbackRating = "up" | "down";

/** Why a thumbs down, from a fixed list: a rating never carries text. */
export type ASKGFeedbackReason = "wrong" | "slow" | "missing_data" | "other";

/** Body of `PUT /askg/turns/:turnId/feedback`. Rating again overwrites. */
export interface ASKGFeedbackRequest {
  rating: ASKGFeedbackRating;
  /** Only with a thumbs down. */
  reason?: ASKGFeedbackReason | null;
  /**
   * The person agreed to send this answer. The request carries the consent,
   * not the text: the platform copies the question, the answer and the names
   * of the tools that ran from its own transcript, and nothing else.
   */
  share?: boolean;
}

/** A rating as stored: the route's answer, and what a reopened answer carries. */
export interface ASKGFeedback {
  rating: ASKGFeedbackRating;
  reason: ASKGFeedbackReason | null;
  /** The answer was sent. Sending is one way: a later rating keeps it sent. */
  shared: boolean;
}

/** JSON value accepted on the ASKG wire. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Safety tier applied before a client tool is executed. */
export type WriteTier = RemoteWriteTier;

/** Runtime that opened an ASKG session. */
type ASKGClientKind = "tui" | "desktop" | "web";

/** Origin of an advertised client tool. */
/**
 * Origin of a tool. This client only ever advertises "headless" and
 * "remote-op"; "server" describes the tools the platform runs itself and
 * reports back in `serverTools`, so a session response can describe its whole
 * tool surface.
 */
export type ToolManifestSource = "headless" | "remote-op" | "server";

/** The subset this client is allowed to advertise at session start. */
export type ClientToolManifestSource = Exclude<ToolManifestSource, "server">;

/** Headless result shapes supported by the tool timeline. */
type ToolManifestShape = HeadlessPaneShape;

/** Serializable headless argument declaration. */
export type ToolManifestArgument = HeadlessPaneArgumentDef;

/** Serializable headless option declaration. */
export type ToolManifestOption = Omit<HeadlessPaneOptionDef, "settingKey" | "pluginState" | "normalize">;

/** Serializable headless column declaration. */
export type ToolManifestColumn = Omit<HeadlessPaneColumn, "format">;

/** JSON Schema accepted by a remote operation tool. */
type ToolInputSchema = RemoteJsonSchema;

/** Client or server tool metadata negotiated when a session starts. */
export type ClientToolManifest = ToolManifest & { source: ClientToolManifestSource };

interface ToolManifest {
  /** Lowercase stable identifier matching TOOL_NAME_PATTERN. */
  name: string;
  source: ToolManifestSource;
  title: string;
  description: string;
  writeTier: WriteTier;
  shape?: ToolManifestShape;
  argument?: ToolManifestArgument;
  options?: ToolManifestOption[];
  columns?: ToolManifestColumn[];
  inputSchema?: ToolInputSchema;
  confirm: "never" | "always";
  timeoutMs: number;
}

/** Client identity included in a session negotiation. */
export interface ASKGClientDescriptor {
  kind: ASKGClientKind;
  version: string;
}

/**
 * The user's portfolios, watchlists and broker accounts by id and display
 * name, so Gloom passes real ids to tools instead of guessing them. Never
 * positions, quantities or balances. Each list is optional and bounded.
 */
export interface ASKGUserData {
  portfolios?: Array<{ id: string; name: string; kind: "manual" | "broker" }>;
  watchlists?: Array<{ id: string; name: string; count?: number }>;
  brokerAccounts?: Array<{ id: string; name: string; portfolioId?: string }>;
}

/** Terminal context supplied to the model at session start and with each turn. */
export interface ASKGSessionContext {
  query?: string;
  symbol?: string;
  paneId?: string;
  layout?: JsonValue;
  /** Optional: a server that does not know it ignores it. */
  userData?: ASKGUserData;
}

/** Request used to negotiate tools and limits for an ASKG session. */
export interface ASKGSessionStartRequest {
  protocolVersion: typeof ASKG_PROTOCOL_VERSION;
  client: ASKGClientDescriptor;
  context: ASKGSessionContext;
  /** A client may only advertise tools it executes itself. */
  tools: ClientToolManifest[];
  manifestHash: string;
  capabilities?: ASKGCapabilities;
}

/** Per-user and per-turn limits returned by the platform. */
export interface ASKGLimits {
  requestsPerMinute: number;
  turnsPerDay: number;
  turnsRemainingToday: number;
  maxToolCallsPerTurn: number;
  turnWallClockMs: number;
  clientToolTimeoutMs: number;
}

/** Client tool rejected during session negotiation. */
interface ASKGRejectedTool {
  name: string;
  reason: string;
}

/** Successful ASKG session negotiation response. */
export interface ASKGSessionStartResponse {
  protocolVersion: typeof ASKG_PROTOCOL_VERSION;
  sessionId: string;
  manifestHash: string;
  serverTools: ToolManifest[];
  acceptedTools: string[];
  rejectedTools: ASKGRejectedTool[];
  limits: ASKGLimits;
  tier: string;
  model: string;
  promptVersion: string;
  expiresAt: string;
  /** Absent from a server that predates them or has them switched off. */
  capabilities?: ASKGCapabilities;
}

/** Request body for one turn on an open session. */
export interface ASKGTurnRequest {
  protocolVersion?: typeof ASKG_PROTOCOL_VERSION;
  /** Client generated id, reused verbatim to re-attach to a running turn. */
  turnId: string;
  /** Omitted to start a conversation; the stream reports the one it opened. */
  conversationId?: string;
  input: string;
  context?: ASKGSessionContext;
  /**
   * Only read for a turn that named no conversation. The platform stores the
   * transcript, so once there is one it is the context, and two clients on one
   * conversation cannot disagree about what was said.
   */
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  /** The features the session accepted, repeated because each turn decides alone. */
  capabilities?: ASKGCapabilities;
}

/** Shared fields carried by every turn stream event. */
interface ASKGEventBase {
  seq: number;
}

/** Announces the session and turn attached to this stream. */
interface ASKGSessionEvent extends ASKGEventBase {
  type: "session";
  sessionId: string;
  turnId: string;
  model: string;
  promptVersion: string;
  /** The stored conversation this turn was recorded in. */
  conversationId?: string;
}

/** Appends model text to the visible answer. */
interface ASKGTextDeltaEvent extends ASKGEventBase {
  type: "text-delta";
  turnId: string;
  delta: string;
}

/** Delegates one negotiated tool call to the client. */
export interface ASKGToolCallEvent extends ASKGEventBase {
  type: "tool-call";
  turnId: string;
  toolCallId: string;
  name: string;
  args: Record<string, JsonValue>;
  writeTier: WriteTier;
  requiresConfirmation: boolean;
  preview: JsonValue;
  timeoutMs: number;
  expiresAt: string;
}

/** Compact result information suitable for the tool timeline. */
interface ToolExecutionSummary {
  rowCount?: number;
  elapsedMs: number;
  truncated: boolean;
  note?: string;
  sample?: JsonValue;
}

/** Status returned by either a server or client tool execution. */
export type ToolResultStatus =
  | "ok"
  | "error"
  | "denied"
  | "timeout"
  | "partial"
  | "cancelled";

/** Reports a completed server tool or an accepted client execution. */
interface ASKGToolExecutedEvent extends ASKGEventBase {
  type: "tool-executed";
  turnId: string;
  toolCallId: string;
  name: string;
  source: ToolManifestSource;
  status: ToolResultStatus;
  summary: ToolExecutionSummary;
  /**
   * What a tool the platform ran was asked, so its row can name the subject.
   * Absent on an older server, on a tool this client ran, and on a call whose
   * arguments were empty or too large to send.
   */
  args?: Record<string, JsonValue>;
}

/** Confirms that one client tool result was accepted by the turn loop. */
interface ASKGToolResultAckEvent extends ASKGEventBase {
  type: "tool-result-ack";
  turnId: string;
  toolCallId: string;
}

/** Stable error codes that clients can handle without parsing text. */
export type ASKGErrorCode =
  | "rate_limited"
  | "daily_turn_cap"
  | "tool_budget_exhausted"
  | "turn_timeout"
  | "model_usage_limit"
  | "model_unavailable"
  | "turn_already_recorded"
  | "internal";

/** Reports a recoverable or terminal session or turn failure. */
interface ASKGErrorEvent extends ASKGEventBase {
  type: "error";
  turnId?: string;
  code: ASKGErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

/** Token accounting emitted when the model provider supplies it. */
interface ASKGUsageEvent extends ASKGEventBase {
  type: "usage";
  turnId: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimated: boolean;
}

/** Reason a turn stream stopped. */
export type ASKGDoneReason = "complete" | "cancelled" | "error" | "timeout";

/** Terminates a turn stream. */
interface ASKGDoneEvent extends ASKGEventBase {
  type: "done";
  turnId: string;
  reason: ASKGDoneReason;
}

/** Event payloads emitted over the ASKG turn SSE stream. */
export type ASKGSseEvent =
  | ASKGSessionEvent
  | ASKGTextDeltaEvent
  | ASKGToolCallEvent
  | ASKGToolExecutedEvent
  | ASKGToolResultAckEvent
  | ASKGErrorEvent
  | ASKGUsageEvent
  | ASKGDoneEvent;

/** Client result posted for one delegated tool call. */
export interface ToolResultPayload {
  turnId: string;
  toolCallId: string;
  status: ToolResultStatus;
  result?: JsonValue;
  rowCount?: number;
  truncated: boolean;
  elapsedMs: number;
  note?: string;
  rev?: string;
  undoToken?: string;
}

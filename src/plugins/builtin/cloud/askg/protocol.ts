// Wire declarations are mirrored in gloomberb-platform/server/src/services/askg/types.ts.
import type {
  HeadlessPaneArgumentDef,
  HeadlessPaneColumn,
  HeadlessPaneOptionDef,
  HeadlessPaneOptionValue,
  HeadlessPaneShape,
} from "../../../../types/headless";
import type {
  RemoteJsonSchema,
  RemoteJsonSchemaType,
  RemoteWriteTier,
} from "../../../../remote/types";

/** Major version of the ASKG client and server wire contract. */
export const ASKG_PROTOCOL_VERSION = 1;

/** Maximum accepted JSON-encoded client tool result size. */
export const MAX_TOOL_RESULT_BYTES = 262_144;

/** Source form for valid tool names advertised to ASKG. */
export const TOOL_NAME_PATTERN = "^[a-z][a-z0-9_.]{2,48}$";

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
export type ASKGClientKind = "tui" | "desktop" | "web";

/** Origin of an advertised client tool. */
export type ToolManifestSource = "headless" | "remote-op";

/** Headless result shapes supported by the tool timeline. */
export type ToolManifestShape = HeadlessPaneShape;

/** Headless argument kinds understood by the manifest compiler. */
export type ToolManifestArgumentKind = HeadlessPaneArgumentDef["kind"];

/** Serializable headless argument declaration. */
export type ToolManifestArgument = HeadlessPaneArgumentDef;

/** Values accepted by a headless enum option. */
export type ToolManifestOptionValue = HeadlessPaneOptionValue;

/** Headless option types understood by the manifest compiler. */
export type ToolManifestOptionType = HeadlessPaneOptionDef["type"];

/** Serializable headless option declaration. */
export type ToolManifestOption = Omit<HeadlessPaneOptionDef, "settingKey" | "pluginState">;

/** Serializable headless column declaration. */
export type ToolManifestColumn = Omit<HeadlessPaneColumn, "format">;

/** JSON Schema primitive types accepted for remote operation inputs. */
export type ToolInputSchemaType = RemoteJsonSchemaType;

/** JSON Schema accepted by a remote operation tool. */
export type ToolInputSchema = RemoteJsonSchema;

/** Client or server tool metadata negotiated when a session starts. */
export interface ToolManifest {
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

/** Terminal context supplied to the model at session start. */
export interface ASKGSessionContext {
  query?: string;
  symbol?: string;
  paneId?: string;
  layout?: JsonValue;
}

/** Request used to negotiate tools and limits for an ASKG session. */
export interface ASKGSessionStartRequest {
  protocolVersion: typeof ASKG_PROTOCOL_VERSION;
  client: ASKGClientDescriptor;
  context: ASKGSessionContext;
  tools: ToolManifest[];
  manifestHash: string;
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
export interface ASKGRejectedTool {
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
}

/** Shared fields carried by every turn stream event. */
export interface ASKGEventBase {
  seq: number;
}

/** Announces the session and turn attached to this stream. */
export interface ASKGSessionEvent extends ASKGEventBase {
  type: "session";
  sessionId: string;
  turnId: string;
  model: string;
  promptVersion: string;
}

/** Appends model text to the visible answer. */
export interface ASKGTextDeltaEvent extends ASKGEventBase {
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
export interface ToolExecutionSummary {
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
export interface ASKGToolExecutedEvent extends ASKGEventBase {
  type: "tool-executed";
  turnId: string;
  toolCallId: string;
  name: string;
  source: ToolManifestSource | "server";
  status: ToolResultStatus;
  summary: ToolExecutionSummary;
}

/** Confirms that one client tool result was accepted by the turn loop. */
export interface ASKGToolResultAckEvent extends ASKGEventBase {
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
  | "internal";

/** Reports a recoverable or terminal session or turn failure. */
export interface ASKGErrorEvent extends ASKGEventBase {
  type: "error";
  turnId?: string;
  code: ASKGErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

/** Token accounting emitted when the model provider supplies it. */
export interface ASKGUsageEvent extends ASKGEventBase {
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
export interface ASKGDoneEvent extends ASKGEventBase {
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

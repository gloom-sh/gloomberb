export const REMOTE_CONTROL_PROTOCOL_VERSION = 1;

export type RemoteAppKind = "tui" | "desktop";

export interface RemoteEndpoint {
  protocolVersion: number;
  appKind: RemoteAppKind;
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export interface RemoteJsonPatchOperation {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

export type RemoteStateInclude =
  | "app"
  | "layout"
  | "panes"
  | "commandBar"
  | "commandBar.results"
  | "ui"
  | "schema"
  | "help"
  | "all";

export type RemoteMarketDataRequest =
  | { type: "data"; operation: "search"; query: string }
  | { type: "data"; operation: "quote"; symbol: string; exchange?: string }
  | { type: "data"; operation: "financials"; symbol: string; exchange?: string }
  | { type: "data"; operation: "secFilings"; symbol: string; exchange?: string; count?: number }
  | { type: "data"; operation: "holders"; symbol: string; exchange?: string }
  | { type: "data"; operation: "analystResearch"; symbol: string; exchange?: string }
  | { type: "data"; operation: "corporateActions"; symbol: string; exchange?: string }
  | { type: "data"; operation: "earningsCalendar"; symbols: string[] };

export type RemoteControlRequest =
  | { type: "help"; topic?: string }
  | { type: "schema" }
  | { type: "get"; resource: string; include?: RemoteStateInclude[] }
  | RemoteMarketDataRequest
  | { type: "call"; operation: string; input?: unknown; dryRun?: boolean; include?: RemoteStateInclude[] }
  | {
    type: "patch";
    resource: string;
    patch: RemoteJsonPatchOperation[];
    expectRev?: string;
    dryRun?: boolean;
    include?: RemoteStateInclude[];
  }
  | {
    type: "batch";
    requests: RemoteControlRequest[];
    dryRun?: boolean;
    haltOnError?: boolean;
    settle?: "none" | "afterEach" | "afterBatch";
    include?: RemoteStateInclude[];
  };

export interface RemoteIncludedState {
  rev: string;
  included: RemoteStateInclude[];
  app?: unknown;
  layout?: unknown;
  panes?: unknown;
  commandBar?: unknown;
  ui?: RemoteUiNodeSnapshot[];
  schema?: RemoteControlSchema;
  help?: unknown;
}

export interface RemoteControlSuccess<T = unknown> {
  ok: true;
  data: T;
  rev?: string;
  state?: RemoteIncludedState;
  warnings?: string[];
}

export interface RemoteControlFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type RemoteControlResponse<T = unknown> =
  | RemoteControlSuccess<T>
  | RemoteControlFailure;

export interface RemoteResourceSchema {
  uri: string;
  description: string;
  patchable?: boolean;
}

export type RemoteSideEffectLevel =
  | "none"
  | "local-write"
  | "network-write"
  | "external-side-effect"
  | "external-trade";

export type RemoteWriteTier = "read" | "ui-write" | "user-data" | "broker";

export type RemoteJsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

/** Serializable subset of JSON Schema used for remote operation inputs. */
export interface RemoteJsonSchema {
  type?: RemoteJsonSchemaType | RemoteJsonSchemaType[];
  description?: string;
  properties?: Record<string, RemoteJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: RemoteJsonSchema;
  enum?: Array<string | number | boolean | null>;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
}

export interface RemoteOperationSchema {
  id: string;
  title: string;
  description: string;
  inputShape: string;
  inputSchema: RemoteJsonSchema;
  outputShape?: string;
  returns?: string;
  recommendedNextReads?: string[];
  examples?: unknown[];
  sideEffectLevel: RemoteSideEffectLevel;
  writeTier: RemoteWriteTier;
  requiresConfirmation?: boolean;
  dryRun?: boolean;
}

/** Stable operation metadata suitable for advertising outside the process. */
export interface RemoteOperationDescriptor {
  name: string;
  title: string;
  description: string;
  writeTier: RemoteWriteTier;
  inputSchema: RemoteJsonSchema;
}

export interface RemoteControlSchema {
  protocolVersion: number;
  resources: RemoteResourceSchema[];
  operations: RemoteOperationSchema[];
  help: unknown;
}

export interface RemoteUiNodeSnapshot {
  id: string;
  role: string;
  label?: string;
  disabled?: boolean;
  actions: string[];
  metadata?: Record<string, unknown>;
}

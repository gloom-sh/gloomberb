export type ConnectionHealthKind = "asset-data" | "news" | "api" | "websocket" | "capability";
export type ConnectionHealthStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";
export type ConnectionSocketState = "idle" | "connecting" | "open" | "closed" | "error";

export interface ConnectionHealthSource {
  id: string;
  name: string;
  kind: ConnectionHealthKind;
  ownerId?: string;
  detail?: string;
  priority?: number;
}

export interface ConnectionRequestOutcome {
  at: number;
  operation: string;
  success: boolean;
  latencyMs: number;
  detail?: string;
  error?: string;
}

export interface ConnectionHealthState extends ConnectionHealthSource {
  status: ConnectionHealthStatus;
  lastRequestAt: number | null;
  lastLatencyMs: number | null;
  lastOperation: string | null;
  lastSuccess: ConnectionRequestOutcome | null;
  lastError: ConnectionRequestOutcome | null;
  recentRequests: ConnectionRequestOutcome[];
  socketState: ConnectionSocketState | null;
  lastTransitionAt: number | null;
  currentDetail: string | null;
}

export interface ConnectionHealthSnapshot {
  version: number;
  sources: ConnectionHealthState[];
}

export interface ConnectionRequestReport {
  operation: string;
  success: boolean;
  latencyMs: number;
  detail?: string;
  error?: unknown;
}

interface ConnectionHealthOptions {
  now?: () => number;
  clock?: () => number;
  requestStatusTtlMs?: number;
}

export const GLOOM_CLOUD_HTTP_CONNECTION_ID = "gloom-cloud-http";
export const GLOOM_CLOUD_SOCKET_CONNECTION_ID = "gloom-cloud-socket";

const MAX_RECENT_REQUESTS = 20;
const DEFAULT_REQUEST_STATUS_TTL_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function socketStatus(state: ConnectionSocketState): ConnectionHealthStatus {
  if (state === "open") return "connected";
  if (state === "connecting") return "connecting";
  if (state === "closed") return "disconnected";
  if (state === "error") return "error";
  return "idle";
}

function cloneState(state: ConnectionHealthState): ConnectionHealthState {
  return {
    ...state,
    lastSuccess: state.lastSuccess ? { ...state.lastSuccess } : null,
    lastError: state.lastError ? { ...state.lastError } : null,
    recentRequests: state.recentRequests.map((request) => ({ ...request })),
  };
}

export class ConnectionHealthRegistry {
  private readonly sources = new Map<string, ConnectionHealthState>();
  private readonly registrations = new Map<string, symbol>();
  private readonly listeners = new Set<() => void>();
  private readonly external = new Map<string, ConnectionHealthState[]>();
  private readonly now: () => number;
  private readonly clock: () => number;
  private readonly requestStatusTtlMs: number;
  private version = 0;

  constructor(options: ConnectionHealthOptions = {}) {
    this.now = options.now ?? Date.now;
    this.clock = options.clock ?? (() => performance.now());
    this.requestStatusTtlMs = options.requestStatusTtlMs ?? DEFAULT_REQUEST_STATUS_TTL_MS;
  }

  registerSource(source: ConnectionHealthSource): () => void {
    const registration = Symbol(source.id);
    this.registrations.set(source.id, registration);
    this.sources.set(source.id, {
      ...source,
      priority: source.priority ?? 1000,
      status: "idle",
      lastRequestAt: null,
      lastLatencyMs: null,
      lastOperation: null,
      lastSuccess: null,
      lastError: null,
      recentRequests: [],
      socketState: source.kind === "websocket" ? "idle" : null,
      lastTransitionAt: null,
      currentDetail: source.detail ?? null,
    });

    this.emit();

    return () => {
      if (this.registrations.get(source.id) !== registration) return;
      this.registrations.delete(source.id);
      this.sources.delete(source.id);
      this.emit();
    };
  }

  reportRequest(sourceId: string, report: ConnectionRequestReport): void {
    if (!this.sources.has(sourceId)) return;
    this.applyRequest(sourceId, report);
    this.emit();
  }

  async track<T>(sourceId: string, operation: string, request: () => Promise<T>): Promise<T> {
    const registration = this.registrations.get(sourceId);
    const startedAt = this.clock();
    try {
      const result = await request();
      this.reportTrackedRequest(sourceId, registration, {
        operation,
        success: true,
        latencyMs: this.clock() - startedAt,
      });
      return result;
    } catch (error) {
      this.reportTrackedRequest(sourceId, registration, {
        operation,
        success: false,
        latencyMs: this.clock() - startedAt,
        error,
      });
      throw error;
    }
  }

  reportSocketState(sourceId: string, state: ConnectionSocketState, detail?: string): void {
    if (!this.sources.has(sourceId)) return;
    this.applySocketState(sourceId, state, detail);
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasSource(sourceId: string): boolean {
    return this.sources.has(sourceId);
  }

  getSnapshot(): ConnectionHealthSnapshot {
    const sources = new Map(
      [...this.sources.values()].map((source) => [source.id, this.snapshotState(source)]),
    );
    for (const external of this.external.values()) {
      for (const source of external) sources.set(source.id, this.snapshotState(source));
    }
    return {
      version: this.version,
      sources: [...sources.values()].sort((left, right) => (
        (left.priority ?? 1000) - (right.priority ?? 1000)
        || left.name.localeCompare(right.name)
      )),
    };
  }

  replaceExternalSnapshot(namespace: string, snapshot: ConnectionHealthSnapshot): void {
    this.external.set(namespace, snapshot.sources.map(cloneState));
    this.emit();
  }

  clearExternalSnapshot(namespace: string): void {
    if (!this.external.delete(namespace)) return;
    this.emit();
  }

  private reportTrackedRequest(
    sourceId: string,
    registration: symbol | undefined,
    report: ConnectionRequestReport,
  ): void {
    if (!registration || this.registrations.get(sourceId) !== registration) return;
    this.applyRequest(sourceId, report);
    this.emit();
  }

  private snapshotState(source: ConnectionHealthState): ConnectionHealthState {
    const snapshot = cloneState(source);
    if (
      snapshot.socketState === null
      && snapshot.lastRequestAt !== null
      && this.now() - snapshot.lastRequestAt >= this.requestStatusTtlMs
    ) {
      snapshot.status = "idle";
    }
    return snapshot;
  }

  private applyRequest(sourceId: string, report: ConnectionRequestReport): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    const latencyMs = Number.isFinite(report.latencyMs) ? Math.max(0, report.latencyMs) : 0;
    const outcome: ConnectionRequestOutcome = {
      at: this.now(),
      operation: report.operation,
      success: report.success,
      latencyMs,
      ...(report.detail ? { detail: report.detail } : {}),
      ...(!report.success && report.error !== undefined ? { error: errorMessage(report.error) } : {}),
    };
    this.sources.set(sourceId, {
      ...source,
      status: report.success ? "connected" : "error",
      lastRequestAt: outcome.at,
      lastLatencyMs: latencyMs,
      lastOperation: report.operation,
      lastSuccess: report.success ? outcome : source.lastSuccess,
      lastError: report.success ? source.lastError : outcome,
      recentRequests: [outcome, ...source.recentRequests].slice(0, MAX_RECENT_REQUESTS),
      currentDetail: report.success
        ? (report.detail ?? source.detail ?? null)
        : (outcome.error ?? report.detail ?? source.detail ?? null),
    });
  }

  private applySocketState(sourceId: string, state: ConnectionSocketState, detail?: string): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    this.sources.set(sourceId, {
      ...source,
      status: socketStatus(state),
      socketState: state,
      lastTransitionAt: this.now(),
      currentDetail: detail ?? source.detail ?? null,
    });
  }

  private emit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

export function registerGloomCloudConnectionSources(health: ConnectionHealthRegistry): () => void {
  const disposers = [
    health.registerSource({
      id: GLOOM_CLOUD_HTTP_CONNECTION_ID,
      name: "Gloom Cloud HTTP",
      kind: "api",
      ownerId: "gloomberb-cloud",
      priority: 0,
      detail: "api.gloom.sh",
    }),
    health.registerSource({
      id: GLOOM_CLOUD_SOCKET_CONNECTION_ID,
      name: "Gloom Cloud Stream",
      kind: "websocket",
      ownerId: "gloomberb-cloud",
      priority: 1,
      detail: "api.gloom.sh/cloud/ws",
    }),
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

export const connectionHealth = new ConnectionHealthRegistry();

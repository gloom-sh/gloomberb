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
}

type PendingEvent =
  | { type: "request"; sourceId: string; report: ConnectionRequestReport }
  | { type: "socket"; sourceId: string; state: ConnectionSocketState; detail?: string };

export const GLOOM_CLOUD_HTTP_CONNECTION_ID = "gloom-cloud-http";
export const GLOOM_CLOUD_SOCKET_CONNECTION_ID = "gloom-cloud-socket";

const MAX_RECENT_REQUESTS = 20;
const MAX_PENDING_EVENTS = 200;

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
  private readonly pending: PendingEvent[] = [];
  private readonly external = new Map<string, ConnectionHealthState[]>();
  private readonly now: () => number;
  private readonly clock: () => number;
  private version = 0;

  constructor(options: ConnectionHealthOptions = {}) {
    this.now = options.now ?? Date.now;
    this.clock = options.clock ?? (() => performance.now());
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

    const queued = this.pending.filter((event) => event.sourceId === source.id);
    for (let index = this.pending.length - 1; index >= 0; index--) {
      if (this.pending[index]?.sourceId === source.id) this.pending.splice(index, 1);
    }
    for (const event of queued) {
      if (event.type === "request") this.applyRequest(source.id, event.report);
      else this.applySocketState(source.id, event.state, event.detail);
    }
    this.emit();

    return () => {
      if (this.registrations.get(source.id) !== registration) return;
      this.registrations.delete(source.id);
      this.sources.delete(source.id);
      this.emit();
    };
  }

  reportRequest(sourceId: string, report: ConnectionRequestReport): void {
    if (!this.sources.has(sourceId)) {
      this.queue({ type: "request", sourceId, report: { ...report } });
      return;
    }
    this.applyRequest(sourceId, report);
    this.emit();
  }

  async track<T>(sourceId: string, operation: string, request: () => Promise<T>): Promise<T> {
    const startedAt = this.clock();
    try {
      const result = await request();
      this.reportRequest(sourceId, {
        operation,
        success: true,
        latencyMs: this.clock() - startedAt,
      });
      return result;
    } catch (error) {
      this.reportRequest(sourceId, {
        operation,
        success: false,
        latencyMs: this.clock() - startedAt,
        error,
      });
      throw error;
    }
  }

  reportSocketState(sourceId: string, state: ConnectionSocketState, detail?: string): void {
    if (!this.sources.has(sourceId)) {
      this.queue({ type: "socket", sourceId, state, detail });
      return;
    }
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
    const local = [...this.sources.values()].map(cloneState);
    const external = [...this.external.values()].flatMap((states) => states.map(cloneState));
    return {
      version: this.version,
      sources: [...local, ...external].sort((left, right) => (
        (left.priority ?? 1000) - (right.priority ?? 1000)
        || left.name.localeCompare(right.name)
      )),
    };
  }

  replaceExternalSnapshot(namespace: string, snapshot: ConnectionHealthSnapshot): void {
    this.external.set(namespace, snapshot.sources.map((source) => ({
      ...cloneState(source),
      id: `${namespace}:${source.id}`,
      currentDetail: source.currentDetail ?? `Reported by ${namespace}`,
    })));
    this.emit();
  }

  clearExternalSnapshot(namespace: string): void {
    if (!this.external.delete(namespace)) return;
    this.emit();
  }

  private queue(event: PendingEvent): void {
    this.pending.push(event);
    if (this.pending.length > MAX_PENDING_EVENTS) {
      this.pending.splice(0, this.pending.length - MAX_PENDING_EVENTS);
    }
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

export const connectionHealth = new ConnectionHealthRegistry();

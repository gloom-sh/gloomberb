import { stableStringify } from "../../../../remote/revision";
import type {
  RemoteControlRequest,
  RemoteControlResponse,
  RemoteJsonPatchOperation,
} from "../../../../remote/types";
import type { JsonValue, ToolResultStatus } from "./protocol";

export type InProcessRemoteControlHandler = (
  request: RemoteControlRequest,
) => Promise<RemoteControlResponse>;

interface UndoResourceSnapshot {
  resource: string;
  value: JsonValue;
}

interface StoredUndoResource extends UndoResourceSnapshot {
  expectedRev: string;
}

interface StoredUndo {
  createdAt: number;
  resources: StoredUndoResource[];
}

export interface PreparedUndo {
  resources: UndoResourceSnapshot[];
}

export interface AppliedUndo {
  status: Extract<ToolResultStatus, "ok" | "error" | "denied" | "cancelled">;
  elapsedMs: number;
  note?: string;
}

export interface ASKGUndoManagerOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
  tokenFactory?: () => string;
}

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_TTL_MS = 10 * 60_000;

const LAYOUT_UNDO_OPERATIONS = new Set([
  "pane.setSetting",
  "layout.gridlock",
  "layout.closeFloating",
  "layout.placePane",
  "layout.setGrid",
]);

function shortReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 240) || "Unknown error.";
}

function normalizeJson(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => normalizeJson(entry, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = normalizeJson((value as Record<string, unknown>)[key], seen);
  }
  seen.delete(value);
  return result;
}

function paneStateResource(args: Record<string, JsonValue>): string | null {
  const paneId = args.paneId;
  return typeof paneId === "string" && paneId.length > 0
    ? `app://pane-state/${encodeURIComponent(paneId)}`
    : null;
}

function resourcesForOperation(
  operation: string,
  args: Record<string, JsonValue>,
): string[] | null {
  if (operation === "pane.setState") {
    const resource = paneStateResource(args);
    return resource ? [resource] : null;
  }
  if (LAYOUT_UNDO_OPERATIONS.has(operation)) return ["app://layout/current"];
  return null;
}

function pointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function replacementPatch(current: JsonValue, target: JsonValue): RemoteJsonPatchOperation[] | null {
  if (!isObject(current) || !isObject(target)) return null;
  const patch: RemoteJsonPatchOperation[] = [];
  const currentKeys = Object.keys(current).sort();
  const targetKeys = Object.keys(target).sort();
  for (const key of currentKeys) {
    if (!(key in target)) patch.push({ op: "remove", path: `/${pointerSegment(key)}` });
  }
  for (const key of targetKeys) {
    const path = `/${pointerSegment(key)}`;
    if (!(key in current)) {
      patch.push({ op: "add", path, value: target[key] });
    } else if (stableStringify(current[key]) !== stableStringify(target[key])) {
      patch.push({ op: "replace", path, value: target[key] });
    }
  }
  return patch;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Undo was cancelled.");
}

function randomToken(): string {
  return globalThis.crypto.randomUUID();
}

export class ASKGUndoManager {
  private readonly entries = new Map<string, StoredUndo>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly tokenFactory: () => string;

  constructor(
    private readonly remoteHandler: InProcessRemoteControlHandler,
    options: ASKGUndoManagerOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? randomToken;
  }

  async prepare(
    operation: string,
    args: Record<string, JsonValue>,
    signal?: AbortSignal,
  ): Promise<PreparedUndo | null> {
    const resources = resourcesForOperation(operation, args);
    if (!resources) return null;
    const snapshots: UndoResourceSnapshot[] = [];
    for (const resource of resources) {
      throwIfCancelled(signal);
      const response = await this.remoteHandler({ type: "get", resource });
      if (!response.ok) throw new Error(response.error.message);
      snapshots.push({ resource, value: normalizeJson(response.data) });
    }
    return { resources: snapshots };
  }

  async commit(prepared: PreparedUndo, signal?: AbortSignal): Promise<string | null> {
    const resources: StoredUndoResource[] = [];
    let changed = false;
    for (const before of prepared.resources) {
      throwIfCancelled(signal);
      const response = await this.remoteHandler({ type: "get", resource: before.resource });
      if (!response.ok) throw new Error(response.error.message);
      if (!response.rev) throw new Error(`Resource "${before.resource}" did not return a revision.`);
      const current = normalizeJson(response.data);
      if (stableStringify(current) !== stableStringify(before.value)) changed = true;
      resources.push({ ...before, expectedRev: response.rev });
    }
    if (!changed) return null;

    this.prune();
    const token = this.tokenFactory();
    this.entries.set(token, { createdAt: this.now(), resources });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    return token;
  }

  async undo(token: string, signal?: AbortSignal): Promise<AppliedUndo> {
    const startedAt = this.now();
    this.prune();
    const entry = this.entries.get(token);
    if (!entry) {
      return {
        status: "denied",
        elapsedMs: Math.max(0, this.now() - startedAt),
        note: "Undo token is unknown or expired.",
      };
    }

    try {
      const currentResources: Array<{
        snapshot: StoredUndoResource;
        value: JsonValue;
        rev: string;
        patch: RemoteJsonPatchOperation[];
      }> = [];
      for (const snapshot of entry.resources) {
        throwIfCancelled(signal);
        const response = await this.remoteHandler({ type: "get", resource: snapshot.resource });
        if (!response.ok) throw new Error(response.error.message);
        if (!response.rev) throw new Error(`Resource "${snapshot.resource}" did not return a revision.`);
        if (response.rev !== snapshot.expectedRev) {
          return {
            status: "denied",
            elapsedMs: Math.max(0, this.now() - startedAt),
            note: `Cannot undo because "${snapshot.resource}" changed after the tool call.`,
          };
        }
        const value = normalizeJson(response.data);
        const patch = replacementPatch(value, snapshot.value);
        if (!patch) {
          return {
            status: "denied",
            elapsedMs: Math.max(0, this.now() - startedAt),
            note: `Cannot safely restore non-object resource "${snapshot.resource}".`,
          };
        }
        currentResources.push({ snapshot, value, rev: response.rev, patch });
      }

      for (const current of currentResources) {
        throwIfCancelled(signal);
        if (current.patch.length === 0) continue;
        const response = await this.remoteHandler({
          type: "patch",
          resource: current.snapshot.resource,
          patch: current.patch,
          expectRev: current.rev,
        });
        if (!response.ok) throw new Error(response.error.message);
      }
      this.entries.delete(token);
      return {
        status: "ok",
        elapsedMs: Math.max(0, this.now() - startedAt),
      };
    } catch (error) {
      if (signal?.aborted) {
        return {
          status: "cancelled",
          elapsedMs: Math.max(0, this.now() - startedAt),
          note: "Undo was cancelled.",
        };
      }
      return {
        status: "error",
        elapsedMs: Math.max(0, this.now() - startedAt),
        note: shortReason(error),
      };
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [token, entry] of this.entries) {
      if (entry.createdAt < cutoff) this.entries.delete(token);
    }
  }
}

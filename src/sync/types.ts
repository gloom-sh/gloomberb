import type { Dispatch } from "react";
import type { AppAction, AppState } from "../core/state/app/state";
import type { AppTickerRepositoryPort } from "../core/app-service-ports";

export const SYNC_SNAPSHOT_SCHEMA_VERSION = 1;

interface SyncContributorPayload {
  schemaVersion: number;
  updatedAt: string;
  payload: unknown;
}

export interface SyncSnapshot {
  schemaVersion: typeof SYNC_SNAPSHOT_SCHEMA_VERSION;
  appId: "gloomberb";
  clientId: string;
  createdAt: string;
  appVersion?: string;
  contributors: Record<string, SyncContributorPayload>;
}

/**
 * What this device remembers about its own copy of one contributor's data
 * between syncs, kept across launches: when it last edited it, or which cloud
 * copy it took. Never sent anywhere.
 */
interface SyncContributorMemo {
  get(): unknown;
  set(value: unknown): void;
}

interface SyncCollectContext {
  state: AppState;
  /** The payload this device last pushed for this contributor, or null when it never synced. */
  baselinePayload?: unknown;
  memo?: SyncContributorMemo;
}

interface SyncObserveContext {
  state: AppState;
  baselinePayload: unknown;
  memo: SyncContributorMemo;
  /** True for the first look after the app started: a change seen then was made while it was closed. */
  launch: boolean;
}

interface SyncApplyContext {
  snapshot: SyncSnapshot;
  baselineState: AppState;
  /**
   * The payload this device last pushed for this contributor, or null when it
   * never synced. Anything that differs from it is local work the cloud has
   * never seen (CLI edits, offline edits) and must survive the pull.
   */
  baselinePayload: unknown;
  state: AppState;
  getState: () => AppState;
  isCurrent: () => boolean;
  dispatch: Dispatch<AppAction>;
  tickerRepository: AppTickerRepositoryPort;
  memo?: SyncContributorMemo;
}

export interface SyncContributor {
  id: string;
  schemaVersion: number;
  collect(context: SyncCollectContext): unknown | Promise<unknown>;
  apply?(payload: unknown, context: SyncApplyContext): void | Promise<void>;
  /**
   * Called before every sync attempt and shortly after local changes, online
   * or not, so an edit can be dated when it happens rather than when the
   * network is next reachable.
   */
  observe?(context: SyncObserveContext): void;
}

export interface SyncSnapshotResponse {
  snapshot: SyncSnapshot | null;
  revision: number | null;
  updatedAt: string | null;
  settings?: SyncSettings;
}

interface SyncPushResult {
  revision: number;
  updatedAt: string;
  settings?: SyncSettings;
}

export interface SyncTransport {
  id: string;
  isAvailable(): boolean;
  pullSnapshot(): Promise<SyncSnapshotResponse>;
  /**
   * `baseRevision` is the stored revision the snapshot was merged with (0 when
   * there was none). A transport that can refuse a write made against an older
   * revision throws `SyncRevisionConflictError`, and the controller pulls again.
   */
  pushSnapshot(snapshot: SyncSnapshot, options?: { baseRevision?: number | null }): Promise<SyncPushResult>;
}

/** Another device wrote since this one pulled; its push would have replaced that write. */
export class SyncRevisionConflictError extends Error {
  constructor(message = "The synced copy changed since it was pulled.") {
    super(message);
    this.name = "SyncRevisionConflictError";
  }
}

export interface SyncSettings {
  syncEnabled: boolean;
  weeklyRoundupEnabled: boolean;
  positionAlertsEnabled: boolean;
  selectedSharedPortfolioId?: string | null;
  lastSyncAt?: string | null;
  lastRoundupEmailAt?: string | null;
}

/** Durable record of the payloads this device last pushed to the cloud. */
export interface SyncBaselineStore {
  load(): Record<string, unknown> | null;
  save(payloads: Record<string, unknown>): void;
  /** Contributor memos by contributor id; see `SyncContributorMemo`. */
  loadMemos?(): Record<string, unknown> | null;
  saveMemos?(memos: Record<string, unknown>): void;
}

export interface RegisteredSyncContributor {
  pluginId: string;
  contributor: SyncContributor;
}

export interface RegisteredSyncTransport {
  pluginId: string;
  transport: SyncTransport;
}

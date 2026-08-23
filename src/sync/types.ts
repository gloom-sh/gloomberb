import type { Dispatch } from "react";
import type { AppAction, AppState } from "../core/state/app/state";
import type { AppTickerRepositoryPort } from "../core/app-service-ports";

export const SYNC_SNAPSHOT_SCHEMA_VERSION = 1;

export interface SyncContributorPayload {
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

export interface SyncCollectContext {
  state: AppState;
}

export interface SyncApplyContext {
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
}

export interface SyncContributor {
  id: string;
  schemaVersion: number;
  collect(context: SyncCollectContext): unknown | Promise<unknown>;
  apply?(payload: unknown, context: SyncApplyContext): void | Promise<void>;
}

export interface SyncSnapshotResponse {
  snapshot: SyncSnapshot | null;
  revision: number | null;
  updatedAt: string | null;
  settings?: SyncSettings;
}

export interface SyncPushResult {
  revision: number;
  updatedAt: string;
  settings?: SyncSettings;
}

export interface SyncTransport {
  id: string;
  isAvailable(): boolean;
  pullSnapshot(): Promise<SyncSnapshotResponse>;
  pushSnapshot(snapshot: SyncSnapshot, options?: { baseRevision?: number | null }): Promise<SyncPushResult>;
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
}

export interface RegisteredSyncContributor {
  pluginId: string;
  contributor: SyncContributor;
}

export interface RegisteredSyncTransport {
  pluginId: string;
  transport: SyncTransport;
}

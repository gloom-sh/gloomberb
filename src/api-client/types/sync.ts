import type { SyncSettings, SyncSnapshot } from "../../sync/types";

export interface CloudSyncSnapshotResponse {
  snapshot: SyncSnapshot | null;
  revision: number | null;
  updatedAt: string | null;
  settings: SyncSettings;
}

export interface CloudSyncPushResponse {
  revision: number;
  updatedAt: string;
  settings: SyncSettings;
}

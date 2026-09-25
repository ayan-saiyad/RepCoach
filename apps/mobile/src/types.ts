import type { RepEvent } from "./lib/rep-engine";

export type UploadState = "pending" | "uploading" | "synced" | "retrying" | "offline";

export interface LocalRep {
  event: RepEvent;
  idempotencyKey: string;
  uploadState: UploadState;
  serverScore?: number;
  serverFeedback?: string;
}

export type SyncState = "idle" | "connecting" | "synced" | "offline" | "finishing" | "finished";

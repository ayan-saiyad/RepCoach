import * as SQLite from "expo-sqlite";

import type { RepEvent } from "./rep-engine";

/**
 * Completed rep events are compact, pose-derived measurements. They are kept
 * locally until the API acknowledges their idempotency key; raw camera video
 * is never placed in this store.
 */
export interface PendingRepUploadRecord {
  sessionId: string;
  event: RepEvent;
  idempotencyKey: string;
  createdAt: string;
}

type PendingRepUploadRow = {
  session_id: string;
  event_json: string;
  idempotency_key: string;
  created_at: string;
};

let databasePromise: ReturnType<typeof SQLite.openDatabaseAsync> | null = null;
let schemaPromise: Promise<void> | null = null;

async function database(): Promise<Awaited<ReturnType<typeof SQLite.openDatabaseAsync>>> {
  if (!databasePromise) databasePromise = SQLite.openDatabaseAsync("repcoach.sqlite");

  const connection = await databasePromise;
  if (!schemaPromise) {
    schemaPromise = connection.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS pending_rep_uploads (
        idempotency_key TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_rep_uploads_created_at
        ON pending_rep_uploads (created_at);
    `);
  }
  await schemaPromise;
  return connection;
}

function isRepEvent(value: unknown): value is RepEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RepEvent>;
  return (
    typeof candidate.repNumber === "number" &&
    typeof candidate.completedAtMs === "number" &&
    typeof candidate.features === "object" &&
    candidate.features !== null &&
    typeof candidate.assessment === "object" &&
    candidate.assessment !== null
  );
}

function parseRow(row: PendingRepUploadRow): PendingRepUploadRecord | null {
  try {
    const event: unknown = JSON.parse(row.event_json);
    if (!isRepEvent(event)) return null;
    return {
      sessionId: row.session_id,
      event,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

/** Stores a rep before a network attempt. Duplicate calls preserve its original payload. */
export async function savePendingRepUpload(record: PendingRepUploadRecord): Promise<void> {
  const connection = await database();
  await connection.runAsync(
    `INSERT OR IGNORE INTO pending_rep_uploads
      (idempotency_key, session_id, event_json, created_at)
      VALUES (?, ?, ?, ?)`,
    record.idempotencyKey,
    record.sessionId,
    JSON.stringify(record.event),
    record.createdAt,
  );
}

/** Returns unacknowledged work in creation order for safe, idempotent retries. */
export async function readPendingRepUploads(): Promise<PendingRepUploadRecord[]> {
  const connection = await database();
  const rows = await connection.getAllAsync<PendingRepUploadRow>(
    `SELECT session_id, event_json, idempotency_key, created_at
      FROM pending_rep_uploads
      ORDER BY created_at ASC`,
  );
  return rows.flatMap((row) => {
    const parsed = parseRow(row);
    return parsed ? [parsed] : [];
  });
}

/** Removes a record only after the server has acknowledged that idempotency key. */
export async function removePendingRepUpload(idempotencyKey: string): Promise<void> {
  const connection = await database();
  await connection.runAsync(
    "DELETE FROM pending_rep_uploads WHERE idempotency_key = ?",
    idempotencyKey,
  );
}

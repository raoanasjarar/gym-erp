import type { SyncConflict, SyncOperation, SyncRecord, SyncStatus } from "@gym-erp/shared-types";

export * from "./sync-queue.js";

export function createSyncRecord(input: {
  id: string;
  gymId: string;
  entityType: string;
  entityId: string;
  operation: SyncOperation;
  deviceId: string;
  version: number;
  payload: unknown;
  now?: string;
}): SyncRecord {
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id,
    gymId: input.gymId,
    entityType: input.entityType,
    entityId: input.entityId,
    operation: input.operation,
    deviceId: input.deviceId,
    version: input.version,
    payloadJson: JSON.stringify(input.payload),
    timestamp: now,
    createdAt: now,
    updatedAt: now,
    status: "pending",
    retryCount: 0,
    errorMessage: null,
  };
}

export function markSyncFailure(record: SyncRecord, message: string, now = new Date().toISOString()): SyncRecord {
  return {
    ...record,
    status: "error",
    retryCount: record.retryCount + 1,
    errorMessage: message,
    updatedAt: now,
  };
}

export function markSyncSuccess(record: SyncRecord, now = new Date().toISOString()): SyncRecord {
  return { ...record, status: "synced", errorMessage: null, updatedAt: now };
}

export function shouldRetry(record: SyncRecord, maxRetries = 12): boolean {
  return record.status === "error" && record.retryCount < maxRetries;
}

export type ConflictDecision =
  | { kind: "auto-remote" }
  | { kind: "auto-local" }
  | { kind: "needs-admin"; conflict: Omit<SyncConflict, "id" | "createdAt"> };

const SENSITIVE_ENTITIES = new Set(["payments", "memberships", "members", "expenses"]);

export function resolveIncoming(local: SyncRecord | null, incoming: SyncRecord): ConflictDecision {
  const localVersion = Number.isFinite(local?.version) ? Number(local!.version) : 0;

  if (!local || localVersion < incoming.version) return { kind: "auto-remote" };
  if (localVersion > incoming.version) return { kind: "auto-local" };
  if (local.payloadJson === incoming.payloadJson) return { kind: "auto-local" };
  if (new Date(incoming.timestamp).getTime() > new Date(local.timestamp).getTime() && !SENSITIVE_ENTITIES.has(incoming.entityType)) {
    return { kind: "auto-remote" };
  }
  return {
    kind: "needs-admin",
    conflict: {
      gymId: incoming.gymId,
      entityType: incoming.entityType,
      entityId: incoming.entityId,
      localVersion,
      remoteVersion: incoming.version,
      localPayloadJson: local.payloadJson,
      remotePayloadJson: incoming.payloadJson,
      localDeviceId: local.deviceId,
      remoteDeviceId: incoming.deviceId,
      resolved: false,
      resolution: null,
      resolvedAt: null,
      resolvedByUserId: null,
    },
  };
}

export function syncIndicator(input: {
  pending: number;
  errors: number;
  conflicts: number;
  online: boolean;
  inFlight: boolean;
  lastSuccessAt: string | null;
}): { indicator: SyncStatus | "offline" | "synchronizing"; userMessage: string } {
  if (input.inFlight) {
    return { indicator: "synchronizing", userMessage: "Synchronizing…" };
  }
  if (!input.online && input.pending > 0) {
    return {
      indicator: "offline",
      userMessage: `${input.pending} changes waiting to synchronize`,
    };
  }
  if (input.errors > 0 || input.conflicts > 0) {
    return {
      indicator: "error",
      userMessage: "Some changes need attention. Your data is saved on this device.",
    };
  }
  if (input.pending > 0) {
    return { indicator: "pending", userMessage: `${input.pending} changes waiting to synchronize` };
  }
  return { indicator: "synced", userMessage: "All changes are up to date on this device." };
}

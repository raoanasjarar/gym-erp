import type { SqlDatabase } from "@gym-erp/database";
import type { SyncRecord, SyncConflict, SyncOperation, SyncStatus } from "@gym-erp/shared-types";
import { createSyncRecord, markSyncFailure, markSyncSuccess, resolveIncoming } from "@gym-erp/sync-engine";

export interface SyncItem {
  syncRecordId: string;
  entityType: string;
  entityId: string;
  operation: SyncOperation;
  status: SyncStatus;
  retryCount: number;
  errorMessage: string | null;
  timestamp: string;
}

export interface SyncQueueOptions {
  /** Limit the number of items processed in a single sync batch */
  batchSize?: number;
  /** Maximum number of retry attempts for failed items */
  maxRetries?: number;
  /**
   * Transport used to deliver records to another node (e.g. the desktop hub).
   * When omitted, records are committed locally only — correct for the desktop
   * hub itself, which is the authoritative store devices pull from.
   */
  transport?: SyncTransport;
}

export type SyncTransport = (records: SyncRecord[]) => Promise<{
  accepted: string[];
  rejected: Array<{ syncRecordId: string; reason: string }>;
}>;

export interface SyncQueueStats {
  processed: number;
  synced: number;
  errors: number;
  conflicts: number;
}

/**
 * Process the pending sync queue. Without a transport this acknowledges local
 * commits (the desktop hub is authoritative). With a transport it batches the
 * records to the remote node and marks each accepted record as synced.
 */
export async function processSyncQueue(
  db: SqlDatabase,
  options: SyncQueueOptions = {},
): Promise<SyncQueueStats> {
  const batchSize = options.batchSize ?? 100;
  const maxRetries = options.maxRetries ?? 12;

  const items = db.all<SyncItem & { gym_id: string; device_id: string; version: number; payload_json: string }>(
    `SELECT id as "syncRecordId", gym_id, entity_type as "entityType", entity_id as "entityId",
            operation, device_id, version, payload_json, status, retry_count as "retryCount",
            error_message as "errorMessage", timestamp
     FROM sync_records WHERE status IN ('pending', 'error') AND retry_count < ?
     ORDER BY timestamp ASC LIMIT ?`,
    [maxRetries, batchSize],
  );

  const stats: SyncQueueStats = { processed: 0, synced: 0, errors: 0, conflicts: 0 };
  const now = new Date().toISOString();

  if (!options.transport) {
    for (const item of items) {
      db.run(`UPDATE sync_records SET status = 'synced', updated_at = ? WHERE id = ?`, [now, item.syncRecordId]);
      stats.processed += 1;
      stats.synced += 1;
    }
    return stats;
  }

  const records: SyncRecord[] = items.map((item) => ({
    id: item.syncRecordId,
    gymId: item.gym_id,
    entityType: item.entityType,
    entityId: item.entityId,
    operation: item.operation,
    deviceId: item.device_id,
    version: item.version,
    payloadJson: item.payload_json,
    timestamp: item.timestamp,
    createdAt: item.timestamp,
    updatedAt: now,
    status: item.status,
    retryCount: item.retryCount,
    errorMessage: item.errorMessage,
  }));

  if (records.length === 0) return stats;

  let result: Awaited<ReturnType<SyncTransport>>;
  try {
    result = await options.transport(records);
  } catch (error) {
    // Transport itself failed (hub offline): bump retries, keep queue intact.
    for (const record of records) {
      const failed = markSyncFailure(record, error instanceof Error ? error.message : "Sync failed", now);
      db.run(
        `UPDATE sync_records SET status = ?, retry_count = ?, error_message = ?, updated_at = ? WHERE id = ?`,
        [failed.status, failed.retryCount, failed.errorMessage, failed.updatedAt, record.id],
      );
    }
    return { processed: records.length, synced: 0, errors: records.length, conflicts: 0 };
  }

  const accepted = new Set(result.accepted);
  for (const record of records) {
    stats.processed += 1;
    if (accepted.has(record.id)) {
      const synced = markSyncSuccess(record, now);
      db.run(`UPDATE sync_records SET status = 'synced', error_message = NULL, updated_at = ? WHERE id = ?`, [
        synced.updatedAt,
        record.id,
      ]);
      stats.synced += 1;
    } else {
      const rejection = result.rejected.find((entry) => entry.syncRecordId === record.id);
      const failed = markSyncFailure(record, rejection?.reason ?? "Rejected by hub", now);
      db.run(
        `UPDATE sync_records SET status = ?, retry_count = ?, error_message = ?, updated_at = ? WHERE id = ?`,
        [failed.status, failed.retryCount, failed.errorMessage, failed.updatedAt, record.id],
      );
      stats.errors += 1;
    }
  }
  return stats;
}

/**
 * Get the count of pending sync items by status
 */
export function countSyncItemsByStatus(db: SqlDatabase): {
  pending: number;
  inProgress: number;
  synced: number;
  error: number;
  conflict: number;
} {
  const counts = db.all<{ status: string; c: number }>(
    "SELECT status, COUNT(*) as c FROM sync_records GROUP BY status",
  );

  const result = {
    pending: 0,
    inProgress: 0,
    synced: 0,
    error: 0,
    conflict: 0,
  };

  for (const row of counts) {
    if (row.status in result) {
      (result as Record<string, number>)[row.status] = row.c;
    }
  }

  return result;
}

/**
 * Mark a sync record as synced
 */
export function markRecordSynced(
  db: SqlDatabase,
  syncRecordId: string,
  now = new Date().toISOString(),
): void {
  db.run(
    `UPDATE sync_records SET status = 'synced', updated_at = ? WHERE id = ?`,
    [now, syncRecordId],
  );
}

/**
 * Add a sync record for an update operation
 */
export function enqueueUpdate(
  db: SqlDatabase,
  input: {
    gymId: string;
    entityType: string;
    entityId: string;
    deviceId: string;
    version: number;
    payload: unknown;
    idempotencyKey?: string;
  },
): void {
  const record = createSyncRecord({
    id: newId(),
    gymId: input.gymId,
    entityType: input.entityType,
    entityId: input.entityId,
    operation: "update",
    deviceId: input.deviceId,
    version: input.version,
    payload: input.payload,
    now: new Date().toISOString(),
  });

  const idempotencyKey = input.idempotencyKey ?? null;

  db.run(
    `INSERT INTO sync_records (
      id, gym_id, entity_type, entity_id, operation, device_id, version, payload_json,
      timestamp, created_at, updated_at, status, retry_count, error_message, idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.gymId,
      record.entityType,
      record.entityId,
      record.operation,
      record.deviceId,
      record.version,
      record.payloadJson,
      record.timestamp,
      record.createdAt,
      record.updatedAt,
      record.status,
      record.retryCount,
      record.errorMessage,
      idempotencyKey,
    ],
  );

  db.run(
    `INSERT INTO sync_queue (id, sync_record_id, priority, available_at, created_at) VALUES (?, ?, 100, ?, ?)`,
    [newId(), record.id, record.createdAt, record.createdAt],
  );
}

/**
 * Generate a new unique ID for sync records
 */
export function newId(): string {
  return crypto.randomUUID();
}

/**
 * Create a sync record for delete operation
 */
export function enqueueDelete(
  db: SqlDatabase,
  input: {
    gymId: string;
    entityType: string;
    entityId: string;
    deviceId: string;
    version: number;
  },
): void {
  const record = createSyncRecord({
    id: newId(),
    gymId: input.gymId,
    entityType: input.entityType,
    entityId: input.entityId,
    operation: "delete",
    deviceId: input.deviceId,
    version: input.version,
    payload: {},
  });

  db.run(
    `INSERT INTO sync_records (
      id, gym_id, entity_type, entity_id, operation, device_id, version, payload_json,
      timestamp, created_at, updated_at, status, retry_count, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.gymId,
      record.entityType,
      record.entityId,
      record.operation,
      record.deviceId,
      record.version,
      record.payloadJson,
      record.timestamp,
      record.createdAt,
      record.updatedAt,
      record.status,
      record.retryCount,
      record.errorMessage,
    ],
  );

  db.run(
    `INSERT INTO sync_queue (id, sync_record_id, priority, available_at, created_at) VALUES (?, ?, 100, ?, ?)`,
    [newId(), record.id, record.createdAt, record.createdAt],
  );
}

// ---------------------------------------------------------------------------
// Hub side: applying incoming records and serving pulls
// ---------------------------------------------------------------------------

/** Wire format for records exchanged between devices and the hub. */
export interface SyncRecordDTO {
  id: string;
  gymId: string;
  entityType: string;
  entityId: string;
  operation: SyncOperation;
  deviceId: string;
  version: number;
  payloadJson: string;
  timestamp: string;
}

const ENTITY_TABLES: Record<string, string> = {
  members: "members",
  memberships: "memberships",
  membership_plans: "membership_plans",
  payments: "payments",
  expenses: "expenses",
  income: "income",
  attendance: "attendance",
  employees: "employees",
  equipment: "equipment",
};

/** camelCase payload key -> snake_case column, per syncable entity. */
const PAYLOAD_COLUMNS: Record<string, Record<string, string>> = {
  members: {
    id: "id",
    gymId: "gym_id",
    organizationId: "organization_id",
    memberCode: "member_code",
    fullName: "full_name",
    fatherName: "father_name",
    phone: "phone",
    whatsapp: "whatsapp",
    email: "email",
    address: "address",
    dateOfBirth: "date_of_birth",
    gender: "gender",
    emergencyContact: "emergency_contact",
    bloodGroup: "blood_group",
    weightKg: "weight_kg",
    joinDate: "join_date",
    status: "status",
    notes: "notes",
    lastModifiedByDeviceId: "last_modified_by_device_id",
  },
  memberships: {
    id: "id",
    gymId: "gym_id",
    memberId: "member_id",
    planId: "plan_id",
    startDate: "start_date",
    endDate: "end_date",
    status: "status",
    paymentStatus: "payment_status",
  },
  membership_plans: {
    id: "id",
    gymId: "gym_id",
    name: "name",
    durationDays: "duration_days",
    priceMinor: "price_minor",
    currencyCode: "currency_code",
  },
  payments: {
    id: "id",
    gymId: "gym_id",
    memberId: "member_id",
    membershipId: "membership_id",
    amountMinor: "amount_minor",
    currencyCode: "currency_code",
    methodCode: "method_code",
    receivedByUserId: "received_by_user_id",
    receiptNumber: "receipt_number",
    notes: "notes",
    paidAt: "paid_at",
  },
  expenses: {
    id: "id",
    gymId: "gym_id",
    categoryId: "category_id",
    amountMinor: "amount_minor",
    currencyCode: "currency_code",
    description: "description",
    vendor: "vendor",
    incurredAt: "incurred_at",
    recordedByUserId: "recorded_by_user_id",
  },
  income: {
    id: "id",
    gymId: "gym_id",
    source: "source",
    amountMinor: "amount_minor",
    currencyCode: "currency_code",
    notes: "notes",
    receivedAt: "received_at",
  },
  attendance: {
    id: "id",
    gymId: "gym_id",
    memberId: "member_id",
    direction: "direction",
    method: "method",
    occurredAt: "occurred_at",
    deviceId: "device_id",
    confidence: "confidence",
  },
  employees: {
    id: "id",
    gymId: "gym_id",
    userId: "user_id",
    fullName: "full_name",
    phone: "phone",
    role: "role",
    salaryMinor: "salary_minor",
    hiredAt: "hired_at",
  },
  equipment: {
    id: "id",
    gymId: "gym_id",
    name: "name",
    category: "category",
    brand: "brand",
    model: "model",
    serialNumber: "serial_number",
    purchaseDate: "purchase_date",
    purchaseCostMinor: "purchase_cost_minor",
    warrantyUntil: "warranty_until",
    status: "status",
    location: "location",
    notes: "notes",
    maintenanceIntervalDays: "maintenance_interval_days",
    nextMaintenanceAt: "next_maintenance_at",
  },
};

function upsertEntity(db: SqlDatabase, entityType: string, payload: Record<string, unknown>, deviceId?: string): void {
  const columns = PAYLOAD_COLUMNS[entityType];
  if (!columns) throw new Error(`Cannot apply sync for entity type "${entityType}".`);

  const normalizedPayload: Record<string, unknown> = { ...payload };
  if (entityType === "members" && normalizedPayload.lastModifiedByDeviceId === undefined) {
    normalizedPayload.lastModifiedByDeviceId = deviceId ?? "hub";
  }

  const present = Object.entries(columns).filter(([key]) => normalizedPayload[key] !== undefined);
  if (!present.some(([key]) => key === "id")) throw new Error("Payload is missing the record id.");

  const ts = new Date().toISOString();
  const columnNames = present.map(([, column]) => column);
  const values = present.map(([key]) => normalizedPayload[key]);

  const placeholders = columnNames.map(() => "?").join(", ");
  void placeholders;

  const insertColumns = columnNames.filter((column) => column !== "version");
  const insertValues = values.filter((_, index) => columnNames[index] !== "version");

  const existing = db.get<Record<string, unknown>>(`SELECT 1 FROM ${ENTITY_TABLES[entityType]} WHERE id = ?`, [normalizedPayload.id]);
  if (!existing) {
    db.run(
      `INSERT INTO ${ENTITY_TABLES[entityType]} (${insertColumns.join(", ")}, version, created_at, updated_at)
       VALUES (${insertColumns.map(() => "?").join(", ")}, 1, ?, ?)`,
      [...insertValues, ts, ts],
    );
    return;
  }

  const updateColumns = columnNames.filter((column) => column !== "id");
  if (updateColumns.length > 0) {
    db.run(
      `UPDATE ${ENTITY_TABLES[entityType]} SET ${updateColumns.map((column) => `${column} = ?`).join(", ")}, version = version + 1, updated_at = ?
       WHERE id = ?`,
      [...updateColumns.map((column) => values[columnNames.indexOf(column)]), ts, normalizedPayload.id],
    );
  }
}

export interface ApplyIncomingResult {
  applied: number;
  skipped: number;
  conflicts: number;
  rejected: Array<{ syncRecordId: string; reason: string }>;
}

/**
 * Apply records pushed from a device to the hub database. Uses version-based
 * conflict resolution; sensitive entities with equal versions and different
 * payloads are parked in sync_conflicts for an admin decision.
 */
export function applyIncomingRecords(
  db: SqlDatabase,
  records: SyncRecordDTO[],
  options: { conflictUserId?: string } = {},
): ApplyIncomingResult {
  const result: ApplyIncomingResult = { applied: 0, skipped: 0, conflicts: 0, rejected: [] };
  const ts = new Date().toISOString();

  for (const dto of records) {
    const table = ENTITY_TABLES[dto.entityType];
    if (!table) {
      result.rejected.push({ syncRecordId: dto.id, reason: `Unknown entity type "${dto.entityType}"` });
      continue;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(dto.payloadJson) as Record<string, unknown>;
    } catch {
      result.rejected.push({ syncRecordId: dto.id, reason: "Payload is not valid JSON" });
      continue;
    }

    const existing = db.get<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ?`, [dto.entityId]);
    const existingVersion = Number.isFinite(existing?.version) ? Number(existing!.version) : 0;
    // Rebuild the local payload from the stored row so conflict comparison
    // compares real local data against the incoming change.
    const inverseColumns: Record<string, string> = {};
    for (const [key, column] of Object.entries(PAYLOAD_COLUMNS[dto.entityType] ?? {})) {
      inverseColumns[column] = key;
    }
    let localPayloadJson: string | null = null;
    if (existing) {
      const localPayload: Record<string, unknown> = {};
      for (const [column, value] of Object.entries(existing)) {
        const key = inverseColumns[column];
        if (key !== undefined && value !== null) localPayload[key] = value;
      }
      localPayloadJson = JSON.stringify(localPayload);
    }
    const local: SyncRecord | null = existing
      ? {
          id: dto.id,
          gymId: dto.gymId,
          entityType: dto.entityType,
          entityId: dto.entityId,
          operation: dto.operation,
          deviceId: "hub",
          version: existingVersion,
          payloadJson: localPayloadJson ?? "{}",
          timestamp: ts,
          createdAt: ts,
          updatedAt: ts,
          status: "synced",
          retryCount: 0,
          errorMessage: null,
        }
      : null;
    const incoming: SyncRecord = {
      id: dto.id,
      gymId: dto.gymId,
      entityType: dto.entityType,
      entityId: dto.entityId,
      operation: dto.operation,
      deviceId: dto.deviceId,
      version: dto.version,
      payloadJson: dto.payloadJson,
      timestamp: dto.timestamp,
      createdAt: dto.timestamp,
      updatedAt: ts,
      status: "pending",
      retryCount: 0,
      errorMessage: null,
    };

    const decision = resolveIncoming(local, incoming);
    if (decision.kind === "auto-remote") {
      db.transaction(() => {
        if (dto.operation === "delete") {
          db.run(`UPDATE ${table} SET deleted_at = ?, version = version + 1 WHERE id = ?`, [ts, dto.entityId]);
        } else {
          upsertEntity(db, dto.entityType, payload, dto.deviceId);
        }
        db.run(
          `INSERT OR REPLACE INTO sync_records (
            id, gym_id, entity_type, entity_id, operation, device_id, version, payload_json,
            timestamp, created_at, updated_at, status, retry_count, error_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', 0, NULL)`,
          [dto.id, dto.gymId, dto.entityType, dto.entityId, dto.operation, dto.deviceId, dto.version, dto.payloadJson, dto.timestamp, dto.timestamp, ts],
        );
      });
      result.applied += 1;
    } else if (decision.kind === "auto-local") {
      result.skipped += 1;
    } else {
      const conflict: Omit<SyncConflict, "id" | "createdAt"> = decision.conflict;
      db.run(
        `INSERT INTO sync_conflicts (
          id, gym_id, entity_type, entity_id, local_version, remote_version,
          local_payload_json, remote_payload_json, local_device_id, remote_device_id,
          resolved, resolution, created_at, resolved_at, resolved_by_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?)`,
        [
          newId(),
          conflict.gymId,
          conflict.entityType,
          conflict.entityId,
          conflict.localVersion,
          conflict.remoteVersion,
          conflict.localPayloadJson,
          conflict.remotePayloadJson,
          conflict.localDeviceId,
          conflict.remoteDeviceId,
          ts,
          options.conflictUserId ?? null,
        ],
      );
      result.conflicts += 1;
    }
  }

  return result;
}

/**
 * Return hub records created after `since`, excluding the pulling device's own
 * writes so devices do not echo their data back.
 */
export function pullRecordsSince(
  db: SqlDatabase,
  input: { since: string; excludeDeviceId?: string; limit?: number },
): { records: SyncRecordDTO[]; serverTime: string } {
  const limit = input.limit ?? 500;
  const exclude = input.excludeDeviceId ? ` AND device_id != ?` : "";
  const params: unknown[] = input.excludeDeviceId ? [input.since, input.excludeDeviceId, limit] : [input.since, limit];

  const rows = db.all<{
    id: string;
    gym_id: string;
    entity_type: string;
    entity_id: string;
    operation: string;
    device_id: string;
    version: number;
    payload_json: string;
    timestamp: string;
  }>(
    `SELECT id, gym_id, entity_type, entity_id, operation, device_id, version, payload_json, timestamp
     FROM sync_records
     WHERE timestamp > ?${exclude}
     ORDER BY timestamp ASC LIMIT ?`,
    params,
  );

  return {
    records: rows.map((row) => ({
      id: row.id,
      gymId: row.gym_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      operation: row.operation as SyncOperation,
      deviceId: row.device_id,
      version: row.version,
      payloadJson: row.payload_json,
      timestamp: row.timestamp,
    })),
    serverTime: new Date().toISOString(),
  };
}

/**
 * Resolve a conflict by force-applying one side. Used by the admin conflict UI.
 */
export function resolveConflict(
  db: SqlDatabase,
  input: { conflictId: string; resolution: "local" | "remote"; userId: string },
): void {
  const conflict = db.get<{
    id: string;
    entity_type: string;
    entity_id: string;
    remote_payload_json: string;
  }>(
    `SELECT id, entity_type, entity_id, remote_payload_json FROM sync_conflicts WHERE id = ? AND resolved = 0`,
    [input.conflictId],
  );
  if (!conflict) throw new Error("Conflict not found or already resolved.");

  const ts = new Date().toISOString();
  if (input.resolution === "remote") {
    const payload = JSON.parse(conflict.remote_payload_json) as Record<string, unknown>;
    upsertEntity(db, conflict.entity_type, payload, "conflict-resolution");
  }
  db.run(
    `UPDATE sync_conflicts SET resolved = 1, resolution = ?, resolved_at = ?, resolved_by_user_id = ? WHERE id = ?`,
    [input.resolution, ts, input.userId, input.conflictId],
  );
}

export function listConflicts(db: SqlDatabase, gymId: string): Array<Record<string, unknown>> {
  return db.all(
    `SELECT id, entity_type, entity_id, local_version, remote_version,
            local_device_id, remote_device_id, resolved, resolution, created_at
     FROM sync_conflicts WHERE gym_id = ? ORDER BY created_at DESC LIMIT 100`,
    [gymId],
  );
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqlJsDatabase, applyMigrations } from "@gym-erp/database";
import { completeFirstRun, createMemberOffline, createStaffOffline } from "@gym-erp/business-logic";
import { createSyncRecord } from "../src/index.js";
import {
  applyIncomingRecords,
  listConflicts,
  processSyncQueue,
  pullRecordsSince,
  resolveConflict,
  type SyncRecordDTO,
} from "../src/sync-queue.js";

function toDto(record: ReturnType<typeof createSyncRecord>): SyncRecordDTO {
  return {
    id: record.id,
    gymId: record.gymId,
    entityType: record.entityType,
    entityId: record.entityId,
    operation: record.operation,
    deviceId: record.deviceId,
    version: record.version,
    payloadJson: record.payloadJson,
    timestamp: record.timestamp,
  };
}

async function makeDb(): Promise<{ db: SqlJsDatabase; gymId: string; organizationId: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "gym-erp-sync-"));
  const db = (await SqlJsDatabase.open({ filePath: join(dir, "gym.db") })) as SqlJsDatabase;
  applyMigrations(db);
  const setup = await completeFirstRun(db, "hub-device", {
    gymName: "Sync Gym",
    ownerName: "Owner",
    username: "owner",
    password: "Password1",
    currencyCode: "PKR",
  });
  const organizationId = db.get<{ id: string }>(`SELECT id FROM organizations LIMIT 1`)?.id as string;
  return { db, gymId: setup.gymId, organizationId, dir };
}

describe("sync round trip", () => {
  it("pushes a member from device to hub and pulls it back to a second device", async () => {
    const { db, gymId, organizationId, dir } = await makeDb();
    try {
      // Device A creates a member locally (on its own copy) and pushes the
      // record to the hub — the hub does not have this member yet.
      const record = createSyncRecord({
        id: "device-record-1",
        gymId,
        entityType: "members",
        entityId: "member-from-device",
        operation: "create",
        deviceId: "device-a",
        version: 1,
        payload: {
          id: "member-from-device",
          gymId,
          organizationId,
          memberCode: "MEMBER-000009",
          fullName: "Round Trip",
          joinDate: "2026-02-01",
          gender: "male",
        },
      });
      const wire = JSON.parse(JSON.stringify([toDto(record)])) as SyncRecordDTO[];

      const applied = applyIncomingRecords(db, wire);
      expect(applied.applied).toBe(1);
      expect(applied.conflicts).toBe(0);

      const stored = db.get<{ full_name: string; member_code: string }>(
        `SELECT full_name, member_code FROM members WHERE id = ?`,
        ["member-from-device"],
      );
      expect(stored?.full_name).toBe("Round Trip");
      expect(stored?.member_code).toBe("MEMBER-000009");

      // Device B pulls everything except its own writes.
      const pull = pullRecordsSince(db, { since: "1970-01-01T00:00:00.000Z", excludeDeviceId: "device-b" });
      expect(pull.records.length).toBeGreaterThanOrEqual(1);
      expect(pull.records.some((r) => r.entityId === "member-from-device")).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parks equal-version conflicting payloads for an admin and resolves them", async () => {
    const { db, gymId, organizationId, dir } = await makeDb();
    try {
      createMemberOffline(
        db,
        { gymId, organizationId, userId: "u", deviceId: "device-a" },
        { fullName: "Conflict Case", joinDate: "2026-02-01" },
      );
      const memberId = db.get<{ id: string }>(`SELECT id FROM members LIMIT 1`)?.id as string;

      const payload = {
        id: memberId,
        gymId,
        organizationId,
        memberCode: "MEMBER-000001",
        fullName: "Conflict Case EDITED",
        joinDate: "2026-02-01",
        gender: "unspecified",
      };
      const incoming = toDto(
        createSyncRecord({
          id: "conflict-record-1",
          gymId,
          entityType: "members",
          entityId: memberId,
          operation: "update",
          deviceId: "device-b",
          version: 1, // same version as local, different payload -> needs admin
          payload,
        }),
      );

      const result = applyIncomingRecords(db, [incoming]);
      expect(result.conflicts).toBe(1);
      const conflicts = listConflicts(db, gymId);
      expect(conflicts.length).toBe(1);

      resolveConflict(db, { conflictId: conflicts[0]!.id as string, resolution: "remote", userId: "admin" });
      const renamed = db.get<{ full_name: string }>(`SELECT full_name FROM members WHERE id = ?`, [memberId]);
      expect(renamed?.full_name).toBe("Conflict Case EDITED");
      expect(listConflicts(db, gymId).length).toBe(1); // still listed, now resolved=1
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("syncs a newly created staff user payload to the hub without dropping the employee id", async () => {
    const { db, gymId, organizationId, dir } = await makeDb();
    try {
      await createStaffOffline(
        db,
        { gymId, organizationId, userId: "u", deviceId: "device-a" },
        {
          fullName: "Mobile Staff",
          username: "mobilestaff",
          password: "StrongPass!1",
          role: "staff",
          phone: "03001234567",
        },
      );

      const inserted = db.get<{ payload_json: string }>(
        `SELECT payload_json FROM sync_records WHERE entity_type = 'employees' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(inserted?.payload_json).toContain('"id":"');
      expect(inserted?.payload_json).toContain('"gymId":"' + gymId + '"');

      const payload = JSON.parse(inserted!.payload_json) as Record<string, unknown>;
      const result = applyIncomingRecords(db, [{
        id: "device-employee-sync-1",
        gymId,
        entityType: "employees",
        entityId: String(payload.id),
        operation: "create",
        deviceId: "device-a",
        version: 1,
        payloadJson: JSON.stringify(payload),
        timestamp: new Date().toISOString(),
      }]);

      expect(result.applied + result.skipped + result.conflicts).toBe(1);
      const employeeRow = db.get<{ full_name: string; gym_id: string }>(
        `SELECT full_name, gym_id FROM employees WHERE id = ?`,
        [String(payload.id)],
      );
      expect(employeeRow?.full_name).toBe("Mobile Staff");
      expect(employeeRow?.gym_id).toBe(gymId);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not insert undefined local versions when reconciling an existing employee row", async () => {
    const { db, gymId, organizationId, dir } = await makeDb();
    try {
      await createStaffOffline(
        db,
        { gymId, organizationId, userId: "u", deviceId: "device-a" },
        {
          fullName: "Existing Staff",
          username: "existingstaff",
          password: "StrongPass!1",
          role: "staff",
          phone: "03001112222",
        },
      );
      const employeeId = db.get<{ id: string }>(`SELECT id FROM employees LIMIT 1`)?.id as string;

      const result = applyIncomingRecords(db, [{
        id: "employee-conflict-1",
        gymId,
        entityType: "employees",
        entityId: employeeId,
        operation: "update",
        deviceId: "device-b",
        version: 1,
        payloadJson: JSON.stringify({
          id: employeeId,
          gymId,
          userId: "u",
          fullName: "Existing Staff Changed",
          phone: "03001112222",
          role: "staff",
        }),
        timestamp: new Date().toISOString(),
      }]);

      expect(result.conflicts).toBe(1);
      const conflictRow = db.get<{ local_version: number | null }>(
        `SELECT local_version FROM sync_conflicts WHERE entity_id = ? LIMIT 1`,
        [employeeId],
      );
      expect(conflictRow?.local_version).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks records synced when no transport is configured (hub is authoritative)", async () => {
    const { db, gymId, organizationId, dir } = await makeDb();
    try {
      createMemberOffline(
        db,
        { gymId, organizationId, userId: "u", deviceId: "hub-device" },
        { fullName: "Local Only", joinDate: "2026-02-01" },
      );
      const stats = await processSyncQueue(db);
      expect(stats.synced).toBeGreaterThan(0);
      const left = db.get<{ c: number }>(`SELECT COUNT(*) as c FROM sync_records WHERE status = 'pending'`);
      expect(left?.c).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

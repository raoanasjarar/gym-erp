import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations, listAppliedMigrations } from "./migrate.js";
import { ensureDataLayout } from "./paths.js";
import { SqlJsDatabase } from "./sqljs-database.js";

describe("database migrations", () => {
  it("creates members, payments, and attendance tables", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gym-erp-"));
    const dbPath = join(dir, "gym.db");
    const db = await SqlJsDatabase.open({ filePath: dbPath });
    try {
      const applied = applyMigrations(db);
      expect(applied.length).toBeGreaterThan(0);
      const tables = db
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining([...requiredPhase3Tables]));
      const face = db.get<{ is_active: number }>(
        "SELECT is_active FROM attendance_methods WHERE code = ?",
        ["face"],
      );
      const fingerprint = db.get<{ is_active: number }>(
        "SELECT is_active FROM attendance_methods WHERE code = ?",
        ["fingerprint"],
      );
      expect(face?.is_active).toBe(1);
      expect(fingerprint?.is_active).toBe(0);

      const indexes = db
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
        .map((row) => row.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "idx_members_gym_name",
          "idx_attendance_member_time",
          "idx_payments_receipt_unique",
          "idx_sync_idempotency",
          "idx_file_assets_owner",
        ]),
      );
      expect(listAppliedMigrations(db)).toEqual([
        "001_initial_schema",
        "002_seed_roles",
        "003_phase3_schema_hardening",
        "004_member_profile_measurements",
        "005_employee_sync_version",
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent and rolls back incomplete transactions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gym-erp-"));
    const db = await SqlJsDatabase.open({ filePath: join(dir, "gym.db") });
    try {
      applyMigrations(db);
      const second = applyMigrations(db);
      expect(second).toEqual([]);
      expect(() =>
        db.transaction(() => {
          db.run("INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [
            "org-1",
            "Test",
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
          ]);
          throw new Error("force rollback");
        }),
      ).toThrow("force rollback");
      const org = db.get("SELECT id FROM organizations WHERE id = ?", ["org-1"]);
      expect(org).toBeUndefined();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back a failed migration file without recording it as applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gym-erp-"));
    const migrationDir = join(dir, "migrations");
    const db = await SqlJsDatabase.open({ filePath: join(dir, "gym.db") });
    try {
      mkdirSync(migrationDir, { recursive: true });
      writeFileSync(
        join(migrationDir, "001_valid.sql"),
        "CREATE TABLE valid_before_failure (id TEXT PRIMARY KEY);",
      );
      writeFileSync(
        join(migrationDir, "002_invalid.sql"),
        "CREATE TABLE should_rollback (id TEXT PRIMARY KEY); INSERT INTO missing_table VALUES ('x');",
      );

      expect(() => applyMigrations(db, migrationDir)).toThrow();
      expect(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'valid_before_failure'")).toBeTruthy();
      expect(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'")).toBeUndefined();
      expect(listAppliedMigrations(db)).toEqual(["001_valid"]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the file storage layout", () => {
    const dir = mkdtempSync(join(tmpdir(), "gym-erp-"));
    const layout = ensureDataLayout(join(dir, "GymERP"));
    expect(layout.databaseFile.endsWith("gym.db")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

const requiredPhase3Tables = [
  "users",
  "roles",
  "permissions",
  "gyms",
  "members",
  "member_photos",
  "memberships",
  "membership_plans",
  "renewals",
  "attendance",
  "attendance_methods",
  "payments",
  "payment_methods",
  "expenses",
  "expense_categories",
  "income",
  "equipment",
  "equipment_maintenance",
  "suppliers",
  "employees",
  "employee_attendance",
  "notifications",
  "invoices",
  "receipts",
  "documents",
  "biometric_devices",
  "biometric_templates",
  "sync_records",
  "sync_queue",
  "sync_conflicts",
  "audit_logs",
  "application_settings",
  "backups",
  "devices",
  "file_assets",
  "import_jobs",
  "import_job_errors",
  "export_jobs",
  "backup_restore_events",
  "recurring_backup_policies",
  "app_metadata",
] as const;

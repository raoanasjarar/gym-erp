import type { SqlDatabase } from "@gym-erp/database";
import type { RoleCode } from "@gym-erp/shared-types";
import { hashPassword } from "@gym-erp/security";
import { friendlyParse, staffInputSchema, staffUpdateSchema } from "@gym-erp/validation";
import { enqueueSync, newId, writeAudit } from "./setup.js";

function nowIso(): string {
  return new Date().toISOString();
}

export interface StaffRow {
  employee_id: string;
  user_id: string | null;
  full_name: string;
  phone: string | null;
  role: RoleCode;
  salary_minor: number | null;
  hired_at: string | null;
  is_active: number;
  username: string | null;
}

export function listStaff(db: SqlDatabase, gymId: string, includeInactive = true): StaffRow[] {
  const filter = includeInactive ? "" : " AND e.is_active = 1";
  return db.all<StaffRow>(
    `SELECT e.id as employee_id, e.user_id, e.full_name, e.phone, e.role, e.salary_minor,
            e.hired_at, e.is_active, u.username
     FROM employees e LEFT JOIN users u ON u.id = e.user_id AND u.deleted_at IS NULL
     WHERE e.gym_id = ? AND e.deleted_at IS NULL${filter}
     ORDER BY e.created_at ASC`,
    [gymId],
  );
}

export async function createStaffOffline(
  db: SqlDatabase,
  ctx: { gymId: string; organizationId: string; userId: string; deviceId: string },
  input: unknown,
): Promise<{ employeeId: string; userId: string }> {
  const data = friendlyParse(staffInputSchema, input);
  const employeeId = newId();
  const userId = newId();
  const ts = nowIso();

  const existingUsername = db.get<{ id: string }>(
    `SELECT id FROM users WHERE gym_id = ? AND username = ?`,
    [ctx.gymId, data.username],
  );
  if (existingUsername) throw new Error("That username is already taken. Choose another one.");

  const passwordHash = await hashPassword(data.password);

  db.transaction(() => {
    db.run(
      `INSERT INTO employees (id, gym_id, user_id, full_name, phone, role, salary_minor, hired_at, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        employeeId,
        ctx.gymId,
        userId,
        data.fullName,
        data.phone ?? null,
        data.role,
        data.salaryMinor ?? null,
        data.hireDate ?? ts.slice(0, 10),
        ts,
        ts,
      ],
    );
    db.run(
      `INSERT INTO users (id, gym_id, organization_id, full_name, username, email, phone, password_hash, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?)`,
      [userId, ctx.gymId, ctx.organizationId, data.fullName, data.username, data.phone ?? null, passwordHash, data.role, ts, ts],
    );
    enqueueSync(db, {
      gymId: ctx.gymId,
      entityType: "employees",
      entityId: employeeId,
      operation: "create",
      deviceId: ctx.deviceId,
      version: 1,
      payload: {
        id: employeeId,
        gymId: ctx.gymId,
        userId,
        fullName: data.fullName,
        phone: data.phone ?? null,
        role: data.role,
        salaryMinor: data.salaryMinor ?? null,
        hiredAt: data.hireDate ?? ts.slice(0, 10),
      },
    });
    writeAudit(db, {
      gymId: ctx.gymId,
      userId: ctx.userId,
      action: "Added staff member",
      entityType: "employees",
      entityId: employeeId,
      deviceId: ctx.deviceId,
      after: { fullName: data.fullName, role: data.role, username: data.username },
    });
  });

  return { employeeId, userId };
}

export function updateEmployee(
  db: SqlDatabase,
  ctx: { gymId: string; userId: string; deviceId: string },
  employeeId: string,
  input: unknown,
): void {
  const data = friendlyParse(staffUpdateSchema, input);
  const existing = db.get<StaffRow & { is_active: number }>(
    `SELECT e.id as employee_id, e.user_id, e.full_name, e.phone, e.role, e.salary_minor, e.is_active
     FROM employees e WHERE e.id = ? AND e.gym_id = ? AND e.deleted_at IS NULL`,
    [employeeId, ctx.gymId],
  );
  if (!existing) throw new Error("Staff member not found.");

  const employeeFields: Array<[string, unknown]> = [];
  if (data.fullName !== undefined) employeeFields.push(["full_name", data.fullName]);
  if (data.phone !== undefined) employeeFields.push(["phone", data.phone || null]);
  if (data.role !== undefined) employeeFields.push(["role", data.role]);
  if (data.salaryMinor !== undefined) employeeFields.push(["salary_minor", data.salaryMinor]);
  if (data.isActive !== undefined) employeeFields.push(["is_active", data.isActive ? 1 : 0]);

  const ts = nowIso();
  db.transaction(() => {
    if (employeeFields.length > 0) {
      db.run(
        `UPDATE employees SET ${employeeFields.map(([column]) => `${column} = ?`).join(", ")}, updated_at = ?
         WHERE id = ? AND gym_id = ?`,
        [...employeeFields.map(([, value]) => value), ts, employeeId, ctx.gymId],
      );
    }
    // Mirror role/active state onto the linked login account so permissions stay in sync.
    if (existing.user_id) {
      const userFields: Array<[string, unknown]> = [];
      if (data.fullName !== undefined) userFields.push(["full_name", data.fullName]);
      if (data.phone !== undefined) userFields.push(["phone", data.phone || null]);
      if (data.role !== undefined) userFields.push(["role", data.role]);
      if (data.isActive !== undefined) userFields.push(["is_active", data.isActive ? 1 : 0]);
      if (userFields.length > 0) {
        db.run(
          `UPDATE users SET ${userFields.map(([column]) => `${column} = ?`).join(", ")}, updated_at = ?
           WHERE id = ?`,
          [...userFields.map(([, value]) => value), ts, existing.user_id],
        );
      }
    }
    writeAudit(db, {
      gymId: ctx.gymId,
      userId: ctx.userId,
      action: "Updated staff member",
      entityType: "employees",
      entityId: employeeId,
      deviceId: ctx.deviceId,
      after: data,
    });
  });
}

export function archiveEmployee(
  db: SqlDatabase,
  ctx: { gymId: string; userId: string; deviceId: string },
  employeeId: string,
): void {
  const existing = db.get<{ user_id: string | null }>(
    `SELECT user_id FROM employees WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [employeeId, ctx.gymId],
  );
  if (!existing) throw new Error("Staff member not found.");

  const ts = nowIso();
  db.transaction(() => {
    db.run(
      `UPDATE employees SET is_active = 0, deleted_at = ?, updated_at = ? WHERE id = ? AND gym_id = ?`,
      [ts, ts, employeeId, ctx.gymId],
    );
    if (existing.user_id) {
      // Soft-delete the login account and kill its sessions.
      db.run(`UPDATE users SET is_active = 0, deleted_at = ?, updated_at = ? WHERE id = ?`, [ts, ts, existing.user_id]);
      db.run(`DELETE FROM sessions WHERE user_id = ?`, [existing.user_id]);
    }
    writeAudit(db, {
      gymId: ctx.gymId,
      userId: ctx.userId,
      action: "Removed staff member",
      entityType: "employees",
      entityId: employeeId,
      deviceId: ctx.deviceId,
    });
  });
}

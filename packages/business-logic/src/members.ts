import type { SqlDatabase } from "@gym-erp/database";
import { memberInputSchema, memberQuerySchema, memberUpdateSchema, newMembershipSchema, friendlyParse, paymentInputSchema, attendanceInputSchema } from "@gym-erp/validation";
import { enqueueSync, newId, nextMemberCode, writeAudit } from "./setup.js";
import { insertReceiptRow, nextDocumentNumber } from "./receipts.js";

function nowIso(): string {
  return new Date().toISOString();
}

export interface MemberRow {
  id: string;
  gym_id: string;
  member_code: string;
  full_name: string;
  father_name: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  address: string | null;
  date_of_birth: string | null;
  gender: string;
  emergency_contact: string | null;
  blood_group: string | null;
  weight_kg: number | null;
  join_date: string;
  status: string;
  notes: string | null;
  profile_photo_path: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  membership_end_date?: string | null;
  membership_status?: string | null;
  plan_name?: string | null;
}

const MEMBER_LIST_SELECT = `
  SELECT m.id, m.gym_id, m.member_code, m.full_name, m.father_name, m.phone, m.whatsapp, m.email,
         m.address, m.date_of_birth, m.gender, m.emergency_contact, m.blood_group, m.join_date,
         m.status, m.notes, m.weight_kg, m.profile_photo_path, m.version, m.created_at, m.updated_at,
         ms.end_date as membership_end_date, ms.status as membership_status, p.name as plan_name
  FROM members m
  LEFT JOIN memberships ms ON ms.member_id = m.id AND ms.deleted_at IS NULL
    AND ms.end_date = (
      SELECT MAX(ms2.end_date) FROM memberships ms2
      WHERE ms2.member_id = m.id AND ms2.deleted_at IS NULL
    )
  LEFT JOIN membership_plans p ON p.id = ms.plan_id
  WHERE m.deleted_at IS NULL AND m.gym_id = ?`;

export function createMemberOffline(
  db: SqlDatabase,
  ctx: { gymId: string; organizationId: string; userId: string; deviceId: string },
  input: unknown,
): { id: string; memberCode: string } {
  const data = friendlyParse(memberInputSchema, input);
  const id = newId();
  const memberCode = nextMemberCode(db, ctx.gymId);
  const ts = nowIso();
  const photoBase64 = data.profilePhotoBase64 ?? data.profilePhotoDataUrl ?? data.photoBase64 ?? null;
  const photoPath = photoBase64 ? `member-photos/${id}.jpg` : null;

  db.transaction(() => {
    db.run(
      `INSERT INTO members (
        id, gym_id, organization_id, member_code, full_name, father_name, phone, whatsapp, email,
        address, date_of_birth, gender, emergency_contact, blood_group, join_date, status, notes,
        fingerprint_template_id, face_template_id, profile_photo_path, profile_photo_thumb_path, weight_kg,
        version, last_modified_by_device_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, ?, 1, ?, ?, ?)`,
      [
        id,
        ctx.gymId,
        ctx.organizationId,
        memberCode,
        data.fullName,
        data.fatherName ?? null,
        data.phone ?? null,
        data.whatsapp ?? null,
        data.email || null,
        data.address ?? null,
        data.dateOfBirth ?? null,
        data.gender,
        data.emergencyContact ?? null,
        data.bloodGroup ?? null,
        data.joinDate,
        data.notes ?? null,
        photoPath,
        photoPath,
        data.weightKg ?? null,
        ctx.deviceId,
        ts,
        ts,
      ],
    );
    enqueueSync(db, {
      gymId: ctx.gymId,
      entityType: "members",
      entityId: id,
      operation: "create",
      deviceId: ctx.deviceId,
      version: 1,
      payload: {
        id,
        gymId: ctx.gymId,
        organizationId: ctx.organizationId,
        memberCode,
        fullName: data.fullName,
        fatherName: data.fatherName ?? null,
        phone: data.phone ?? null,
        whatsapp: data.whatsapp ?? null,
        email: data.email || null,
        address: data.address ?? null,
        dateOfBirth: data.dateOfBirth ?? null,
        gender: data.gender,
        emergencyContact: data.emergencyContact ?? null,
        bloodGroup: data.bloodGroup ?? null,
        weightKg: data.weightKg ?? null,
        joinDate: data.joinDate,
        status: "pending",
        notes: data.notes ?? null,
        profilePhotoPath: photoPath,
        profilePhotoThumbPath: photoPath,
        ...(photoBase64 ? { profilePhotoBase64: photoBase64 } : {}),
      },
    });
    writeAudit(db, {
      gymId: ctx.gymId,
      userId: ctx.userId,
      action: "Added member",
      entityType: "members",
      entityId: id,
      deviceId: ctx.deviceId,
      after: { memberCode, fullName: data.fullName },
    });
  });

  return { id, memberCode };
}

export function updateMember(
  db: SqlDatabase,
  ctx: { gymId: string; userId: string; deviceId: string },
  memberId: string,
  input: unknown,
): void {
  const data = friendlyParse(memberUpdateSchema, input);
  const existing = db.get<MemberRow>(
    `SELECT * FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [memberId, ctx.gymId],
  );
  if (!existing) throw new Error("Member not found.");

  const fields: Array<[string, unknown]> = [];
  if (data.fullName !== undefined) fields.push(["full_name", data.fullName]);
  if (data.fatherName !== undefined) fields.push(["father_name", data.fatherName || null]);
  if (data.phone !== undefined) fields.push(["phone", data.phone || null]);
  if (data.whatsapp !== undefined) fields.push(["whatsapp", data.whatsapp || null]);
  if (data.email !== undefined) fields.push(["email", data.email || null]);
  if (data.address !== undefined) fields.push(["address", data.address || null]);
  if (data.dateOfBirth !== undefined) fields.push(["date_of_birth", data.dateOfBirth || null]);
  if (data.gender !== undefined) fields.push(["gender", data.gender]);
  if (data.emergencyContact !== undefined) fields.push(["emergency_contact", data.emergencyContact || null]);
  if (data.bloodGroup !== undefined) fields.push(["blood_group", data.bloodGroup || null]);
  if (data.joinDate !== undefined) fields.push(["join_date", data.joinDate]);
  if (data.notes !== undefined) fields.push(["notes", data.notes || null]);
  if (data.weightKg !== undefined) fields.push(["weight_kg", data.weightKg || null]);
  if (fields.length === 0) return;

  const ts = nowIso();
  const version = existing.version + 1;
  const sets = fields.map(([column]) => `${column} = ?`).join(", ");
  const params = fields.map(([, value]) => value);

  db.transaction(() => {
    db.run(
      `UPDATE members SET ${sets}, version = ?, last_modified_by_device_id = ?, updated_at = ?
       WHERE id = ? AND gym_id = ?`,
      [...params, version, ctx.deviceId, ts, memberId, ctx.gymId],
    );
    enqueueSync(db, {
      gymId: ctx.gymId,
      entityType: "members",
      entityId: memberId,
      operation: "update",
      deviceId: ctx.deviceId,
      version,
      payload: { id: memberId, ...data },
    });
    writeAudit(db, {
      gymId: ctx.gymId,
      userId: ctx.userId,
      action: "Updated member",
      entityType: "members",
      entityId: memberId,
      deviceId: ctx.deviceId,
      before: { fullName: existing.full_name, phone: existing.phone },
      after: data,
    });
  });
}

export function setMemberStatus(
  db: SqlDatabase,
  ctx: { gymId: string; userId: string; deviceId: string },
  memberId: string,
  status: "active" | "expired" | "suspended" | "pending" | "cancelled",
): void {
  const existing = db.get<MemberRow>(
    `SELECT * FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [memberId, ctx.gymId],
  );
  if (!existing) throw new Error("Member not found.");

  const ts = nowIso();
  const version = existing.version + 1;
  db.transaction(() => {
    db.run(`UPDATE members SET status = ?, version = ?, updated_at = ? WHERE id = ? AND gym_id = ?`, [
      status,
      version,
      ts,
      memberId,
      ctx.gymId,
    ]);
    enqueueSync(db, {
      gymId: ctx.gymId,
      entityType: "members",
      entityId: memberId,
      operation: "update",
      deviceId: ctx.deviceId,
      version,
      payload: { id: memberId, status },
    });
    writeAudit(db, {
      gymId: ctx.gymId,
      userId: ctx.userId,
      action: `Member marked ${status}`,
      entityType: "members",
      entityId: memberId,
      deviceId: ctx.deviceId,
    });
  });
}

export function archiveMember(
  db: SqlDatabase,
  ctx: { gymId: string; userId: string; deviceId: string },
  memberId: string,
): void {
  const existing = db.get<MemberRow>(
    `SELECT * FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [memberId, ctx.gymId],
  );
  if (!existing) throw new Error("Member not found.");

  const ts = nowIso();
  const version = existing.version + 1;
  db.transaction(() => {
    db.run(`UPDATE members SET deleted_at = ?, status = 'cancelled', version = ?, updated_at = ? WHERE id = ? AND gym_id = ?`, [
      ts,
      version,
      ts,
      memberId,
      ctx.gymId,
    ]);
    enqueueSync(db, {
      gymId: ctx.gymId,
      entityType: "members",
      entityId: memberId,
      operation: "delete",
      deviceId: ctx.deviceId,
      version,
      payload: { id: memberId },
    });
    writeAudit(db, {
      gymId: ctx.gymId,
      userId: ctx.userId,
      action: "Removed member",
      entityType: "members",
      entityId: memberId,
      deviceId: ctx.deviceId,
    });
  });
}

export interface MemberListResult {
  items: MemberRow[];
  total: number;
}

export function searchMembers(
  db: SqlDatabase,
  gymId: string,
  query: unknown,
): MemberListResult {
  const q = friendlyParse(memberQuerySchema, query);
  const conditions: string[] = [];
  const params: unknown[] = [gymId];

  if (q.search) {
    conditions.push(`(m.full_name LIKE ? OR m.member_code LIKE ? OR m.phone LIKE ? OR m.whatsapp LIKE ?)`);
    const like = `%${q.search}%`;
    params.push(like, like, like, like);
  }
  if (q.status && q.status !== "all") {
    conditions.push(`m.status = ?`);
    params.push(q.status);
  }

  const whereClause = conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "";
  const totalRow = db.get<{ c: number }>(
    `SELECT COUNT(*) as c FROM members m WHERE m.deleted_at IS NULL AND m.gym_id = ?${whereClause}`,
    params,
  );
  const items = db.all<MemberRow>(
    `${MEMBER_LIST_SELECT}${whereClause} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
    [...params, q.limit, q.offset],
  );
  return { items, total: totalRow?.c ?? 0 };
}

export function getMember(db: SqlDatabase, gymId: string, memberId: string): MemberRow | null {
  return (
    db.get<MemberRow>(`${MEMBER_LIST_SELECT} AND m.id = ?`, [gymId, memberId]) ??
    db.get<MemberRow>(`${MEMBER_LIST_SELECT} AND m.member_code = ?`, [gymId, memberId]) ??
    null
  );
}

export function getMemberDetail(
  db: SqlDatabase,
  gymId: string,
  memberId: string,
): {
  member: MemberRow;
  memberships: Array<{
    id: string;
    plan_name: string;
    start_date: string;
    end_date: string;
    status: string;
    payment_status: string;
    price_minor: number;
  }>;
  payments: Array<{
    id: string;
    receipt_number: string;
    amount_minor: number;
    currency_code: string;
    method_code: string;
    paid_at: string;
    notes: string | null;
  }>;
  attendance: Array<{
    id: string;
    direction: string;
    method: string;
    occurred_at: string;
  }>;
} | null {
  const member = getMember(db, gymId, memberId);
  if (!member) return null;

  const memberships = db.all<{
    id: string;
    plan_name: string;
    start_date: string;
    end_date: string;
    status: string;
    payment_status: string;
    price_minor: number;
  }>(`
    SELECT ms.id, p.name as plan_name, ms.start_date, ms.end_date, ms.status, ms.payment_status, p.price_minor
    FROM memberships ms
    JOIN membership_plans p ON p.id = ms.plan_id
    WHERE ms.member_id = ? AND ms.gym_id = ? AND ms.deleted_at IS NULL
    ORDER BY ms.end_date DESC`,
    [memberId, gymId],
  );
  const payments = db.all<{
    id: string;
    receipt_number: string;
    amount_minor: number;
    currency_code: string;
    method_code: string;
    paid_at: string;
    notes: string | null;
  }>(
    `SELECT id, receipt_number, amount_minor, currency_code, method_code, paid_at, notes
     FROM payments WHERE member_id = ? AND gym_id = ? AND deleted_at IS NULL
     ORDER BY paid_at DESC LIMIT 50`,
    [memberId, gymId],
  );
  const attendance = db.all<{
    id: string;
    direction: string;
    method: string;
    occurred_at: string;
  }>(
    `SELECT id, direction, method, occurred_at FROM attendance
     WHERE member_id = ? AND gym_id = ? AND deleted_at IS NULL
     ORDER BY occurred_at DESC LIMIT 50`,
    [memberId, gymId],
  );

  return { member, memberships, payments, attendance };
}

export function recordPaymentAndActivateMembership(
  db: SqlDatabase,
  ctx: { gymId: string; userId: string; deviceId: string; currencyCode: string },
  input: {
    memberId: string;
    planId: string;
    payment: unknown;
    startDate: string;
    endDate: string;
  },
): { paymentId: string; membershipId: string; receiptNumber: string } {
  const payment = friendlyParse(paymentInputSchema, input.payment);
  const paymentId = newId();
  const membershipId = newId();
  const ts = nowIso();

  const result = db.transaction(() => {
    const receiptNumber = nextDocumentNumber(db, ctx.gymId, "RCPT");
    db.run(
      `INSERT INTO memberships (id, gym_id, member_id, plan_id, start_date, end_date, status, payment_status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 'paid', 1, ?, ?)`,
      [membershipId, ctx.gymId, input.memberId, input.planId, input.startDate, input.endDate, ts, ts],
    );
    db.run(
      `INSERT INTO payments (id, gym_id, member_id, membership_id, amount_minor, currency_code, method_code, received_by_user_id, receipt_number, notes, paid_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        paymentId,
        ctx.gymId,
        input.memberId,
        membershipId,
        payment.amountMinor,
        ctx.currencyCode,
        payment.methodCode,
        ctx.userId,
        receiptNumber,
        payment.notes ?? null,
        payment.paidAt,
        ts,
        ts,
      ],
    );
    insertReceiptRow(db, {
      gymId: ctx.gymId,
      paymentId,
      receiptNumber,
      printableHtmlPath: null,
    });
    db.run(`UPDATE members SET status = 'active', updated_at = ? WHERE id = ?`, [ts, input.memberId]);
    enqueueSync(db, {
      gymId: ctx.gymId,
      entityType: "memberships",
      entityId: membershipId,
      operation: "create",
      deviceId: ctx.deviceId,
      version: 1,
      payload: {
        id: membershipId,
        gymId: ctx.gymId,
        memberId: input.memberId,
        planId: input.planId,
        startDate: input.startDate,
        endDate: input.endDate,
        status: "active",
        paymentStatus: "paid",
      },
    });
    enqueueSync(db, {
      gymId: ctx.gymId,
      entityType: "payments",
      entityId: paymentId,
      operation: "create",
      deviceId: ctx.deviceId,
      version: 1,
      payload: {
        id: paymentId,
        gymId: ctx.gymId,
        memberId: input.memberId,
        membershipId,
        amountMinor: payment.amountMinor,
        methodCode: payment.methodCode,
        receiptNumber,
        notes: payment.notes ?? null,
        paidAt: payment.paidAt,
        receivedByUserId: ctx.userId,
      },
    });
    writeAudit(db, {
      gymId: ctx.gymId,
      userId: ctx.userId,
      action: "Recorded payment and membership",
      entityType: "payments",
      entityId: paymentId,
      deviceId: ctx.deviceId,
    });
    return { receiptNumber };
  });

  return { paymentId, membershipId, receiptNumber: result.receiptNumber };
}

/** New-member + first membership + payment in one transaction (the "quick add" front-desk flow). */
export function createMemberWithMembership(
  db: SqlDatabase,
  ctx: { gymId: string; organizationId: string; userId: string; deviceId: string; currencyCode: string },
  input: { member: unknown; membership: unknown },
): { memberId: string; memberCode: string; paymentId: string; membershipId: string; receiptNumber: string } {
  const member = friendlyParse(memberInputSchema, input.member);
  const membership = friendlyParse(newMembershipSchema, input.membership);
  const plan = db.get<{ id: string; duration_days: number }>(
    `SELECT id, duration_days FROM membership_plans WHERE id = ? AND gym_id = ? AND is_active = 1`,
    [membership.planId, ctx.gymId],
  );
  if (!plan) throw new Error("The selected plan was not found.");

  const start = new Date(membership.startDate);
  const end = new Date(start);
  end.setDate(end.getDate() + plan.duration_days);
  const endDate = end.toISOString().slice(0, 10);

  const created = createMemberOffline(db, ctx, member);
  const paymentResult = recordPaymentAndActivateMembership(db, ctx, {
    memberId: created.id,
    planId: membership.planId,
    payment: membership.payment,
    startDate: membership.startDate,
    endDate,
  });

  return {
    memberId: created.id,
    memberCode: created.memberCode,
    paymentId: paymentResult.paymentId,
    membershipId: paymentResult.membershipId,
    receiptNumber: paymentResult.receiptNumber,
  };
}

export function recordAttendance(
  db: SqlDatabase,
  ctx: { gymId: string; userId: string; deviceId: string },
  input: unknown,
): { id: string } {
  const data = friendlyParse(attendanceInputSchema, input);
  if (data.method === "fingerprint") {
    throw new Error("Fingerprint check-in is not enabled yet. Use face recognition or search.");
  }
  const member = db.get<{ id: string; status: string }>(
    `SELECT id, status FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [data.memberId, ctx.gymId],
  );
  if (!member) throw new Error("Member not found.");
  if (member.status === "suspended" || member.status === "cancelled") {
    throw new Error(`This member is ${member.status} and cannot check in.`);
  }

  const id = newId();
  const ts = nowIso();
  db.transaction(() => {
    db.run(
      `INSERT INTO attendance (id, gym_id, member_id, direction, method, occurred_at, device_id, confidence, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        id,
        ctx.gymId,
        data.memberId,
        data.direction,
        data.method,
        data.occurredAt,
        ctx.deviceId,
        data.confidence ?? null,
        ts,
      ],
    );
    enqueueSync(db, {
      gymId: ctx.gymId,
      entityType: "attendance",
      entityId: id,
      operation: "create",
      deviceId: ctx.deviceId,
      version: 1,
      payload: {
        id,
        gymId: ctx.gymId,
        memberId: data.memberId,
        direction: data.direction,
        method: data.method,
        occurredAt: data.occurredAt,
        deviceId: ctx.deviceId,
        confidence: data.confidence ?? null,
      },
    });
  });
  return { id };
}

/** Auto check-in/out toggle: records the opposite of the member's last event today. */
export function toggleAttendance(
  db: SqlDatabase,
  ctx: { gymId: string; userId: string; deviceId: string },
  input: { memberId: string },
): { id: string; direction: "check_in" | "check_out" } {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const last = db.get<{ direction: string }>(
    `SELECT direction FROM attendance
     WHERE member_id = ? AND gym_id = ? AND occurred_at >= ?
     ORDER BY occurred_at DESC LIMIT 1`,
    [input.memberId, ctx.gymId, todayStart.toISOString()],
  );
  const direction: "check_in" | "check_out" = last?.direction === "check_in" ? "check_out" : "check_in";
  const result = recordAttendance(db, ctx, {
    memberId: input.memberId,
    direction,
    method: "manual",
    occurredAt: nowIso(),
  });
  return { id: result.id, direction };
}

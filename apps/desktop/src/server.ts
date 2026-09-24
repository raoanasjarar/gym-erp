import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname, normalize, sep, resolve, isAbsolute } from "node:path";
import { networkInterfaces } from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import type { SqlDatabase } from "@gym-erp/database";
import { applyMigrations } from "@gym-erp/database";
import {
  archiveEmployee,
  archiveMember,
  changePassword,
  completeFirstRun,
  createMemberOffline,
  createMemberWithMembership,
  createPlan,
  createStaffOffline,
  expireOverdueMemberships,
  getAttendanceReport,
  getDashboardSummary,
  getFinancialReport,
  getGymProfile,
  getMember,
  getMemberDetail,
  getMemberStats,
  getReceiptHtml,
  isSetupComplete,
  listAttendance,
  listExpenseCategories,
  listExpenses,
  listIncome,
  listMemberships,
  listPayments,
  listPlans,
  listStaff,
  listUsers,
  loginUser,
  logoutUser,
  recordAttendance,
  recordExpenseOffline,
  recordIncomeOffline,
  recordPaymentAndActivateMembership,
  renewMembership,
  searchMembers,
  setMemberStatus,
  setPlanActive,
  toggleAttendance,
  updateEmployee,
  updateAccountProfile,
  updateGymProfile,
  updateMember,
  updatePlan,
  archiveEquipment,
  createEquipment,
  listAuditLogs,
  listEquipment,
  updateEquipment,
} from "@gym-erp/business-logic";
import { createBackup, listBackups, pruneBackups, restoreBackup } from "@gym-erp/backup-service";
import {
  applyIncomingRecords,
  countSyncItemsByStatus,
  listConflicts,
  pullRecordsSince,
  resolveConflict,
} from "@gym-erp/sync-engine";
import type { PermissionCode } from "@gym-erp/shared-types";
import { can, encryptBytes } from "@gym-erp/security";
import { createDefaultHardwareRegistry, type FaceFrame, type StoredFaceTemplate } from "@gym-erp/hardware";

export interface DesktopServerOptions {
  dataRoot: string;
  databaseFile: string;
  port?: number;
  uiDir?: string;
  host?: string;
  hubPort?: number;
  httpsPfxPath?: string;
  httpsPfxPassphrase?: string;
}

export interface DesktopServer {
  port: number;
  close(): Promise<void>;
}

interface Session {
  token: string;
  userId: string;
  gymId: string;
  organizationId: string;
  role: import("@gym-erp/shared-types").RoleCode;
  fullName: string;
  username: string;
  expiresAt: number;
}

interface RouteContext {
  gymId: string;
  organizationId: string;
  userId: string;
  deviceId: string;
  currencyCode: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function startDesktopServer(db: SqlDatabase, options: DesktopServerOptions): Promise<DesktopServer> {
  const sessions = new Map<string, Session>();
  const backupsDir = join(options.dataRoot, "data", "backups");
  const facePhotosDir = join(options.dataRoot, "data", "member-photos");
  mkdirSync(facePhotosDir, { recursive: true });
  const hardware = createDefaultHardwareRegistry();

  applyMigrations(db);

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  }

  function currentUser(req: IncomingMessage): Session | null {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      sessions.delete(token);
      return null;
    }
    return session;
  }

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res).catch((error) => {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      const message = error instanceof Error ? error.message : "Unexpected error";
      if (!res.headersSent) json(res, statusCode, { message });
    });
  };
  const server: Server = options.httpsPfxPath && existsSync(options.httpsPfxPath)
    ? createHttpsServer({ pfx: readFileSync(options.httpsPfxPath), passphrase: options.httpsPfxPassphrase }, requestHandler)
    : createServer(requestHandler);

  function requirePermission(session: Session, permission: PermissionCode): void {
    if (!can(session.role, permission)) {
      throw Object.assign(new Error("You do not have permission to do that."), { statusCode: 403 });
    }
  }

  function contextFor(session: Session): RouteContext {
    const currencyCode =
      db.get<{ currency_code: string }>(`SELECT currency_code FROM gyms WHERE id = ?`, [session.gymId])
        ?.currency_code ?? "PKR";
    const header = serverSlug(session);
    return {
      gymId: session.gymId,
      organizationId: session.organizationId,
      userId: session.userId,
      deviceId: header,
      currencyCode,
    };
  }

  function serverSlug(session: Session): string {
    return `desktop-ui-${session.userId}`;
  }

  function faceSecret(gymId: string): string {
    const key = `face-secret:${gymId}`;
    const existing = db.get<{ value: string }>("SELECT value FROM app_metadata WHERE key = ?", [key]);
    if (existing?.value) return existing.value;
    const value = randomBytes(32).toString("hex");
    db.run(
      "INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)",
      [key, value, new Date().toISOString()],
    );
    return value;
  }

  function saveSyncedMemberPhoto(record: {
    entityType: string;
    operation: string;
    entityId: string;
    payloadJson: string;
  }): void {
    if (record.entityType !== "members" || record.operation === "delete") return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(String(record.payloadJson)) as Record<string, unknown>;
    } catch {
      return;
    }
    const photoDataUrl = payload.profilePhotoBase64 ?? payload.profilePhotoDataUrl ?? payload.photoBase64;
    if (typeof photoDataUrl !== "string" || !photoDataUrl.startsWith("data:image/")) return;
    const comma = photoDataUrl.indexOf(",");
    if (comma < 0) return;
    const memberId = String(record.entityId);
    const photoPath = join(facePhotosDir, `${memberId}.jpg`);
    writeFileSync(photoPath, Buffer.from(photoDataUrl.slice(comma + 1), "base64"));
  }

  function faceFrame(body: Record<string, unknown>): FaceFrame {
    const width = Number(body.width);
    const height = Number(body.height);
    const rgbaBase64 = String(body.rgbaBase64 ?? "");
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 32 || !rgbaBase64) {
      throw Object.assign(new Error("A valid camera frame is required."), { statusCode: 400 });
    }
    const rgba = new Uint8Array(Buffer.from(rgbaBase64, "base64"));
    if (rgba.length !== width * height * 4) {
      throw Object.assign(new Error("The camera frame is incomplete."), { statusCode: 400 });
    }
    return { width, height, rgba };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (!path.startsWith("/api/")) {
      return serveStatic(path, res, options.uiDir);
    }

    // ---------- public ----------
    if (method === "GET" && path === "/api/status") {
      const setupComplete = isSetupComplete(db);
      const gym = db.get<{ name: string; currency_code: string }>(
        `SELECT name, currency_code FROM gyms ORDER BY created_at ASC LIMIT 1`,
      );
      return json(res, 200, {
        setupComplete,
        gymName: gym?.name ?? null,
        currencyCode: gym?.currency_code ?? "PKR",
      });
    }

    if (method === "POST" && path === "/api/setup") {
      if (isSetupComplete(db)) return json(res, 409, { message: "Setup was already completed." });
      const body = await readBody(req);
      const deviceId = typeof body.deviceId === "string" ? body.deviceId : randomUUID();
      try {
        const result = await completeFirstRun(db, deviceId, body);
        const plans = Array.isArray(body.plans) ? (body.plans as Array<Record<string, unknown>>) : [];
        for (const plan of plans) {
          createPlan(
            db,
            {
              gymId: result.gymId,
              userId: result.userId,
              deviceId,
              currencyCode: typeof body.currencyCode === "string" ? body.currencyCode : "PKR",
            },
            plan,
          );
        }
        return json(res, 200, result);
      } catch (error) {
        return json(res, 400, { message: error instanceof Error ? error.message : "Setup failed." });
      }
    }

    if (method === "POST" && path === "/api/login") {
      const body = await readBody(req);
      const gym = db.get<{ id: string }>(`SELECT id FROM gyms ORDER BY created_at ASC LIMIT 1`);
      if (!gym || typeof body.username !== "string" || typeof body.password !== "string") {
        return json(res, 401, { message: "Wrong username or password." });
      }
      const user = await loginUser(db, { gymId: gym.id, username: body.username, password: body.password });
      if (!user) return json(res, 401, { message: "Wrong username or password." });
      const token = randomUUID();
      sessions.set(token, {
        token,
        userId: user.user.id,
        gymId: user.user.gymId,
        organizationId: user.user.organizationId,
        role: user.user.role,
        fullName: user.user.fullName,
        username: user.user.username,
        expiresAt: Date.now() + SESSION_TTL_MS,
      });
      return json(res, 200, {
        token,
        user: { id: user.user.id, fullName: user.user.fullName, username: user.user.username, role: user.user.role },
        permissions: user.permissions,
      });
    }

    // ---------- hub sync bridge (mobile devices authenticate with device id) ----------
    if (path === "/api/hub/push" && method === "POST") {
      const deviceIdHeader = req.headers["x-gym-device"];
      if (typeof deviceIdHeader !== "string" || deviceIdHeader.length === 0) {
        return json(res, 401, { message: "Missing X-Gym-Device header." });
      }
      const body = await readBody(req);
      const records = Array.isArray(body.records) ? (body.records as Parameters<typeof applyIncomingRecords>[1]) : [];
      const result = applyIncomingRecords(db, records);
      for (const record of records) {
        if (record.operation === "create") saveSyncedMemberPhoto(record);
      }
      return json(res, 200, result);
    }
    if (path === "/api/hub/pull" && method === "GET") {
      const deviceIdHeader = req.headers["x-gym-device"];
      if (typeof deviceIdHeader !== "string" || deviceIdHeader.length === 0) {
        return json(res, 401, { message: "Missing X-Gym-Device header." });
      }
      const since = url.searchParams.get("since") ?? "1970-01-01T00:00:00.000Z";
      return json(res, 200, pullRecordsSince(db, { since, excludeDeviceId: deviceIdHeader }));
    }

    // ---------- authenticated ----------
    const session = currentUser(req);
    if (!session) return json(res, 401, { message: "Please sign in." });
    const ctx = contextFor(session);
    const body = method === "POST" || method === "PUT" || method === "DELETE" ? await readBody(req) : {};
    const q = url.searchParams;
    const seg = path.split("/");

    try {
      // dashboard & session
      if (method === "GET" && path === "/api/me") {
        return json(res, 200, {
          user: { id: session.userId, fullName: session.fullName, username: session.username, role: session.role },
          gym: getGymProfile(db, ctx.gymId),
        });
      }
      if (method === "POST" && path === "/api/logout") {
        logoutUser(db, session.token);
        sessions.delete(session.token);
        return json(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/dashboard") {
        expireOverdueMemberships(db, ctx.gymId);
        const summary = getDashboardSummary(db, ctx.gymId);
        return json(res, 200, { ...summary, sync: countSyncItemsByStatus(db) });
      }
      if (method === "GET" && path === "/api/mobile/setup") {
        const addresses = Object.values(networkInterfaces())
          .flat()
          .filter((item): item is NonNullable<typeof item> => Boolean(item && item.family === "IPv4" && !item.internal))
          .map((item) => `${options.httpsPfxPath ? "https" : "http"}://${item.address}:${options.port ?? 5178}`);
        const counts = countSyncItemsByStatus(db);
        const deviceCount = db.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM devices WHERE gym_id = ? AND is_hub = 0`,
          [session.gymId],
        )?.count ?? 0;
        return json(res, 200, {
          urls: addresses,
          syncHubPort: options.hubPort ?? 47821,
          devices: deviceCount,
          sync: counts,
        });
      }

      // members
      if (method === "POST" && path === "/api/face/enroll") {
        requirePermission(session, "members.write");
        const memberId = String(body.memberId ?? "");
        const member = getMember(db, session.gymId, memberId);
        if (!member) return json(res, 404, { message: "Member not found." });
        const frame = faceFrame(body);
        const template = await hardware.face.enroll(member.id, frame, faceSecret(session.gymId));
        const now = new Date().toISOString();
        const photoBase64 = String(body.photoBase64 ?? "");
        db.transaction(() => {
          db.run(
            `INSERT INTO biometric_templates
             (id, gym_id, member_id, kind, encrypted_payload, algorithm, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, 'face', ?, ?, ?, ?, NULL)`,
            [template.templateId, session.gymId, member.id, template.encryptedPayload, template.algorithm, now, now],
          );
          db.run(
            "UPDATE members SET face_template_id = ?, profile_photo_path = ?, updated_at = ? WHERE id = ? AND gym_id = ?",
            [template.templateId, `member-photos/${member.id}.jpg`, now, member.id, session.gymId],
          );
          if (photoBase64.startsWith("data:image/")) {
            const payload = photoBase64.slice(photoBase64.indexOf(",") + 1);
            writeFileSync(join(facePhotosDir, `${member.id}.jpg`), Buffer.from(payload, "base64"));
          }
        });
        return json(res, 200, { templateId: template.templateId, memberId: member.id });
      }

      if (method === "GET" && path === "/api/fingerprint/status") {
        requirePermission(session, "biometrics.manage");
        return json(res, 200, {
          adapter: hardware.fingerprint.adapterId,
          status: await hardware.fingerprint.getStatus(),
          enabled: hardware.fingerprint.adapterId !== "fingerprint.unplugged",
        });
      }

      if (method === "POST" && path === "/api/fingerprint/enroll") {
        requirePermission(session, "biometrics.manage");
        const memberId = String(body.memberId ?? "");
        const member = getMember(db, session.gymId, memberId);
        if (!member) return json(res, 404, { message: "Member not found." });
        await hardware.fingerprint.connect();
        const template = await hardware.fingerprint.enroll();
        const now = new Date().toISOString();
        db.transaction(() => {
          db.run(
            `INSERT INTO biometric_templates
             (id, gym_id, member_id, kind, encrypted_payload, algorithm, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, 'fingerprint', ?, ?, ?, ?, NULL)`,
            [
              template.templateId,
              session.gymId,
              member.id,
              "fingerprint.vendor-bridge",
              encryptBytes(Buffer.from(template.templateBytes), faceSecret(session.gymId)),
              now,
              now,
            ],
          );
          db.run(
            "UPDATE members SET fingerprint_template_id = ?, updated_at = ? WHERE id = ? AND gym_id = ?",
            [template.templateId, now, member.id, session.gymId],
          );
        });
        return json(res, 200, { templateId: template.templateId, memberId: member.id });
      }

      if (method === "POST" && path === "/api/fingerprint/identify") {
        requirePermission(session, "attendance.write");
        await hardware.fingerprint.connect();
        const match = await hardware.fingerprint.identify();
        if (!match.memberTemplateId) return json(res, 404, { message: "No registered member matched this fingerprint.", match });
        const row = db.get<{ member_id: string }>(
          `SELECT member_id FROM biometric_templates
           WHERE gym_id = ? AND id = ? AND kind = 'fingerprint' AND deleted_at IS NULL`,
          [session.gymId, match.memberTemplateId],
        );
        if (!row) return json(res, 404, { message: "The fingerprint is not registered to an active member.", match });
        const member = getMemberDetail(db, session.gymId, row.member_id);
        if (!member) return json(res, 404, { message: "Matched member no longer exists." });
        const activeMembership = member.memberships.find((item) => item.end_date >= new Date().toISOString().slice(0, 10));
        return json(res, 200, {
          match,
          member: member.member,
          memberships: member.memberships,
          payments: member.payments,
          activeMembership: activeMembership ?? null,
          photoDataUrl: null,
        });
      }

      if (method === "POST" && path === "/api/face/identify") {
        requirePermission(session, "members.read");
        const frame = faceFrame(body);
        const rows = db.all<{
          id: string;
          member_id: string;
          algorithm: string;
          encrypted_payload: Uint8Array;
        }>(
          `SELECT id, member_id, algorithm, encrypted_payload
           FROM biometric_templates
           WHERE gym_id = ? AND kind = 'face' AND deleted_at IS NULL`,
          [session.gymId],
        );
        const gallery: StoredFaceTemplate[] = rows.map((row) => ({
          templateId: row.id,
          memberId: row.member_id,
          algorithm: row.algorithm,
          encryptedPayload: Buffer.from(row.encrypted_payload),
        }));
        const match = await hardware.face.identify(frame, gallery, faceSecret(session.gymId));
        if (!match.memberId || !match.aboveThreshold) {
          return json(res, 404, { message: "No registered member matched this face.", match });
        }

        const member = getMemberDetail(db, session.gymId, match.memberId);
        if (!member) return json(res, 404, { message: "Matched member no longer exists." });
        const activeMembership = member.memberships.find((item) => item.end_date >= new Date().toISOString().slice(0, 10));
        return json(res, 200, {
          match,
          member: member.member,
          memberships: member.memberships,
          payments: member.payments,
          activeMembership: activeMembership ?? null,
          photoDataUrl: (() => {
            const photoPath = join(facePhotosDir, `${match.memberId}.jpg`);
            return existsSync(photoPath) ? `data:image/jpeg;base64,${readFileSync(photoPath).toString("base64")}` : null;
          })(),
        });
      }

      if (method === "GET" && seg[1] === "api" && seg[2] === "members" && seg[4] === "photo") {
        requirePermission(session, "members.read");
        const member = getMember(db, session.gymId, seg[3] ?? "");
        if (!member?.profile_photo_path) return json(res, 404, { message: "Member photo not found." });
        const filePath = join(options.dataRoot, "data", member.profile_photo_path);
        if (!existsSync(filePath)) return json(res, 404, { message: "Member photo not found." });
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=60" });
        res.end(readFileSync(filePath));
        return;
      }

      if (method === "GET" && path === "/api/members") {
        requirePermission(session, "members.read");
        const result = searchMembers(db, ctx.gymId, {
          search: q.get("search") ?? undefined,
          status: q.get("status") ?? undefined,
          limit: q.get("limit") ?? undefined,
          offset: q.get("offset") ?? undefined,
        });
        return json(res, 200, {
          ...result,
          items: result.items.map((item) => {
            const photoPath = item.profile_photo_path ? join(options.dataRoot, "data", item.profile_photo_path) : "";
            return {
              ...item,
              profile_photo_data_url: photoPath && existsSync(photoPath)
                ? `data:image/jpeg;base64,${readFileSync(photoPath).toString("base64")}`
                : null,
            };
          }),
        });
      }
      if (method === "POST" && path === "/api/members") {
        requirePermission(session, "members.write");
        return json(res, 200, createMemberOffline(db, ctx, body));
      }
      if (method === "POST" && path === "/api/members/with-membership") {
        requirePermission(session, "members.write");
        requirePermission(session, "payments.write");
        return json(res, 200, createMemberWithMembership(db, ctx, body as { member: unknown; membership: unknown }));
      }
      if (seg[1] === "api" && seg[2] === "members" && seg.length === 4 && method === "GET") {
        requirePermission(session, "members.read");
        const detail = getMemberDetail(db, ctx.gymId, seg[3] as string);
        return detail ? json(res, 200, detail) : json(res, 404, { message: "Member not found." });
      }
      if (seg[1] === "api" && seg[2] === "members" && seg.length === 4 && method === "PUT") {
        requirePermission(session, "members.write");
        updateMember(db, ctx, seg[3] as string, body);
        return json(res, 200, { ok: true });
      }
      if (seg[1] === "api" && seg[2] === "members" && seg[4] === "status" && method === "POST") {
        requirePermission(session, "members.write");
        setMemberStatus(db, ctx, seg[3] as string, body.status as "active" | "expired" | "suspended" | "pending" | "cancelled");
        return json(res, 200, { ok: true });
      }
      if (seg[1] === "api" && seg[2] === "members" && seg.length === 4 && method === "DELETE") {
        requirePermission(session, "members.delete");
        archiveMember(db, ctx, seg[3] as string);
        return json(res, 200, { ok: true });
      }

      // attendance
      if (method === "GET" && path === "/api/attendance") {
        requirePermission(session, "attendance.write");
        return json(res, 200, listAttendance(db, ctx.gymId, { day: q.get("day") ?? undefined }));
      }
      if (method === "POST" && path === "/api/attendance") {
        requirePermission(session, "attendance.write");
        return json(res, 200, recordAttendance(db, ctx, body));
      }
      if (method === "POST" && path === "/api/attendance/toggle") {
        requirePermission(session, "attendance.write");
        const member = getMember(db, ctx.gymId, String(body.memberId ?? ""));
        if (!member) return json(res, 404, { message: "Member not found." });
        return json(res, 200, toggleAttendance(db, ctx, { memberId: member.id }));
      }

      // plans & memberships
      if (method === "GET" && path === "/api/plans") {
        requirePermission(session, "members.read");
        return json(res, 200, listPlans(db, ctx.gymId, q.get("all") === "1"));
      }
      if (method === "POST" && path === "/api/plans") {
        requirePermission(session, "memberships.write");
        return json(res, 200, createPlan(db, ctx, body));
      }
      if (seg[1] === "api" && seg[2] === "plans" && seg.length === 4 && method === "PUT") {
        requirePermission(session, "memberships.write");
        updatePlan(db, ctx, seg[3] as string, body);
        return json(res, 200, { ok: true });
      }
      if (seg[1] === "api" && seg[2] === "plans" && seg[4] === "active" && method === "POST") {
        requirePermission(session, "memberships.write");
        setPlanActive(db, ctx, seg[3] as string, Boolean(body.isActive));
        return json(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/memberships") {
        requirePermission(session, "members.read");
        return json(res, 200, listMemberships(db, ctx.gymId, {
          expiringWithinDays: q.get("expiringWithinDays") ? Number(q.get("expiringWithinDays")) : undefined,
        }));
      }
      if (method === "POST" && path === "/api/memberships/renew") {
        requirePermission(session, "memberships.write");
        requirePermission(session, "payments.write");
        return json(res, 200, renewMembership(db, ctx, body));
      }

      // payments
      if (method === "GET" && path === "/api/payments") {
        requirePermission(session, "payments.read");
        return json(res, 200, listPayments(db, ctx.gymId, {
          from: q.get("from") ?? undefined,
          to: q.get("to") ?? undefined,
          memberId: q.get("memberId") ?? undefined,
          methodCode: q.get("methodCode") ?? undefined,
        }));
      }
      if (method === "POST" && path === "/api/payments") {
        requirePermission(session, "payments.write");
        return json(res, 200, recordPaymentAndActivateMembership(db, ctx, body as never));
      }
      if (seg[1] === "api" && seg[2] === "payments" && seg[4] === "receipt" && method === "GET") {
        requirePermission(session, "payments.write");
        const receipt = getReceiptHtml(db, ctx.gymId, seg[3] as string);
        if (!receipt) return json(res, 404, { message: "Payment not found." });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(receipt.html);
        return;
      }

      // expenses & income
      if (method === "GET" && path === "/api/expenses") {
        requirePermission(session, "expenses.read");
        return json(res, 200, listExpenses(db, ctx.gymId, { from: q.get("from") ?? undefined, to: q.get("to") ?? undefined }));
      }
      if (method === "POST" && path === "/api/expenses") {
        requirePermission(session, "expenses.write");
        return json(res, 200, recordExpenseOffline(db, ctx, body));
      }
      if (method === "GET" && path === "/api/expense-categories") {
        requirePermission(session, "expenses.read");
        return json(res, 200, listExpenseCategories(db, ctx.gymId));
      }
      if (method === "GET" && path === "/api/income") {
        requirePermission(session, "expenses.read");
        return json(res, 200, listIncome(db, ctx.gymId, { from: q.get("from") ?? undefined, to: q.get("to") ?? undefined }));
      }
      if (method === "POST" && path === "/api/income") {
        requirePermission(session, "expenses.write");
        return json(res, 200, recordIncomeOffline(db, ctx, body));
      }

      // equipment, audit, diagnostics, and export
      if (method === "GET" && path === "/api/equipment") {
        requirePermission(session, "diagnostics.read");
        return json(res, 200, listEquipment(db, ctx.gymId));
      }
      if (method === "POST" && path === "/api/equipment") {
        requirePermission(session, "settings.manage");
        return json(res, 200, createEquipment(db, ctx, body));
      }
      if (seg[1] === "api" && seg[2] === "equipment" && seg.length === 4 && method === "PUT") {
        requirePermission(session, "settings.manage");
        updateEquipment(db, ctx, seg[3] as string, body);
        return json(res, 200, { ok: true });
      }
      if (seg[1] === "api" && seg[2] === "equipment" && seg.length === 4 && method === "DELETE") {
        requirePermission(session, "settings.manage");
        archiveEquipment(db, ctx, seg[3] as string);
        return json(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/audit") {
        requirePermission(session, "audit.read");
        return json(res, 200, listAuditLogs(db, ctx.gymId, Number(q.get("limit") ?? 200)));
      }
      if (method === "GET" && path === "/api/diagnostics") {
        requirePermission(session, "diagnostics.read");
        const tables = db.all<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        );
        const sync = countSyncItemsByStatus(db);
        return json(res, 200, {
          ok: true,
          product: "GYM ERP",
          database: { connected: true, tables: tables.length },
          sync,
          runtime: { node: process.version, platform: process.platform, pid: process.pid },
          checkedAt: new Date().toISOString(),
        });
      }
      if (method === "GET" && path === "/api/export/members.csv") {
        requirePermission(session, "reports.read");
        const rows = db.all<Record<string, unknown>>(
          `SELECT member_code, full_name, father_name, phone, whatsapp, email, address,
                  date_of_birth, gender, emergency_contact, blood_group, join_date, status, notes
           FROM members WHERE gym_id = ? AND deleted_at IS NULL ORDER BY member_code`,
          [ctx.gymId],
        );
        const headers = Object.keys(rows[0] ?? {
          member_code: "",
          full_name: "",
          father_name: "",
          phone: "",
          whatsapp: "",
          email: "",
          address: "",
          date_of_birth: "",
          gender: "",
          emergency_contact: "",
          blood_group: "",
          join_date: "",
          status: "",
          notes: "",
        });
        const csvCell = (value: unknown): string => `"${String(value ?? "").replaceAll('"', '""')}"`;
        const csv = [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\r\n");
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="gym-erp-members.csv"',
        });
        res.end(csv);
        return;
      }

      // staff & users
      if (method === "GET" && path === "/api/staff") {
        requirePermission(session, "staff.manage");
        return json(res, 200, listStaff(db, ctx.gymId));
      }
      if (method === "POST" && path === "/api/staff") {
        requirePermission(session, "staff.manage");
        return json(res, 200, await createStaffOffline(db, ctx, body));
      }
      if (seg[1] === "api" && seg[2] === "staff" && seg.length === 4 && method === "PUT") {
        requirePermission(session, "staff.manage");
        updateEmployee(db, ctx, seg[3] as string, body);
        return json(res, 200, { ok: true });
      }
      if (seg[1] === "api" && seg[2] === "staff" && seg.length === 4 && method === "DELETE") {
        requirePermission(session, "staff.manage");
        archiveEmployee(db, ctx, seg[3] as string);
        return json(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/users") {
        requirePermission(session, "staff.manage");
        return json(res, 200, listUsers(db, ctx.gymId));
      }

      // reports
      if (method === "GET" && path === "/api/reports/financial") {
        requirePermission(session, "reports.read");
        return json(res, 200, getFinancialReport(db, ctx.gymId, q.get("from") ?? "", q.get("to") ?? ""));
      }
      if (method === "GET" && path === "/api/reports/members") {
        requirePermission(session, "reports.read");
        return json(res, 200, getMemberStats(db, ctx.gymId));
      }
      if (method === "GET" && path === "/api/reports/attendance") {
        requirePermission(session, "reports.read");
        return json(res, 200, getAttendanceReport(db, ctx.gymId, q.get("from") ?? "", q.get("to") ?? ""));
      }

      // settings
      if (method === "GET" && path === "/api/settings/gym") {
        return json(res, 200, getGymProfile(db, ctx.gymId));
      }
      if (method === "PUT" && path === "/api/settings/gym") {
        requirePermission(session, "settings.manage");
        updateGymProfile(db, ctx, body);
        return json(res, 200, { ok: true });
      }
      if (method === "PUT" && path === "/api/settings/account") {
        const username = updateAccountProfile(db, ctx, body);
        session.username = username;
        return json(res, 200, { username });
      }
      if (method === "POST" && path === "/api/settings/password") {
        await changePassword(db, { gymId: ctx.gymId, userId: ctx.userId }, body);
        return json(res, 200, { ok: true });
      }

      // backups
      if (method === "GET" && path === "/api/backups") {
        requirePermission(session, "backups.manage");
        return json(res, 200, {
          files: listBackups(backupsDir),
          records: db.all(`SELECT id, file_path, kind, status, created_at, size_bytes FROM backups ORDER BY created_at DESC LIMIT 50`),
        });
      }
      if (method === "POST" && path === "/api/backups") {
        requirePermission(session, "backups.manage");
        return json(res, 200, createBackup(db, options.databaseFile, backupsDir));
      }
      if (method === "POST" && path === "/api/backups/restore") {
        requirePermission(session, "backups.manage");
        const filePath = String(body.filePath ?? "");
        if (!filePath) return json(res, 400, { message: "Choose a backup file to restore." });
        const result = restoreBackup(options.databaseFile, filePath);
        return json(res, 200, { ...result, message: "Backup restored. Restart the app to load the restored data." });
      }
      if (method === "POST" && path === "/api/backups/prune") {
        requirePermission(session, "backups.manage");
        return json(res, 200, pruneBackups(backupsDir, Number(body.keep ?? 14)));
      }

      // sync & conflicts
      if (method === "GET" && path === "/api/sync/counts") {
        return json(res, 200, countSyncItemsByStatus(db));
      }
      if (method === "GET" && path === "/api/sync/conflicts") {
        requirePermission(session, "conflicts.resolve");
        return json(res, 200, listConflicts(db, ctx.gymId));
      }
      if (method === "POST" && path === "/api/sync/conflicts/resolve") {
        requirePermission(session, "conflicts.resolve");
        resolveConflict(db, {
          conflictId: String(body.conflictId ?? ""),
          resolution: body.resolution === "local" ? "local" : "remote",
          userId: ctx.userId,
        });
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { message: "Endpoint not found." });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
      const message = error instanceof Error ? error.message : "Request failed.";
      return json(res, statusCode, { message });
    }
  }

  return new Promise((resolve, reject) => {
    const port = options.port ?? 5178;
    server.listen(port, options.host ?? "0.0.0.0", () =>
      resolve({
        port,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      }),
    );
    server.on("error", reject);
  });
}

function isPathInside(child: string, parent: string): boolean {
  const childAbs = resolve(child);
  const parentAbs = resolve(parent);
  if (childAbs === parentAbs) return true;
  const prefix = parentAbs.endsWith(sep) ? parentAbs : `${parentAbs}${sep}`;
  return childAbs.startsWith(prefix);
}

function serveStatic(path: string, res: ServerResponse, uiDir?: string): void {
  if (!uiDir) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>GYM ERP server is running</h1><p>UI folder not configured.</p>");
    return;
  }
  if (path.includes("://") || path.includes("\0")) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad request");
    return;
  }
  const forwardSlashed = path.replaceAll("\\", "/");
  const relRaw = forwardSlashed.startsWith("/") ? forwardSlashed.slice(1) : forwardSlashed;
  const rel = relRaw === "" ? "index.html" : normalize(relRaw).replaceAll("\\", "/");
  if (rel.startsWith("../") || rel.includes("/../") || rel === "..") {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad request");
    return;
  }
  const filePath = join(uiDir, rel);
  if (!isPathInside(filePath, uiDir)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad request");
    return;
  }
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const type = MIME[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(readFileSync(filePath));
    return;
  }
  const index = join(uiDir, "index.html");
  if (existsSync(index)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(index));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

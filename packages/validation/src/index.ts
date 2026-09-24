import { z } from "zod";

export const memberInputSchema = z.object({
  fullName: z.string().trim().min(2, "Enter the member's full name."),
  fatherName: z.string().trim().optional(),
  phone: z.string().trim().min(7).max(20).optional(),
  whatsapp: z.string().trim().optional(),
  email: z.string().email("Enter a valid email.").optional().or(z.literal("")),
  address: z.string().optional(),
  dateOfBirth: z.string().optional(),
  gender: z.enum(["male", "female", "other", "unspecified"]).default("unspecified"),
  emergencyContact: z.string().optional(),
  bloodGroup: z.string().optional(),
  weightKg: z.coerce.number().positive().max(500).optional(),
  joinDate: z.string().min(8),
  notes: z.string().optional(),
  profilePhotoBase64: z.string().optional(),
  profilePhotoDataUrl: z.string().optional(),
  photoBase64: z.string().optional(),
  profilePhotoPath: z.string().optional(),
});

export const memberUpdateSchema = memberInputSchema.partial();

export const memberQuerySchema = z.object({
  search: z.string().trim().optional(),
  status: z.enum(["active", "expired", "suspended", "pending", "cancelled", "all"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const paymentInputSchema = z.object({
  amountMinor: z.number().int().positive("Enter a payment amount."),
  methodCode: z.string().min(2),
  memberId: z.string().optional(),
  membershipId: z.string().optional(),
  notes: z.string().optional(),
  paidAt: z.string().min(8),
});

export const expenseInputSchema = z.object({
  amountMinor: z.number().int().positive("Enter an expense amount."),
  categoryId: z.string().min(1),
  description: z.string().trim().min(2),
  vendor: z.string().optional(),
  incurredAt: z.string().min(8),
});

export const incomeInputSchema = z.object({
  source: z.string().trim().min(2, "Enter where this income came from."),
  amountMinor: z.number().int().positive("Enter an income amount."),
  notes: z.string().optional(),
  receivedAt: z.string().min(8),
});

export const attendanceInputSchema = z.object({
  memberId: z.string().min(1),
  direction: z.enum(["check_in", "check_out"]),
  method: z.enum(["manual", "search", "qr", "barcode", "face", "fingerprint"]),
  occurredAt: z.string().min(8),
  confidence: z.number().min(0).max(1).optional(),
});

export const planInputSchema = z.object({
  name: z.string().trim().min(2, "Enter a plan name."),
  durationDays: z.number().int().positive("Duration must be at least 1 day.").max(3650),
  priceMinor: z.number().int().min(0, "Price cannot be negative."),
});

export const planUpdateSchema = planInputSchema.partial();

export const renewMembershipSchema = z.object({
  membershipId: z.string().min(1),
  planId: z.string().min(1),
  startDate: z.string().min(8).optional(),
  payment: paymentInputSchema,
});

export const newMembershipSchema = z.object({
  memberId: z.string().min(1),
  planId: z.string().min(1),
  startDate: z.string().min(8),
  payment: paymentInputSchema,
});

export const firstRunSchema = z.object({
  gymName: z.string().trim().min(2, "Enter your gym name."),
  ownerName: z.string().trim().min(2, "Enter the owner name."),
  username: z.string().trim().min(3),
  password: z.string().min(8, "Use at least 8 characters."),
  currencyCode: z.string().length(3).default("PKR"),
});

export const firstRunPlansSchema = z.array(planInputSchema).max(12).optional();

export const staffInputSchema = z.object({
  fullName: z.string().trim().min(2, "Enter the staff member's full name."),
  phone: z.string().trim().optional(),
  role: z.enum(["admin", "manager", "receptionist", "staff"]),
  username: z.string().trim().min(3, "Choose a username with at least 3 characters."),
  password: z.string().min(8, "Use at least 8 characters."),
  salaryMinor: z.number().int().min(0).optional(),
  hireDate: z.string().optional(),
});

export const staffUpdateSchema = z.object({
  fullName: z.string().trim().min(2).optional(),
  phone: z.string().optional(),
  role: z.enum(["admin", "manager", "receptionist", "staff"]).optional(),
  salaryMinor: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const gymProfileSchema = z.object({
  name: z.string().trim().min(2, "Enter the gym name."),
  address: z.string().optional(),
  phone: z.string().optional(),
  currencyCode: z.string().length(3).optional(),
  timezone: z.string().optional(),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword: z.string().min(8, "Use at least 8 characters."),
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: "The new password must be different from the current one.",
  });

export const accountProfileSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "Use at least 3 characters for the login name.")
    .max(80, "Login name is too long.")
    .regex(/^[a-z0-9._-]+$/, "Use only letters, numbers, dots, underscores, or hyphens."),
});

export const dateRangeSchema = z.object({
  from: z.string().min(8),
  to: z.string().min(8),
});

export function friendlyParse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(first?.message ?? "Please check the form and try again.");
  }
  return result.data;
}

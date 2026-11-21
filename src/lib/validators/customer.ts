import { z } from "zod";

export const customerProductSchema = z
  .object({
    productId: z.string().min(1),
    quantity: z.coerce.number().min(0),
    ratePerUnit: z.coerce.number().min(0),
    scheduleType: z.enum(["DAILY", "ALTERNATE", "WEEKLY"]).default("DAILY"),
    alternatePattern: z.array(z.coerce.number().min(0)).default([]),
    // WEEKLY only: JS weekdays, 0=Sun … 6=Sat.
    weekdays: z.array(z.coerce.number().int().min(0).max(6)).default([]),
    anchorDate: z.string().optional().nullable(),
  })
  .refine(
    (v) =>
      v.scheduleType !== "ALTERNATE" ||
      (v.alternatePattern.length >= 2 &&
        v.alternatePattern.some((q) => q > 0)),
    {
      message:
        "Alternate schedule needs at least 2 days with at least one non-zero quantity",
      path: ["alternatePattern"],
    }
  )
  // A WEEKLY product with no weekday picked would never be delivered — reject it
  // at the form rather than silently creating a subscription that does nothing.
  .refine((v) => v.scheduleType !== "WEEKLY" || v.weekdays.length >= 1, {
    message: "Pick at least one delivery day",
    path: ["weekdays"],
  });

export const customerFormSchema = z.object({
  // Server-generated and locked (see createCustomer) — whatever the client
  // sends here is ignored on create.
  customerCode: z.string().optional(),
  name: z.string().min(1, "Name is required"),
  invoiceName: z.string().optional().nullable(),
  phone: z.string().min(7, "Phone is required"),
  secondPhone: z.string().optional().nullable(),
  email: z
    .string()
    .email("Invalid email")
    .or(z.literal(""))
    .optional()
    .nullable(),
  address: z.string().optional().nullable(),
  locationUrl: z.string().optional().nullable(),

  areaId: z.string().optional().nullable(),
  shiftId: z.string().optional().nullable(),
  riderId: z.string().optional().nullable(),

  billingType: z.enum(["CREDIT", "DAILY"]).default("CREDIT"),
  status: z
    .enum(["ACTIVE", "INACTIVE", "RECOVERY", "DISABLED", "ON_CALL"])
    .default("ACTIVE"),
  customerType: z.string().optional().nullable(),
  deliverySequence: z.coerce.number().int().min(0).nullable().optional(),

  joinDate: z.string().min(1, "Join date is required"),
  openingBalance: z.coerce.number().default(0),
  creditLimit: z.coerce.number().default(0),
  deliveryCharge: z.coerce.number().default(0),

  products: z
    .array(customerProductSchema)
    .min(1, "Add at least one product")
    .refine(
      (items) =>
        new Set(items.map((i) => i.productId)).size === items.length,
      { message: "Duplicate products are not allowed" }
    ),
});

export type CustomerFormValues = z.infer<typeof customerFormSchema>;

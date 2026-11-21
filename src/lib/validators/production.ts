import { z } from "zod";

export const productionLineSchema = z.object({
  productId: z.string().min(1),
  quantity: z.coerce.number().min(0),
});

export const productionFormSchema = z.object({
  date: z.string().min(1, "Date is required"),
  notes: z.string().optional().nullable(),
  lines: z
    .array(productionLineSchema)
    .min(1)
    .refine((l) => l.some((x) => x.quantity > 0), {
      message: "Enter quantity for at least one product",
    }),
});

export type ProductionFormValues = z.infer<typeof productionFormSchema>;

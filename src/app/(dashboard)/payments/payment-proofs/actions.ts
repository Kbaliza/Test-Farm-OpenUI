"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { toDateStrPKT } from "@/lib/pkt";
import { recordPayment } from "@/app/(dashboard)/billing/payment-receiving/actions";
import { createCustomerNotification } from "@/lib/notifications";

export type PaymentProofRow = {
  id: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  amount: number;
  method: string;
  date: string;         // ISO — when the customer says they paid
  screenshotUrl: string | null;
  status: string;       // PENDING | APPROVED | REJECTED
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

export type PaymentProofsData = { rows: PaymentProofRow[]; pendingCount: number; dbReady: boolean };

export type ProofResult = { ok: true } | { ok: false; error: string };

export async function getPaymentProofs(): Promise<PaymentProofsData> {
  await requireRole(FULL_ACCESS);
  try {
    const proofs = await db.paymentProof.findMany({
      where: { OR: [{ status: "PENDING" }, { createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }] },
      include: { customer: { select: { name: true, customerCode: true } } },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200,
    });
    const rows: PaymentProofRow[] = proofs.map((p) => ({
      id: p.id,
      customerId: p.customerId,
      customerName: p.customer.name,
      customerCode: p.customer.customerCode,
      amount: Number(p.amount),
      method: p.method,
      date: p.date.toISOString(),
      screenshotUrl: p.screenshotUrl,
      status: p.status,
      reviewNote: p.reviewNote,
      createdAt: p.createdAt.toISOString(),
      reviewedAt: p.reviewedAt?.toISOString() ?? null,
    }));
    return { rows, pendingCount: rows.filter((r) => r.status === "PENDING").length, dbReady: true };
  } catch (e) {
    console.error("[getPaymentProofs]", e);
    return { rows: [], pendingCount: 0, dbReady: false };
  }
}

// Approving a proof creates the REAL Payment (via the canonical recordPayment),
// so the customer's bill and the head balances update exactly like a manual
// entry — the only path that turns a submitted proof into money (no loophole).
export async function reviewPaymentProof(id: string, approve: boolean, note?: string): Promise<ProofResult> {
  await requireRole(FULL_ACCESS);
  try {
    const proof = await db.paymentProof.findUnique({ where: { id } });
    if (!proof) return { ok: false, error: "Proof not found." };
    if (proof.status !== "PENDING") return { ok: false, error: "This proof has already been reviewed." };

    if (approve) {
      // Claim the proof BEFORE creating the money, as an atomic compare-and-swap:
      // updateMany with status:"PENDING" in the WHERE only matches if no one else
      // has claimed it, so exactly one caller can ever get count === 1.
      //
      // The old order (create the Payment, then mark the proof approved) could
      // mint money: if the status write failed, the Payment existed but the proof
      // stayed PENDING, so the guard above passed on a retry and a SECOND Payment
      // was created for the same proof. Claiming first makes the worst case a
      // proof stuck as APPROVED with no Payment — visible and fixable — instead of
      // real money appearing from nowhere.
      const claim = await db.paymentProof.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "APPROVED", reviewedAt: new Date(), reviewNote: note?.trim() || null },
      });
      if (claim.count === 0) return { ok: false, error: "This proof has already been reviewed." };

      let res;
      try {
        res = await recordPayment({
          customerId: proof.customerId,
          amount: Number(proof.amount),
          head: proof.method.toUpperCase(),
          date: toDateStrPKT(proof.date),
          notes: `Payment proof approved${note ? ` — ${note}` : ""}`,
        });
      } catch (err) {
        // Release the claim so the proof can be reviewed again.
        await db.paymentProof.updateMany({
          where: { id, status: "APPROVED" },
          data: { status: "PENDING", reviewedAt: null, reviewNote: null },
        });
        throw err;
      }
      if (!res.ok) {
        await db.paymentProof.updateMany({
          where: { id, status: "APPROVED" },
          data: { status: "PENDING", reviewedAt: null, reviewNote: null },
        });
        return res;
      }
      await createCustomerNotification(
        proof.customerId, "PAYMENT", "Payment confirmed",
        `Your payment of Rs ${Math.round(Number(proof.amount)).toLocaleString("en-PK")} has been confirmed. Thank you!`,
      );
    } else {
      await db.paymentProof.update({
        where: { id },
        data: { status: "REJECTED", reviewedAt: new Date(), reviewNote: note?.trim() || null },
      });
      await createCustomerNotification(
        proof.customerId, "PAYMENT", "Payment not confirmed",
        note?.trim() ? `We couldn't confirm your submitted payment: ${note.trim()}` : "We couldn't confirm your submitted payment. Please contact us.",
      );
    }

    revalidatePath("/payments/payment-proofs");
    revalidatePath("/billing/payment-receiving");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to review proof." };
  }
}

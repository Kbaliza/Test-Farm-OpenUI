import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { PaymentProofsClient } from "@/components/payments/payment-proofs-client";
import { getPaymentProofs } from "./actions";

export const dynamic = "force-dynamic";

export default async function PaymentProofsPage() {
  const data = await getPaymentProofs();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Payment Proofs"
        description="Customer-submitted payment receipts. Approving one records a real payment against their bill and updates the head balances."
      />
      {!data.dbReady ? (
        <DbNotReady what="Payment Proofs" />
      ) : (
        <PaymentProofsClient data={data} />
      )}
    </div>
  );
}

import { notFound } from "next/navigation";
import { InvoiceDetailClient } from "@/components/billing/invoice-detail-client";
import { getInvoiceDetail, getProductOptions } from "../actions";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [invoice, products, user] = await Promise.all([getInvoiceDetail(id), getProductOptions(), getSessionUser()]);
  if (!invoice) notFound();

  // Only an admin may change the lines or the discount; the actions refuse
  // everyone else too, this just keeps the controls off their screen.
  return <InvoiceDetailClient invoice={invoice} products={products} canEdit={user?.role === "ADMIN"} />;
}

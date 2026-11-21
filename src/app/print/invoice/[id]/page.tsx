import { notFound } from "next/navigation";
import { getInvoiceDetail } from "@/app/(dashboard)/billing/invoices/actions";
import { InvoiceDocument } from "@/components/billing/invoice-document";
import { AutoPrint } from "@/components/billing/auto-print";

export const dynamic = "force-dynamic";

// Stand-alone print view — lives OUTSIDE the (dashboard) route group, so it
// renders without the sidebar/topbar chrome. The inline <style> undoes the root
// `h-screen overflow-hidden` so the whole invoice flows across pages.
export default async function InvoicePrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pdf?: string }>;
}) {
  const { id } = await params;
  const { pdf } = await searchParams;
  const invoice = await getInvoiceDetail(id);
  if (!invoice) notFound();
  // ?pdf=1 — the page is being printed to a file by headless Chromium, which has
  // no print dialog to open. Left in, the page would just sit there waiting.
  const forPdf = pdf === "1";

  return (
    <div className="mx-auto max-w-[680px] p-4">
      <style>{`
        html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
        @page { margin: 12mm; }
      `}</style>
      <InvoiceDocument invoice={invoice} />
      {!forPdf && <AutoPrint />}
    </div>
  );
}

import Link from "next/link";
import type { Unit } from "@/lib/units";
import { Plus } from "lucide-react";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { DbNotReady } from "@/components/db-not-ready";
import { CustomersClient, type CustomerRow } from "@/components/customers/customers-client";
import { LostCustomersClient, type LostCustomerRow } from "@/components/customers/lost-customers-client";
import { OnCallCustomersClient, type OnCallCustomerRow } from "@/components/customers/on-call-customers-client";
import { describeSchedule } from "@/lib/schedule";
import { resolveCustomerFocus, type CustomerTab } from "@/lib/customer-focus";
import { getCatalog, reconcileAutoDeactivations } from "./actions";

export const dynamic = "force-dynamic";

async function loadCustomers(): Promise<
  { ok: true; rows: CustomerRow[]; lost: LostCustomerRow[]; onCall: OnCallCustomerRow[] } | { ok: false }
> {
  try {
    // Move stale customers (no delivery for 20+ days) to Lost before we read the
    // list, so they show up in the Lost tab on this same load.
    await reconcileAutoDeactivations();

    const customers = await db.customer.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        area: true,
        shift: true,
        products: { include: { product: true } },
      },
    });

    // Total sales per customer = Σ(deliveries − returns + delivery charge) across
    // all their invoices.
    //
    // This used to sum `totalDue`, which is wrong twice over: totalDue is NET of
    // payments (so it isn't sales at all), and it *includes* prevBalance — which
    // itself carries every earlier invoice's charges. Summing it across N invoices
    // therefore counted the opening balance N times and each period's charges
    // again and again, so a customer with two years of half-monthly bills showed
    // "total sales" in the millions.
    const salesAgg = await db.invoice.groupBy({
      by: ["customerId"],
      _sum: { deliveriesAmt: true, returnsAmt: true, deliveryCharge: true, discount: true },
    });
    const salesMap = new Map(
      salesAgg.map((s) => [
        s.customerId,
        // Less any one-off allowance given on a bill — that was never charged, so
        // it was never a sale.
        Number(s._sum.deliveriesAmt ?? 0) - Number(s._sum.returnsAmt ?? 0) + Number(s._sum.deliveryCharge ?? 0) - Number(s._sum.discount ?? 0),
      ])
    );

    const rows: CustomerRow[] = [];
    const lost: LostCustomerRow[] = [];
    const onCall: OnCallCustomerRow[] = [];

    for (const c of customers) {
      const isLost = c.status === "INACTIVE" || c.status === "DISABLED";
      // On-call customers get their own tab: they are not part of the regular
      // active list (they're never routed automatically) and they are not lost.
      if (c.status === "ON_CALL") {
        onCall.push({
          id: c.id,
          customerCode: c.customerCode,
          name: c.name,
          phone: c.phone,
          areaName: c.area?.name ?? null,
          shiftName: c.shift?.name ?? null,
          products: c.products.map((cp) => ({
            id: cp.id,
            name: cp.product.name,
            quantity: Number(cp.quantity),
            unit: cp.product.unit,
          })),
        });
      } else if (isLost) {
        lost.push({
          id: c.id,
          customerCode: c.customerCode,
          name: c.name,
          phone: c.phone,
          areaName: c.area?.name ?? null,
          shiftName: c.shift?.name ?? null,
          status: c.status,
          totalSales: salesMap.get(c.id) ?? 0,
          deactivationReason: (c as { deactivationReason?: string | null }).deactivationReason ?? null,
        });
      } else {
        rows.push({
          id: c.id,
          customerCode: c.customerCode,
          name: c.name,
          phone: c.phone,
          areaName: c.area?.name ?? null,
          address: c.address,
          shiftName: c.shift?.name ?? null,
          billingType: c.billingType,
          status: c.status,
          products: c.products.map((cp) => ({
            id: cp.id,
            name: cp.product.name,
            quantity: Number(cp.quantity),
            isAlternate: cp.scheduleType === "ALTERNATE",
          })),
        });
      }
    }

    return { ok: true, rows, lost, onCall };
  } catch {
    return { ok: false };
  }
}

// ── Tab nav ───────────────────────────────────────────────────────────────────

function TabNav({ active, lost, onCall }: { active: string; lost: number; onCall: number }) {
  return (
    <div className="flex border-b border-border px-4 sm:px-6 gap-0">
      <Link
        href="/customers"
        className={
          active === "all"
            ? "border-b-2 border-primary px-4 py-2.5 text-sm font-semibold text-primary"
            : "border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        }
      >
        View Customers
      </Link>
      <Link
        href="/customers?tab=oncall"
        className={
          active === "oncall"
            ? "border-b-2 border-primary px-4 py-2.5 text-sm font-semibold text-primary flex items-center gap-1.5"
            : "border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground flex items-center gap-1.5"
        }
      >
        On Call
        {onCall > 0 && (
          <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">
            {onCall}
          </span>
        )}
      </Link>
      <Link
        href="/customers?tab=lost"
        className={
          active === "lost"
            ? "border-b-2 border-primary px-4 py-2.5 text-sm font-semibold text-primary flex items-center gap-1.5"
            : "border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground flex items-center gap-1.5"
        }
      >
        Lost Customers
        {lost > 0 && (
          <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700">
            {lost}
          </span>
        )}
      </Link>
    </div>
  );
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; find?: string }>;
}) {
  const [result, catalog, sp] = await Promise.all([
    loadCustomers(),
    getCatalog(),
    searchParams,
  ]);

  const askedTab: CustomerTab =
    sp.tab === "lost" ? "lost" : sp.tab === "oncall" ? "oncall" : "all";

  // `?find=<customerId>` — "show me THIS customer", used by anything that links to
  // one (converting a sample, say). See resolveCustomerFocus for why a plain
  // /customers link was not enough.
  const focus = result.ok
    ? resolveCustomerFocus(sp.find, { all: result.rows, onCall: result.onCall, lost: result.lost }, askedTab)
    : { tab: askedTab, search: "" };
  const tab = focus.tab;
  const focusSearch = focus.search;

  if (!result.ok) {
    return (
      <div className="flex flex-col">
        <PageHeader title="Customers" />
        <DbNotReady what="Customer list" />
      </div>
    );
  }

  const productOptions = catalog.products.map((p) => ({
    id: p.id,
    name: p.name,
    unit: p.unit as Unit,
    defaultRate: Number(p.defaultRate ?? 0),
  }));
  const areaOptions = catalog.areas.map((a) => ({
    id: a.id,
    name: a.name,
    defaultDeliveryCharge: Number(a.defaultDeliveryCharge ?? 0),
    scheduleLabel: describeSchedule(a),
  }));
  const shiftOptions = catalog.shifts.map((s) => ({ id: s.id, name: s.name }));

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Customers"
        description={`${result.rows.length} active · ${result.onCall.length} on call · ${result.lost.length} lost`}
        actions={
          tab === "all" ? (
            <Button asChild>
              <Link href="/customers/new">
                <Plus className="size-4" /> Add Customer
              </Link>
            </Button>
          ) : undefined
        }
      />

      {/* Both tabs open the same edit sheet, so both are handed the same options. */}
      <TabNav active={tab} lost={result.lost.length} onCall={result.onCall.length} />

      {tab === "all" ? (
        <CustomersClient
          initialSearch={focusSearch}
          initial={result.rows}
          products={productOptions}
          areas={areaOptions}
          shifts={shiftOptions}
        />
      ) : tab === "oncall" ? (
        <OnCallCustomersClient
          initialSearch={focusSearch}
          rows={result.onCall}
          products={productOptions}
          areas={areaOptions}
          shifts={shiftOptions}
        />
      ) : (
        <LostCustomersClient rows={result.lost} initialSearch={focusSearch} />
      )}
    </div>
  );
}

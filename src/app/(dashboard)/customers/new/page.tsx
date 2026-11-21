import { PageHeader } from "@/components/layout/page-header";
import { CustomerForm } from "@/components/customers/customer-form";
import { DbNotReady } from "@/components/db-not-ready";
import { getCatalog, nextCustomerCode } from "../actions";
import { describeSchedule } from "@/lib/schedule";

export const revalidate = 120;

export default async function NewCustomerPage() {
  const catalog = await getCatalog();
  const code = await nextCustomerCode();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Add Customer"
        description="Create a new customer account with one or more products"
      />
      {!catalog.dbReady ? (
        <DbNotReady what="Customer onboarding" />
      ) : (
        <CustomerForm
          products={catalog.products.map((p) => ({
            id: p.id,
            name: p.name,
            unit: p.unit,
            defaultRate: Number(p.defaultRate),
          }))}
          areas={catalog.areas.map((a) => ({
            id: a.id,
            name: a.name,
            defaultDeliveryCharge: Number(a.defaultDeliveryCharge),
            scheduleLabel: describeSchedule(a),
          }))}
          shifts={catalog.shifts.map((s) => ({ id: s.id, name: s.name }))}
          defaultCustomerCode={code}
        />
      )}
    </div>
  );
}

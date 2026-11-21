import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { ProductsClient } from "@/components/inventory/products-client";
import { getProducts } from "./actions";

export const revalidate = 120;

export default async function ProductsPage() {
  const { products, dbReady } = await getProducts();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Products"
        description="Manage your product catalogue — add, price, and remove products"
      />
      {!dbReady ? (
        <DbNotReady what="Products" />
      ) : (
        <ProductsClient initialProducts={products} />
      )}
    </div>
  );
}

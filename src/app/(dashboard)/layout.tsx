import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { getDashboardUser } from "@/lib/auth";
import { canAccess, landingFor } from "@/lib/access";

// The authoritative access gate. Middleware only proves you're signed in (it runs
// on the Edge and can't reach Prisma); here we resolve the DB User — the source of
// truth for role + active — and enforce the route matrix. Every dashboard page
// renders through this layout, so there is no way around it.
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getDashboardUser();

  // No staff User row, deactivated, or a non-dashboard role (e.g. a RIDER, or a
  // customer-app account). Riders keep their mobile login — they just can't come
  // in here.
  if (!user) redirect("/login?error=no_access");

  const pathname = (await headers()).get("x-pathname") ?? "/";
  // Whether this browser left the menu folded away last time.
  const collapsed = (await cookies()).get("sb_collapsed")?.value === "1";

  // A limited role that wandered onto someone else's screen goes back to its own.
  if (!canAccess(user.role, pathname)) {
    redirect(landingFor(user.role));
  }

  return (
    <DashboardShell user={user} initialCollapsed={collapsed}>
      {children}
    </DashboardShell>
  );
}

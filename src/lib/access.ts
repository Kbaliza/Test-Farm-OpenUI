import type { Role } from "@prisma/client";

// ── Role-based access: the single source of truth ─────────────────────────────
// Used by the middleware (route gate), the dashboard layout (authoritative gate)
// and the sidebar (hide what you can't reach). Add a route here and everything
// else follows.

/** Roles allowed into the web dashboard at all. RIDER is deliberately absent:
 *  riders have Supabase logins for the MOBILE app but no admin-app access. */
export const DASHBOARD_ROLES: Role[] = ["ADMIN", "MANAGER", "DOCTOR", "PACKAGING", "RETAIL_MANAGER", "CHECKLIST", "VAN_DRIVER"];

/** Roles an Admin/Manager can hand out on the Users page. VAN_DRIVER is retired
 *  from new assignments (the Van stage was removed) but kept in the enum + login
 *  routing so existing van-driver accounts keep working, now at the Retail screen. */
export const ASSIGNABLE_ROLES: Role[] = ["ADMIN", "MANAGER", "DOCTOR", "PACKAGING", "RETAIL_MANAGER", "CHECKLIST"];

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  DOCTOR: "Doctor",
  PACKAGING: "Packaging",
  RETAIL_MANAGER: "Retail Manager",
  CHECKLIST: "Checklist Only",
  VAN_DRIVER: "Van Driver",
  RIDER: "Rider (mobile only)",
  INVENTORY: "Inventory (legacy)",
  ACCOUNTANT: "Accountant (legacy)",
};

const INVENTORY_SUMMARY = "/inventory";

/** Exact routes each limited role may open. "*" = everything.
 *  Matching is EXACT on purpose: "/inventory" must never open "/inventory/production". */
const ROLE_ROUTES: Record<string, string[] | "*"> = {
  ADMIN:      "*",
  MANAGER:    "*",
  // "/checklists" is appended LAST for each limited role so landingFor() (which
  // returns index 1) is unchanged — they still land on their own module, but can
  // now reach their own daily checklist. ADMIN/MANAGER get it via "*".
  DOCTOR:     [INVENTORY_SUMMARY, "/inventory/reconciliation", "/inventory/production", "/inventory/yoghurt", "/checklists"],
  // The packaging team's inventory pages. farm-arrival stays at index 1 (landing).
  PACKAGING:  [
    INVENTORY_SUMMARY, "/inventory/farm-arrival", "/checklists",
    "/inventory/wastage", "/inventory/waste-entry", "/inventory/rider-returns", "/inventory/yoghurt",
    "/inventory/flow-log", "/inventory/missing",
    "/over-the-counter/sale", "/over-the-counter/purchase",
  ],
  // The consignment module, plus the retail end of the milk chain: receiving
  // what packaging sends across, and going through what the riders brought back.
  // Everything after index 1 is appended on purpose — landingFor() returns index
  // 1, so inserting earlier would silently change where a retail manager lands
  // after signing in.
  RETAIL_MANAGER: [
    INVENTORY_SUMMARY, "/retail", "/checklists", "/retail/inventory",
    "/inventory/retail", "/inventory/rider-returns", "/inventory/flow-log", "/inventory/missing",
  ],
  // Staff with no other job in the software. Exactly one route — not even the
  // inventory summary every other limited role gets — so the sidebar shows a single
  // item and there is nothing else to wander onto. landingFor() returns index 1 and
  // falls back to index 0, so a one-route list lands correctly; keep it one route,
  // or the second entry silently becomes the landing page.
  CHECKLIST:  ["/checklists"],
  // Van stage removed — van-driver accounts now land on and work the Retail screen.
  VAN_DRIVER: [INVENTORY_SUMMARY, "/inventory/retail", "/checklists"],
  RIDER:      [],
  INVENTORY:  [],
  ACCOUNTANT: [],
};

/** The page a role lands on after signing in (and where it's bounced back to). */
export function landingFor(role: Role | string): string {
  const routes = ROLE_ROUTES[role];
  if (routes === "*") return "/";
  // The role's own module (the 2nd entry) — falling back to the summary.
  return routes?.[1] ?? routes?.[0] ?? "/login";
}

/**
 * Pages that "*" does NOT open — the one place a full-access role is narrowed.
 *
 * ADMIN and MANAGER both hold "*", so this is how a page is kept from one of
 * them. The audit log was admins-only at first; managers were let in on
 * 14 October 2026 so they can check their own team's entries. Anyone below
 * manager still never sees it.
 */
export const RESTRICTED_ROUTES: Record<string, Role[]> = {
  "/audit-log": ["ADMIN", "MANAGER"],
  // Where every rider is right now — the office only.
  "/customers/riders-live": ["ADMIN", "MANAGER"],
};

/** Can this role open this pathname? */
export function canAccess(role: Role | string, pathname: string): boolean {
  const routes = ROLE_ROUTES[role];
  if (!routes) return false;

  // Normalise trailing slash ("/inventory/" -> "/inventory").
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  // Checked before "*", or a full-access role would walk straight past it.
  const restricted = RESTRICTED_ROUTES[path];
  if (restricted) return restricted.includes(role as Role);

  if (routes === "*") return true;
  return routes.includes(path);
}

/** Roles permitted to reach the Users module. */
export const USER_ADMIN_ROLES: Role[] = ["ADMIN", "MANAGER"];

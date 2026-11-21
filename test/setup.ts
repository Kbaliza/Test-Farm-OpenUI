import { vi, beforeAll, afterAll, afterEach } from "vitest";
import { config as loadEnv } from "dotenv";
loadEnv(); // DATABASE_URL etc.

import { PrismaClient } from "@prisma/client";
import { makePrismaClient } from "@/lib/db";
import { setAuditActor } from "@/lib/audit-actor";

// Shared prisma client for tests + the global singleton the app's `@/lib/db` reads.
//
// Built by the SAME factory the app builds its client with, so the tests exercise
// what production runs — including the extension that puts the audit actor on the
// wire. A bare client here would leave every test write unattributed while
// production attributed it correctly, and the suite would prove nothing about the
// one thing it is meant to guard.
//
// The factory is called here rather than importing the app's `db` because dotenv
// has to load before anything reads DATABASE_URL, and static imports run first.
const prisma = makePrismaClient() as unknown as PrismaClient;
(globalThis as unknown as { __prisma?: PrismaClient }).__prisma = prisma;
export const db = prisma;

// A mutable holder for the "signed-in" user the mocked auth returns. Filled in
// beforeAll with a REAL User row so foreign keys (enteredById, etc.) resolve.
// vi.hoisted so the (hoisted) vi.mock factory below can close over it. Not exported
// directly (Vitest forbids exporting a hoisted binding) — use the setters below.
const authHolder = vi.hoisted(() => ({
  user: null as null | { id: string; name: string; email: string; role: string; active: boolean },
  role: "ADMIN" as string, // tests can flip this to exercise permission guards
}));

/** Tests use these to exercise permission guards without touching real auth. */
export function setTestRole(role: string) { authHolder.role = role; }
export function resetTestRole() { authHolder.role = "ADMIN"; }

// Mock auth: keep AuthError + FULL_ACCESS, but resolve the guards against authHolder.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  const current = () => {
    const u = authHolder.user;
    if (!u) throw new Error("test authHolder.user not initialised");
    const who = { ...u, role: authHolder.role } as typeof u;
    // The real getSessionUser does this; without it every test write would be
    // logged as "unknown" and the audit tests would assert the opposite of what
    // production does.
    setAuditActor({ id: who.id, name: who.name, role: who.role });
    return who;
  };
  return {
    ...actual,
    getSessionUser: vi.fn(async () => current()),
    getDashboardUser: vi.fn(async () => current()),
    requireUser: vi.fn(async () => current()),
    requireAdmin: vi.fn(async () => {
      const u = current();
      if (u.role !== "ADMIN") throw new actual.AuthError("You do not have permission to do that.");
      return u;
    }),
    requireRole: vi.fn(async (roles: string[]) => {
      const u = current();
      if (!roles.includes(u.role)) throw new actual.AuthError("You do not have permission to do that.");
      return u;
    }),
  };
});

// Server actions call these Next helpers — no-op them outside a request.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => {}, getAll: () => [] })),
  headers: vi.fn(async () => new Map()),
}));

const TEST_ADMIN_EMAIL = "__vitest_admin@test.local";

beforeAll(async () => {
  // A real ADMIN User row so actions that stamp enteredById have a valid FK.
  const user = await prisma.user.upsert({
    where: { email: TEST_ADMIN_EMAIL },
    update: { role: "ADMIN", active: true, name: "Vitest Admin" },
    create: { email: TEST_ADMIN_EMAIL, name: "Vitest Admin", role: "ADMIN", active: true, supabaseId: "vitest-admin-" + Date.now() },
  });
  authHolder.user = { id: user.id, name: user.name, email: user.email, role: "ADMIN", active: true };
  authHolder.role = "ADMIN";
});

// Per-test cleanup registry — helpers push teardown callbacks; run in reverse
// after each test so fixtures (and their rows) don't accumulate in the real DB.
export const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn(); } catch (e) { /* best-effort */ void e; }
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

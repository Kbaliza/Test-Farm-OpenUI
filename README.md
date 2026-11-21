# Dairy Suite

Next.js 16 app for dairy farm management — production, deliveries, billing, ledgers, and reports.

Stack: Next.js · TypeScript · Tailwind v4 · shadcn/ui (radix) · Prisma · Postgres (Supabase).

## What's built so far (Phase 1 + customer/milk entry)

| Section | Screen | Status |
|---|---|---|
| Layout | Sidebar + topbar | done |
| Dashboard | KPI cards, head balances, budget tracker, sales/rider/leads/collection panels | scaffolded |
| Customers | Add Customer (multi-item + alternate schedule) | done |
| Customers | View Customers | done |
| Inventory | Production / Milk Entry | done |
| Everything else | Routes wired, "Coming soon" placeholders | done |

## Setup

1. Install deps:
   ```bash
   npm install
   ```

2. Point `DATABASE_URL` in `.env` to a Postgres instance. For Supabase, use the **session pooler** connection string. For local Postgres, you can spin one up however you like.

3. Push schema to the DB and seed catalog data:
   ```bash
   npm run db:push
   npm run db:seed
   ```

4. Run the dev server:
   ```bash
   npm run dev
   ```

   Open <http://localhost:3000>.

If `DATABASE_URL` isn't reachable, every screen still renders — pages that need data show a friendly "Database not connected" card.

## Scripts

- `npm run dev` — start Next.js dev server
- `npm run build` / `npm start` — production build & run
- `npm run db:push` — sync schema to Postgres (no migration history)
- `npm run db:generate` — regenerate Prisma client after schema edits
- `npm run db:seed` — create products / shifts / areas / expense categories
- `npm run db:studio` — open Prisma Studio to browse data

## Architecture quick notes

- **Route group `(dashboard)`** — all main screens share the sidebar/topbar layout.
- **Server actions** under `src/app/(dashboard)/*/actions.ts` — typed entry points for mutations (e.g. `createCustomer`, `logProduction`).
- **`LedgerEntry` table is the single source of truth for money.** Customer balances, head balances, vendor outstanding, etc. are aggregations of this table.
- **`CustomerProduct` supports multi-item per customer**, and alternate-day schedules are stored as a `Decimal[]` pattern that loops from `anchorDate`.
- **Areas have a `defaultDeliveryCharge`** — auto-fills on the customer form.

## Next phases

1. **Inventory loop** — Farm-to-Distribution arrival, Rider Received/Delivered/Returned, Replacement, Inventory Summary.
2. **Pre-Delivery / Shift Editor** — drag-and-drop route builder + map.
3. **Billing + Payments** — invoice generator, payment receiving, expenses, vendors, monthly receiving, rider cash, recovery, salaries.
4. **Cross-cutting** — universal ledger, daily notes, alerts engine, dashboard wired to real aggregates.

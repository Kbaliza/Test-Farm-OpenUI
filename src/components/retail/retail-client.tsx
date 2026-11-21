"use client";

import Link from "next/link";

import { useMemo, useState, useTransition } from "react";
import { unitLabel, isPackUnit, packLabel, qtyLabel } from "@/lib/units";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Store, Plus, Search, CalendarClock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  voidRetailPlacement,
  type RetailContext,
  type RetailOverview,
  type RetailMartsData,
  type RetailStockRow,
  type PlacementView,
} from "@/app/(dashboard)/retail/actions";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { RetailPlacementDialog } from "./retail-placement-dialog";
import { RetailResolveDialog } from "./retail-resolve-dialog";
import { RetailMartsTab } from "./retail-marts-tab";

export function fmt(n: number) {
  return Math.abs(Math.round(n)).toLocaleString("en-PK");
}

export function fmtQty(n: number) {
  return n % 1 === 0 ? n.toFixed(0) : String(Math.round(n * 1000) / 1000);
}


const STATUS_BADGE: Record<PlacementView["status"], string> = {
  OPEN: "bg-amber-100 text-amber-700 border-amber-200",
  PART: "bg-sky-100 text-sky-700 border-sky-200",
  CLOSED: "bg-emerald-100 text-emerald-700 border-emerald-200",
  VOID: "bg-muted text-muted-foreground border-border",
};

const STATUS_LABEL: Record<PlacementView["status"], string> = {
  OPEN: "At shop",
  PART: "Part reported",
  CLOSED: "Settled",
  VOID: "Voided",
};

export function RetailClient({
  context,
  overview,
  marts,
  stock,
}: {
  context: RetailContext;
  overview: RetailOverview;
  marts: RetailMartsData;
  /** Read-only: how much of each retail product is on hand right now. */
  stock: RetailStockRow[];
}) {
  const router = useRouter();
  const refresh = () => router.refresh();

  const [addOpen, setAddOpen] = useState(false);
  const [resolving, setResolving] = useState<PlacementView | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | PlacementView["status"]>("ALL");
  const [followTab, setFollowTab] = useState<"due" | "overdue" | "upcoming" | "all">("due");

  const k = overview.kpis;

  // A drop needs chasing while anything on it is still unreported. Once it is
  // fully reported there is nothing to ask about — the money is chased on the
  // Marts tab instead.
  const chaseable = useMemo(
    () => overview.placements.filter((p) => !p.voided && p.status !== "CLOSED"),
    [overview.placements]
  );
  const followLists = useMemo(
    () => ({
      overdue: chaseable.filter((p) => p.bucket === "overdue"),
      due: chaseable.filter((p) => p.bucket === "due"),
      upcoming: chaseable.filter((p) => p.bucket === "upcoming"),
      all: chaseable,
    }),
    [chaseable]
  );
  const toAction = followLists.due.length + followLists.overdue.length;

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return overview.placements.filter((p) => {
      if (statusFilter !== "ALL" && p.status !== statusFilter) return false;
      if (!q) return true;
      return (
        p.martName.toLowerCase().includes(q) ||
        p.placementNo.toLowerCase().includes(q) ||
        p.lines.some((l) => l.productName.toLowerCase().includes(q))
      );
    });
  }, [overview.placements, search, statusFilter]);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Sold" value={`₨ ${fmt(k.soldValue)}`} tone="text-emerald-700" hint="reported sold" />
        <Kpi label="Received" value={`₨ ${fmt(k.received)}`} tone="text-emerald-700" hint="money collected" />
        <Kpi label="Payment pending" value={`₨ ${fmt(k.pending)}`} tone="text-rose-700" hint="sold, not paid" />
        <Kpi label="Out at marts" value={`₨ ${fmt(k.outAtMarts)}`} tone="text-amber-700" hint="still on their shelf" />
        <Kpi
          label="Expired"
          value={k.wastedCost == null ? "—" : `₨ ${fmt(k.wastedCost)}`}
          tone="text-rose-700"
          hint={k.wastedCost == null ? "set a cost to value this" : `our cost · ₨ ${fmt(k.wastedValue)} of sales`}
        />
        <Kpi label="Active marts" value={String(k.activeMarts)} tone="text-sky-700" hint="shops we supply" />
      </div>

      {/* What is on the shelf right now. Read-only on purpose: this page is about
          the shops. Counting stock in and setting a cost live on Retail Inventory. */}
      {stock.length > 0 && (
        <div>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              In stock
            </h2>
            <Link href="/retail/inventory" className="text-[11px] text-primary hover:underline">
              Retail Inventory →
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {stock.map((r) => (
              <div key={r.productId} className="rounded-lg border border-border bg-card p-3">
                <p className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground" title={r.productName}>
                  {r.productName}
                </p>
                <p className={cn("mt-1 text-xl font-bold tabular-nums", r.onHand > 0 ? "text-sky-700" : "text-rose-700")}>
                  {qtyLabel(r.unit, r.onHand)}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {r.atShops > 0 ? `${fmtQty(r.atShops)} at shops` : r.onHand > 0 ? "ready to drop" : "none left"}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <Tabs defaultValue="followups">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="followups">
              Follow-ups
              {toAction > 0 && (
                <span className="ml-1.5 rounded-full bg-rose-100 px-1.5 text-[10px] font-semibold text-rose-700">
                  {toAction}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="log">Drops</TabsTrigger>
            <TabsTrigger value="marts">Marts</TabsTrigger>
          </TabsList>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 size-3.5" /> Record a drop
          </Button>
        </div>

        {/* ── Follow-ups ── */}
        <TabsContent value="followups" className="mt-3">
          <div className="mb-3 flex flex-wrap gap-1.5">
            {(
              [
                ["due", "Due now", followLists.due.length],
                ["overdue", "Overdue", followLists.overdue.length],
                ["upcoming", "Upcoming", followLists.upcoming.length],
                ["all", "All open", followLists.all.length],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFollowTab(key)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  followTab === key
                    ? "border-foreground bg-foreground text-background"
                    : "border-border text-muted-foreground hover:bg-muted/50"
                )}
              >
                {label} ({count})
              </button>
            ))}
          </div>

          {followLists[followTab].length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              text={
                followTab === "due"
                  ? "Nothing to chase today."
                  : followTab === "overdue"
                    ? "No overdue visits — all caught up."
                    : followTab === "upcoming"
                      ? "Nothing scheduled yet."
                      : "No open drops. Record one to get started."
              }
            />
          ) : (
            <div className="space-y-2">
              {followLists[followTab].map((p) => (
                <FollowupRow key={p.id} p={p} onResolve={() => setResolving(p)} />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Placement log ── */}
        <TabsContent value="log" className="mt-3 space-y-3">
          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 p-3">
              <div className="relative min-w-[200px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search shop, drop no. or product…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-9 pl-9"
                />
              </div>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
                <SelectTrigger className="h-9 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All ({overview.placements.length})</SelectItem>
                  {(["OPEN", "PART", "CLOSED", "VOID"] as const).map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABEL[s]} ({overview.placements.filter((p) => p.status === s).length})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(search || statusFilter !== "ALL") && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch("");
                    setStatusFilter("ALL");
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear filters
                </button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">Drop</TableHead>
                      <TableHead>Shop</TableHead>
                      <TableHead>Products</TableHead>
                      <TableHead className="w-24">Date</TableHead>
                      <TableHead className="w-28">Status</TableHead>
                      <TableHead className="w-24 text-right">Dropped</TableHead>
                      <TableHead className="w-24 text-right">Sold</TableHead>
                      <TableHead className="w-24 text-right">Expired</TableHead>
                      <TableHead className="w-24 text-right">Still out</TableHead>
                      <TableHead className="w-28" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={10} className="h-24 text-center text-sm text-muted-foreground">
                          {overview.placements.length === 0
                            ? "No drops recorded yet — use “Record a drop”."
                            : "No drops match your filters."}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filtered.map((p) => <LogRow key={p.id} p={p} onResolve={() => setResolving(p)} onChanged={refresh} />)
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Marts ── */}
        <TabsContent value="marts" className="mt-3">
          <RetailMartsTab marts={marts} heads={context.heads} onChanged={refresh} />
        </TabsContent>
      </Tabs>

      <RetailPlacementDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        context={context}
        onSaved={refresh}
      />
      <RetailResolveDialog
        placement={resolving}
        heads={context.heads}
        today={context.today}
        onClose={() => setResolving(null)}
        onSaved={refresh}
      />
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Kpi({ label, value, tone, hint }: { label: string; value: string; tone: string; hint: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-xl font-bold tabular-nums", tone)}>{value}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function EmptyState({ icon: Icon, text }: { icon: typeof Store; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-12 text-center text-muted-foreground">
      <Icon className="size-8 opacity-30" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

function FollowupRow({ p, onResolve }: { p: PlacementView; onResolve: () => void }) {
  const tone =
    p.bucket === "overdue"
      ? { box: "bg-rose-50 text-rose-700", chip: "bg-rose-100 text-rose-700" }
      : p.bucket === "due"
        ? { box: "bg-amber-50 text-amber-700", chip: "bg-amber-100 text-amber-700" }
        : { box: "bg-sky-50 text-sky-700", chip: "bg-sky-100 text-sky-700" };

  const stillOut = p.lines.filter((l) => l.openQty > 0.000001);

  return (
    <button
      type="button"
      onClick={onResolve}
      className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-muted/40"
    >
      <div className={cn("grid size-11 shrink-0 place-items-center rounded-lg", tone.box)}>
        <span className="text-base font-bold leading-none">{p.ageDays}</span>
        <span className="text-[8px] font-semibold uppercase">days</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">
          <Link
            href={`/ledgers?type=retail&id=${p.martId}`}
            className="underline-offset-2 hover:underline"
            title={`Open ${p.martName}'s ledger`}
          >
            {p.martName}
          </Link>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {stillOut
            .map((l) =>
              isPackUnit(l.unit)
                ? `${fmtQty(l.openQty)} × ${packLabel(l.unit, l.packSize) || unitLabel(l.unit)} ${l.productName}`
                : `${fmtQty(l.openQty)} ${unitLabel(l.unit)} ${l.productName}`
            )
            .join(" · ")}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {p.placementNo} · dropped {p.date} · check back {p.dueDate}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-bold tabular-nums">₨ {fmt(p.openValue)}</p>
        <span className={cn("mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold", tone.chip)}>
          {p.bucket === "overdue"
            ? `${p.overdueDays}d overdue`
            : p.bucket === "due"
              ? "Due today"
              : `In ${Math.max(1, -0 + daysUntil(p.dueDate, p.date, p.ageDays))}d`}
        </span>
      </div>
    </button>
  );
}

// Days from today until the check-back date, derived from the two figures the
// server already computed so the client does no date maths of its own.
function daysUntil(dueDate: string, dropDate: string, ageDays: number): number {
  const [dy, dm, dd] = dueDate.split("-").map(Number);
  const [py, pm, pd] = dropDate.split("-").map(Number);
  const gap = Math.round((Date.UTC(dy, dm - 1, dd) - Date.UTC(py, pm - 1, pd)) / 86_400_000);
  return Math.max(0, gap - ageDays);
}

function LogRow({
  p,
  onResolve,
  onChanged,
}: {
  p: PlacementView;
  onResolve: () => void;
  onChanged: () => void;
}) {
  const [pending, start] = useTransition();
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState("");

  // This used to call window.prompt, which is why the button could look dead.
  // Chrome offers "prevent this page from creating additional dialogs" after a
  // couple of them and it sticks for the tab; from then on prompt() returns null
  // immediately, the early return fired, and NOTHING happened — no request, no
  // toast, no error. Three drops voided fine before it started being ignored,
  // which is exactly the shape of that suppression. An in-app dialog cannot be
  // blocked.
  function voidDrop() {
    start(async () => {
      try {
        const res = await voidRetailPlacement(p.id, reason);
        if (res.ok) {
          toast.success(`${p.placementNo} voided — stock returned.`);
          setVoidOpen(false);
          setReason("");
          onChanged();
        } else {
          toast.error(res.error);
        }
      } catch (err) {
        // Voiding is admin-only and requireAdmin() THROWS rather than returning
        // an error. Without this catch the rejection died inside the transition
        // and the click looked ignored.
        toast.error(err instanceof Error ? err.message : "Could not void that drop.");
      }
    });
  }

  return (
    <TableRow className={cn(p.voided && "opacity-60")}>
      <TableCell className="font-mono text-xs">{p.placementNo}</TableCell>
      <TableCell className="font-medium">
        {/* Straight to the shop's ledger — the usual next question about a drop
            is what this shop owes, and hunting for them on the Ledgers page was
            the only way to ask it. */}
        <Link
          href={`/ledgers?type=retail&id=${p.martId}`}
          className="underline-offset-2 hover:text-foreground hover:underline"
          title={`Open ${p.martName}'s ledger`}
        >
          {p.martName}
        </Link>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {p.lines
          .map((l) =>
            isPackUnit(l.unit)
              ? `${fmtQty(l.quantity)} × ${packLabel(l.unit, l.packSize) || unitLabel(l.unit)} ${l.productName}`
              : `${fmtQty(l.quantity)} ${unitLabel(l.unit)} ${l.productName}`
          )
          .join(" · ")}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs">{p.date}</TableCell>
      <TableCell>
        <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", STATUS_BADGE[p.status])}>
          {STATUS_LABEL[p.status]}
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums">₨ {fmt(p.droppedValue)}</TableCell>
      <TableCell className="text-right tabular-nums text-emerald-700">
        {p.soldValue > 0 ? `₨ ${fmt(p.soldValue)}` : "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums text-rose-700">
        {p.wastedValue > 0 ? `₨ ${fmt(p.wastedValue)}` : "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums text-amber-700">
        {p.openValue > 0 ? `₨ ${fmt(p.openValue)}` : "—"}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {!p.voided && p.status !== "CLOSED" && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onResolve}>
              Report
            </Button>
          )}
          {!p.voided && p.status === "OPEN" && (
            <button
              type="button"
              onClick={() => setVoidOpen(true)}
              disabled={pending}
              title="Void this drop (admin) — returns the stock"
              className="grid size-7 shrink-0 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}

          <Dialog open={voidOpen} onOpenChange={(v) => { if (!pending) { setVoidOpen(v); if (!v) setReason(""); } }}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle className="text-sm">Void {p.placementNo}?</DialogTitle>
              </DialogHeader>
              <p className="text-xs text-muted-foreground">
                The {fmt(p.droppedValue)} rupees of stock dropped at{" "}
                <span className="font-medium text-foreground">{p.martName}</span> goes back to storage.
                The drop stays on this list, marked voided, so the history is kept.
              </p>
              <Input
                autoFocus
                value={reason}
                onChange={(ev) => setReason(ev.target.value)}
                placeholder="Reason (optional)"
                className="h-9 text-sm"
                onKeyDown={(ev) => { if (ev.key === "Enter" && !pending) voidDrop(); }}
              />
              <DialogFooter className="gap-2">
                <Button variant="outline" size="sm" onClick={() => setVoidOpen(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button size="sm" onClick={voidDrop} disabled={pending}>
                  {pending ? "Voiding…" : "Void the drop"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </TableCell>
    </TableRow>
  );
}

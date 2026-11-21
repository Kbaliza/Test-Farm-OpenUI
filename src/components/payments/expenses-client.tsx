"use client";

import { useState, useMemo, useTransition, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Trash2, Plus, Receipt, TrendingDown, ChevronsUpDown, Search, Image as ImageIcon, Loader2, X, Eye, Paperclip, ClipboardPaste } from "lucide-react";
import { readClipboardImages, usePastedImages } from "@/lib/clipboard-images";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { todayPKTString } from "@/lib/pkt";
import {
  addExpense,
  deleteExpense,
  deleteSalaryPayment,
  getRecentExpenses,
  addChitsToExpense,
  type CategoryOption,
  type EmployeeOption,
  type VendorOption,
  type RiderOption,
  type HeadBalance,
  type ExpenseEntry,
  type BudgetRow, addExpenseItem } from "@/app/(dashboard)/payments/expenses/actions";
import { RECENT_RANGES, DEFAULT_RECENT_RANGE, type RecentRange, type DateWindow } from "@/lib/expense-ranges";
import { PAYMENT_HEADS, PAYMENT_HEAD_LABELS, type PaymentHeadName } from "@/lib/payment-heads";
import {
  EXPENSE_TYPES, categoriesForType, pickerItems, isFreeTextItemCategory,
  SALARY_CATEGORY, VENDOR_CATEGORY,
} from "@/lib/expense-taxonomy";
import {
  MAX_CHIT_TOTAL_BYTES, MAX_CHIT_FILES, chitSetProblem, isAllowedChitType, fmtBytes,
} from "@/lib/expense-chits";

// ── constants ─────────────────────────────────────────────────────────────────

const HEAD_LABELS: Record<string, string> = PAYMENT_HEAD_LABELS;

const HEAD_COLORS: Record<string, string> = {
  RIDER_CASH: "text-blue-700",
  HBL: "text-teal-700",
  MEEZAN: "text-purple-700",
  JAZZCASH: "text-amber-700",
  EASYPAISA: "text-orange-700",
  CASH: "text-slate-700",
} satisfies Record<PaymentHeadName, string>;

/** Background only: the text is the page's own colour, so a category reads as text. */
const CAT_COLORS: string[] = [
  "bg-blue-50",
  "bg-emerald-50",
  "bg-violet-50",
  "bg-amber-50",
  "bg-orange-50",
  "bg-slate-100",
];

// ── helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return Math.abs(n).toLocaleString("en-PK");
}

function fmtShortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Asia/Karachi",
    day: "2-digit",
    month: "short",
  });
}

// ── Searchable select (combobox) ───────────────────────────────────────────────

type ComboOption = { id: string; label: string; hint?: string; hintClass?: string };

function SearchableSelect({
  options, value, onChange, placeholder, searchPlaceholder, emptyText,
}: {
  options: ComboOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  searchPlaceholder?: string;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = options.find((o) => o.id === value) ?? null;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? options.filter((o) => o.label.toLowerCase().includes(q) || (o.hint?.toLowerCase().includes(q) ?? false))
      : options;
    return list.slice(0, 50);
  }, [options, query]);

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQuery(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="mt-1 flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-xs"
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <div className="relative border-b border-border p-2">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder ?? "Search…"}
            className="h-8 pl-7 text-xs"
          />
        </div>
        <div className="max-h-60 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              {emptyText ?? "No matches."}
            </p>
          ) : (
            matches.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => { onChange(o.id); setOpen(false); setQuery(""); }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted",
                  value === o.id && "bg-muted"
                )}
              >
                <span className="truncate font-medium">{o.label}</span>
                {o.hint ? <span className={cn("shrink-0 text-xs font-semibold", o.hintClass ?? "text-muted-foreground")}>{o.hint}</span> : null}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Head balance cards ────────────────────────────────────────────────────────

function HeadCards({ balances }: { balances: HeadBalance[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {balances.map((h) => (
        <div key={h.head} className="rounded-xl border border-border bg-card p-3 text-center">
          <p className="text-[11px] text-muted-foreground mb-1">{h.label}</p>
          <p className={`text-lg font-semibold ${HEAD_COLORS[h.head] ?? "text-foreground"}`}>
            {h.balance < 0 ? "−" : ""}Rs {fmt(h.balance)}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── Chit toggle (simple Yes / No) ────────────────────────────────────────────

function ChitToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => onChange(true)}
        className={`flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
          value
            ? "bg-emerald-50 border-emerald-600 text-emerald-700"
            : "border-border text-muted-foreground hover:bg-muted/40"
        }`}
      >
        ✓ Yes
      </button>
      <button
        type="button"
        onClick={() => onChange(false)}
        className={`flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
          !value
            ? "bg-rose-50 border-rose-500 text-rose-700"
            : "border-border text-muted-foreground hover:bg-muted/40"
        }`}
      >
        ✗ No
      </button>
    </div>
  );
}

// ── Add expense form ──────────────────────────────────────────────────────────

function AddExpenseForm({
  categories,
  employees,
  vendors,
  headBalances,
  extraItems,
  onSaved,
}: {
  categories: CategoryOption[];
  employees: EmployeeOption[];
  vendors: VendorOption[];
  headBalances: HeadBalance[];
  extraItems: Record<string, string[]>;
  onSaved: () => void;
}) {
  // Items added from this page, on top of the fixed list. Kept locally too, so a
  // just-added item is in the dropdown at once rather than after a reload.
  const [addedItems, setAddedItems] = useState<Record<string, string[]>>(extraItems);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [newItem, setNewItem] = useState("");
  const [addingItem, setAddingItem] = useState(false);
  const [pending, startTransition] = useTransition();
  const [date, setDate]           = useState(todayPKTString());
  const [amount, setAmount]       = useState("");
  const [description, setDescription] = useState("");
  // Default the source to CASH (the main till), not RIDER_CASH. Defaulting to rider
  // cash meant every expense silently drained the riders' uncollected cash, desyncing
  // it from the real head balance. Rider cash is still selectable when it's genuinely
  // the source.
  const [head, setHead]           = useState("CASH");
  const [chit, setChit]           = useState(false);
  // Which month a salary is FOR (defaults to the current month). Lets a salary paid
  // from the Expenses tab land in the correct period in the Salaries tab.
  const [salaryMonth, setSalaryMonth] = useState(todayPKTString().slice(0, 7));
  // A chit is often several pages, so this is a list. `bytes` is the real uploaded
  // size, kept so the 10 MB ceiling is measured rather than guessed at.
  const [chits, setChits] = useState<{ url: string; name: string; bytes: number }[]>([]);
  const [chitUploading, setChitUploading] = useState(false);
  const chitBytesUsed = chits.reduce((sum, c) => sum + c.bytes, 0);

  // Taxonomy selection: Expense Type -> Category -> Item.
  const firstCategoryFor = (type: string) =>
    categoriesForType(type).find((n) => categories.some((c) => c.name === n)) ?? "";
  const [expenseType, setExpenseType]   = useState<string>(EXPENSE_TYPES[0]);
  const [categoryName, setCategoryName] = useState<string>(() => firstCategoryFor(EXPENSE_TYPES[0]));
  const [item, setItem] = useState("");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const [selectedVendorId, setSelectedVendorId]     = useState("");

  /**
   * Uploads the picked photos, refusing the batch BEFORE sending anything if it
   * would break the 10 MB ceiling — uploading first and rejecting afterwards would
   * leave orphans in the bucket and waste the wait on a phone connection.
   *
   * Uploads are sequential on purpose: these are phone photos over mobile data, and
   * firing five at once is how the slowest one times out.
   */
  async function handleChitFiles(files: File[]) {
    const problem = chitSetProblem([...chits.map((c) => c.bytes), ...files.map((f) => f.size)]);
    if (problem) { toast.error(problem); return; }
    const bad = files.find((f) => !isAllowedChitType(f.type));
    if (bad) { toast.error("Only JPEG, PNG, WEBP or HEIC images are allowed."); return; }

    setChitUploading(true);
    let added = 0;
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/expense-chits", { method: "POST", body: fd });
        const json = await res.json();
        if (json.ok) {
          // Trust the size the server measured, not the browser's.
          setChits((prev) => [...prev, { url: json.url, name: file.name, bytes: json.bytes ?? file.size }]);
          added++;
        } else {
          toast.error(json.error || `Could not upload ${file.name}.`);
          break; // stop the batch rather than push on and pile up errors
        }
      }
      if (added) toast.success(added === 1 ? "Chit uploaded." : `${added} chits uploaded.`);
    } catch {
      toast.error("Upload failed.");
    } finally {
      setChitUploading(false);
    }
  }

  // A pasted image is a chit: Ctrl+V anywhere on the form (left to the Attach
  // dialog when that is open) turns "Chit received?" on and uploads it.
  function takePasted(files: File[]) {
    if (chitUploading) { toast.error("Wait for the upload in progress to finish."); return; }
    setChit(true);
    handleChitFiles(files);
  }
  usePastedImages(true, takePasted, true);
  async function pasteChit() {
    try { takePasted(await readClipboardImages()); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not paste."); }
  }

  const typeCategories = useMemo(
    () => categoriesForType(expenseType)
      .map((n) => categories.find((c) => c.name === n))
      .filter(Boolean) as CategoryOption[],
    [expenseType, categories]
  );
  const categoryId = categories.find((c) => c.name === categoryName)?.id ?? "";

  const isSalary   = categoryName === SALARY_CATEGORY;
  const isVendor   = categoryName === VENDOR_CATEGORY;
  const isFreeItem = isFreeTextItemCategory(categoryName);
  const staticItems = pickerItems(categoryName, addedItems[categoryName]);

  async function saveNewItem() {
    const name = newItem.trim();
    if (!name) return;
    setAddingItem(true);
    try {
      const res = await addExpenseItem(categoryName, name);
      if (!res.ok) { toast.error(res.error); return; }
      const saved = res.item ?? name;
      if (!staticItems.includes(saved)) setAddedItems((m) => ({ ...m, [categoryName]: [...(m[categoryName] ?? []), saved] }));
      setItem(saved);
      setNewItem("");
      setNewItemOpen(false);
      toast.success(`"${saved}" added under ${categoryName}.`);
    } finally {
      setAddingItem(false);
    }
  }

  const selectedVendor = vendors.find((v) => v.id === selectedVendorId) ?? null;
  const employeeOptions: ComboOption[] = employees.map((e) => ({ id: e.id, label: e.name, hint: e.role || undefined }));
  const vendorOptions: ComboOption[] = vendors.map((v) => ({
    id: v.id,
    label: v.name,
    hint: v.outstanding > 0 ? `Rs ${fmt(v.outstanding)} payable` : "settled",
    hintClass: v.outstanding > 0 ? "text-rose-600" : "text-emerald-600",
  }));

  function resetItemSelection() {
    setItem("");
    setSelectedEmployeeId("");
    setSelectedVendorId("");
  }
  function handleTypeChange(t: string) {
    setExpenseType(t);
    setCategoryName(firstCategoryFor(t));
    resetItemSelection();
  }
  function handleCategoryChange(name: string) {
    setCategoryName(name);
    resetItemSelection();
  }

  function reset() {
    setDate(todayPKTString());
    setAmount("");
    setDescription("");
    setHead("CASH");
    setChit(false);
    setChits([]);
    setSalaryMonth(todayPKTString().slice(0, 7));
    setExpenseType(EXPENSE_TYPES[0]);
    setCategoryName(firstCategoryFor(EXPENSE_TYPES[0]));
    resetItemSelection();
  }

  // The chosen third-level item as a string (employee/vendor name, free text, or list value).
  function itemValue(): string {
    if (isSalary) return employees.find((e) => e.id === selectedEmployeeId)?.name ?? "";
    if (isVendor) return vendors.find((v) => v.id === selectedVendorId)?.name ?? "";
    return item.trim();
  }

  function buildDescription(): string {
    if (isSalary && selectedEmployeeId) {
      const emp = employees.find((e) => e.id === selectedEmployeeId);
      return emp ? `Salary — ${emp.name}` : description.trim();
    }
    if (isVendor && selectedVendorId) {
      const vendor = vendors.find((v) => v.id === selectedVendorId);
      return vendor ? `Vendor Payable — ${vendor.name}` : description.trim();
    }
    const base = [categoryName, itemValue()].filter(Boolean).join(" · ");
    return description.trim() || base;
  }

  function handleSubmit() {
    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) { toast.error("Enter a valid amount."); return; }
    if (!categoryId) { toast.error("Select a category."); return; }
    if (isSalary && !selectedEmployeeId) { toast.error("Select whose salary this is."); return; }
    else if (isVendor && !selectedVendorId) { toast.error("Select a vendor."); return; }
    else if (!isSalary && !isVendor && !itemValue()) { toast.error("Select an item."); return; }

    startTransition(async () => {
      const res = await addExpense({
        date,
        amount:       parsedAmount,
        description:  buildDescription(),
        categoryId,
        head,
        item:         isSalary ? undefined : itemValue(),
        chitReceived: chit,
        chits: chit ? chits.map((c) => ({ url: c.url, bytes: c.bytes })) : undefined,
        vendorId:     isVendor && selectedVendorId ? selectedVendorId : undefined,
        employeeId:   isSalary && selectedEmployeeId ? selectedEmployeeId : undefined,
        salaryPeriod: isSalary ? salaryMonth : undefined,
      });
      if (res.ok) {
        toast.success(isSalary ? "Salary payment recorded." : "Expense added.");
        reset();
        onSaved();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="size-4" /> Add Expense
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Row 1 */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Date</Label>
            <Input
              type="date"
              className="mt-1"
              value={date}
              max={todayPKTString()}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <Label>Amount (Rs)</Label>
            <Input
              type="number"
              min="0"
              step="1"
              placeholder="0"
              className="mt-1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        </div>

        {/* Expense Type → Category → Item */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <Label>Expense Type</Label>
            <Select value={expenseType} onValueChange={handleTypeChange}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {EXPENSE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Category</Label>
            <Select value={categoryName} onValueChange={handleCategoryChange}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Select category" /></SelectTrigger>
              <SelectContent>
                {typeCategories.map((c) => <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{isSalary ? "Whose salary?" : isVendor ? "Vendor" : "Item"}</Label>
            {isSalary ? (
              <>
                <SearchableSelect
                  options={employeeOptions} value={selectedEmployeeId} onChange={setSelectedEmployeeId}
                  placeholder="Select employee" searchPlaceholder="Search staff…" emptyText="No employees found."
                />
                <div className="mt-2">
                  <Label className="text-[11px]">Salary for month</Label>
                  <Input
                    type="month"
                    value={salaryMonth}
                    onChange={(e) => setSalaryMonth(e.target.value)}
                    className="mt-0.5 h-8 text-xs"
                  />
                </div>
              </>
            ) : isVendor ? (
              <>
                <SearchableSelect
                  options={vendorOptions} value={selectedVendorId} onChange={setSelectedVendorId}
                  placeholder="Select vendor" searchPlaceholder="Search vendors…" emptyText="No vendors found."
                />
                {selectedVendor && selectedVendor.outstanding > 0 && (
                  <p className="mt-1 text-[11px] text-amber-600">
                    Rs {fmt(selectedVendor.outstanding)} outstanding — this payment will reduce it.
                  </p>
                )}
              </>
            ) : isFreeItem ? (
              <Input className="mt-1" placeholder="Name" value={item} onChange={(e) => setItem(e.target.value)} />
            ) : (
              <>
                <div className="mt-1 flex items-center gap-1.5">
                  <Select value={item} onValueChange={setItem}>
                    <SelectTrigger className="min-w-0 flex-1"><SelectValue placeholder="Select item" /></SelectTrigger>
                    <SelectContent>
                      {staticItems.map((it) => <SelectItem key={it} value={it}>{it}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button type="button" size="sm" variant="outline" className="h-9 shrink-0 px-2 text-xs" title="Add a new item under this category" onClick={() => setNewItemOpen((v) => !v)}>
                    <Plus className="size-3.5" /> Item
                  </Button>
                </div>
                {newItemOpen && (
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <Input
                      autoFocus
                      value={newItem}
                      onChange={(e) => setNewItem(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveNewItem(); } if (e.key === "Escape") setNewItemOpen(false); }}
                      placeholder={`New item under ${categoryName}`}
                      className="h-9 text-sm"
                      maxLength={60}
                    />
                    <Button type="button" size="sm" className="h-9 text-xs" disabled={addingItem || !newItem.trim()} onClick={saveNewItem}>
                      {addingItem ? <Loader2 className="size-3.5 animate-spin" /> : "Add"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Detail / note (optional) */}
        <div>
          <Label>Detail / note (optional)</Label>
          <Input
            className="mt-1"
            placeholder={[categoryName, itemValue()].filter(Boolean).join(" · ") || "e.g. Diesel for delivery van"}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          />
        </div>

        {/* Pay from + Chit */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>Pay from</Label>
            <Select value={head} onValueChange={setHead}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {headBalances.map((h) => (
                  <SelectItem key={h.head} value={h.head}>
                    <span className="flex w-full items-center justify-between gap-3">
                      <span>{h.label}</span>
                      <span className={`font-mono text-[11px] ${h.balance < 0 ? "text-rose-600" : "text-muted-foreground"}`}>
                        {h.balance < 0 ? "−" : ""}Rs {fmt(h.balance)}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Chit received?</Label>
            <div className="mt-1">
              <ChitToggle value={chit} onChange={setChit} />
            </div>
            {chit && (
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted/50">
                    {chitUploading ? <Loader2 className="size-3.5 animate-spin" /> : <ImageIcon className="size-3.5" />}
                    {chitUploading ? "Uploading…" : chits.length ? "Add another photo" : "Upload chit"}
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      disabled={chitUploading}
                      onChange={(e) => {
                        const picked = Array.from(e.target.files ?? []);
                        if (picked.length) handleChitFiles(picked);
                        e.target.value = ""; // allow re-selecting the same file
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={pasteChit}
                    disabled={chitUploading}
                    title="Paste a copied image — or just press Ctrl+V"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
                  >
                    <ClipboardPaste className="size-3.5" /> Paste
                  </button>
                  {/* The running total, so the 10 MB ceiling is visible BEFORE you
                      pick a file that will not fit. */}
                  <span className={cn("text-[11px]", chitBytesUsed > MAX_CHIT_TOTAL_BYTES * 0.9 ? "text-amber-700" : "text-muted-foreground")}>
                    {chits.length
                      ? `${chits.length} photo${chits.length === 1 ? "" : "s"} · ${fmtBytes(chitBytesUsed)} of ${fmtBytes(MAX_CHIT_TOTAL_BYTES)}`
                      : `Up to ${MAX_CHIT_FILES} photos, ${fmtBytes(MAX_CHIT_TOTAL_BYTES)} in total · or press Ctrl+V`}
                  </span>
                </div>

                {chits.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {chits.map((c) => (
                      <div key={c.url} className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-1 pr-2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={c.url} alt="Chit" className="size-9 rounded object-cover" />
                        <span className="max-w-[110px] truncate text-[11px] text-muted-foreground" title={c.name}>
                          {c.name || "chit"}
                        </span>
                        <span className="text-[10px] text-muted-foreground/70">{fmtBytes(c.bytes)}</span>
                        <button
                          type="button"
                          onClick={() => setChits((prev) => prev.filter((x) => x.url !== c.url))}
                          className="rounded p-0.5 text-muted-foreground hover:bg-rose-50 hover:text-rose-600"
                          title="Remove"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <Button className="w-full" onClick={handleSubmit} disabled={pending}>
          <Plus className="mr-1.5 size-4" />
          {pending ? "Saving…" : isSalary ? "Record Salary" : "Add Expense"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Chit image viewer ─────────────────────────────────────────────────────────

// Shows every photo on the expense, stacked and scrollable. A chit is often several
// pages and they are read together, so paging through them one at a time would be
// worse than simply scrolling.
function ChitImageViewer({ urls, onClose }: { urls: string[]; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ImageIcon className="size-4" />
            {urls.length > 1 ? `Invoice chit — ${urls.length} photos` : "Invoice chit"}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[74vh] space-y-3 overflow-y-auto">
          {urls.map((u, i) => (
            <div key={u} className="space-y-1">
              {urls.length > 1 && (
                <p className="text-[11px] font-medium text-muted-foreground">Photo {i + 1} of {urls.length}</p>
              )}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt={`Invoice chit ${i + 1}`} className="max-h-[70vh] w-full rounded-lg border border-border object-contain" />
            </div>
          ))}
          <div className="flex justify-end">
            <a
              href={urls[0]}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/50"
            >
              Open original
            </a>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Attach a chit to an expense that already exists ───────────────────────────
//
// Receipts arrive late. Without this the only way to attach one was to delete
// the expense and re-enter it, which moves the head balance twice and loses the
// original date.

function AddChitDialog({
  entry, onClose, onDone,
}: {
  entry: ExpenseEntry;
  onClose: () => void;
  onDone: () => void;
}) {
  const [picked, setPicked] = useState<{ url: string; name: string; bytes: number }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, startSave] = useTransition();

  // The cap is per expense, so what is already attached counts against it. Those
  // sizes are not on the row, so assume the worst case of 0 used and let the
  // server — which can see them — have the final say.
  async function pick(files: File[]) {
    if (files.length === 0) return;
    const problem = chitSetProblem([...picked.map((c) => c.bytes), ...files.map((f) => f.size)]);
    if (problem) { toast.error(problem); return; }
    const bad = files.find((f) => !isAllowedChitType(f.type));
    if (bad) { toast.error("Only JPEG, PNG, WEBP or HEIC images are allowed."); return; }

    setUploading(true);
    try {
      // Sequential, like the add form: these are phone photos on mobile data and
      // firing them all at once is how the slowest one times out.
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/expense-chits", { method: "POST", body: fd });
        const json = await res.json();
        if (!json.ok) { toast.error(json.error || `Could not upload ${file.name}.`); break; }
        setPicked((prev) => [...prev, { url: json.url, name: file.name, bytes: json.bytes ?? file.size }]);
      }
    } catch {
      toast.error("Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  // Ctrl+V of an image while this dialog is open attaches it here.
  usePastedImages(true, (files) => {
    if (uploading || saving) { toast.error("Wait for the upload in progress to finish."); return; }
    pick(files);
  });
  async function pasteChit() {
    try { await pick(await readClipboardImages()); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not paste."); }
  }

  function save() {
    startSave(async () => {
      try {
        const res = await addChitsToExpense(entry.id, picked.map((c) => ({ url: c.url, bytes: c.bytes })));
        if (res.ok) {
          toast.success(picked.length === 1 ? "Chit attached." : `${picked.length} chits attached.`);
          onDone();
          onClose();
        } else {
          toast.error(res.error);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not attach the chit.");
      }
    });
  }

  const busy = uploading || saving;

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !busy) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Attach a chit</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {entry.description || entry.categoryName} · Rs {fmt(entry.amount)} ·{" "}
          {fmtShortDate(entry.date)}
          {entry.chitUrls.length > 0 && ` · ${entry.chitUrls.length} already attached`}
        </p>

        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground hover:bg-muted/40">
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImageIcon className="size-4" />}
          {uploading ? "Uploading…" : "Choose photos"}
          <input
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            disabled={busy}
            onChange={(ev) => { pick(Array.from(ev.target.files ?? [])); ev.target.value = ""; }}
          />
        </label>
        <Button type="button" variant="outline" size="sm" className="w-full gap-1.5 text-xs" onClick={pasteChit} disabled={busy}>
          <ClipboardPaste className="size-3.5" /> Paste a copied image <span className="text-muted-foreground">(or press Ctrl+V)</span>
        </Button>

        {picked.length > 0 && (
          <div className="space-y-1">
            {picked.map((c, i) => (
              <div key={c.url} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1 text-xs">
                <span className="truncate">{c.name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-muted-foreground">{fmtBytes(c.bytes)}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setPicked((prev) => prev.filter((_, j) => j !== i))}
                    className="rounded p-0.5 text-muted-foreground hover:bg-rose-50 hover:text-rose-600"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={busy || picked.length === 0}>
            {saving ? "Attaching…" : "Attach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Recent expenses table ─────────────────────────────────────────────────────

function RecentExpenses({
  expenses,
  categories,
  onDelete,
  range,
  onRangeChange,
  categoryId,
  onCategoryChange,
  headFilter,
  onHeadChange,
  search,
  onSearchChange,
  loading,
  onChitAdded,
}: {
  expenses: ExpenseEntry[];
  categories: CategoryOption[];
  onDelete: (entry: ExpenseEntry) => void;
  range: RecentRange | DateWindow;
  onRangeChange: (r: RecentRange | DateWindow) => void;
  categoryId: string | null;
  onCategoryChange: (id: string | null) => void;
  headFilter: string | null;
  onHeadChange: (head: string | null) => void;
  search: string;
  onSearchChange: (q: string) => void;
  loading: boolean;
  onChitAdded: () => void;
}) {
  // A From–To window of the user's own. The list reloads once both dates are set.
  const isCustom = typeof range === "object";
  const [showCustom, setShowCustom] = useState(isCustom);
  const [from, setFrom] = useState(isCustom ? range.from : "");
  const [to, setTo] = useState(isCustom ? range.to : "");
  function pickDates(f: string, t: string) {
    setFrom(f);
    setTo(t);
    if (f && t) onRangeChange({ from: f, to: t });
  }
  const catIndex = Object.fromEntries(categories.map((c, i) => [c.name, i]));
  const [viewUrls, setViewUrls] = useState<string[] | null>(null);
  const [chitFor, setChitFor] = useState<ExpenseEntry | null>(null);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const sorted = useMemo(() => {
    if (!sortKey) return expenses;
    return [...expenses].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (typeof av === "number" && typeof bv === "number")
        return sortDir === "asc" ? av - bv : bv - av;
      const as_ = String(av ?? ""), bs_ = String(bv ?? "");
      return sortDir === "asc" ? as_.localeCompare(bs_) : bs_.localeCompare(as_);
    });
  }, [expenses, sortKey, sortDir]);

  return (
    <>
    <Card>
      <CardHeader className="gap-3 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingDown className="size-4" /> Recent Expenses
        </CardTitle>
        {/* Every filter runs on the SERVER. Narrowing in the browser would only
            search the rows already sent and quietly miss older ones inside the
            chosen window. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border p-0.5">
            {RECENT_RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                disabled={loading}
                onClick={() => { setShowCustom(false); onRangeChange(r.key); }}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                  range === r.key && !showCustom
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted"
                )}
              >
                {r.label}
              </button>
            ))}
            <button
              type="button"
              disabled={loading}
              onClick={() => setShowCustom(true)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                showCustom ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"
              )}
            >
              Dates
            </button>
          </div>

          {showCustom && (
            <div className="flex items-center gap-1.5">
              <Input
                type="date"
                value={from}
                max={to || todayPKTString()}
                onChange={(e) => pickDates(e.target.value, to)}
                className="h-8 w-[140px] text-xs"
                aria-label="From date"
                title="From"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="date"
                value={to}
                min={from || undefined}
                max={todayPKTString()}
                onChange={(e) => pickDates(from, e.target.value)}
                className="h-8 w-[140px] text-xs"
                aria-label="To date"
                title="To"
              />
            </div>
          )}

          <Select
            value={categoryId ?? "__all__"}
            onValueChange={(v) => onCategoryChange(v === "__all__" ? null : v)}
            disabled={loading}
          >
            <SelectTrigger className="h-8 w-[190px] text-xs">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={headFilter ?? "__all__"}
            onValueChange={(v) => onHeadChange(v === "__all__" ? null : v)}
            disabled={loading}
          >
            <SelectTrigger className="h-8 w-[150px] text-xs">
              <SelectValue placeholder="All heads" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All heads</SelectItem>
              {PAYMENT_HEADS.map((h) => (
                <SelectItem key={h} value={h}>{PAYMENT_HEAD_LABELS[h]}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(ev) => onSearchChange(ev.target.value)}
              placeholder="Search description…"
              className="h-8 w-[210px] pl-7 text-xs"
            />
            {search && (
              <button
                type="button"
                onClick={() => onSearchChange("")}
                title="Clear the search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {loading && <span className="text-xs text-muted-foreground">Loading…</span>}
          <span className="ml-auto text-xs text-muted-foreground">
            {expenses.length} {expenses.length === 1 ? "entry" : "entries"}
            {headFilter && (
              <> · <b className="text-foreground">Rs {fmt(Math.round(expenses.reduce((s, e) => s + e.amount, 0)))}</b> from {PAYMENT_HEAD_LABELS[headFilter as PaymentHeadName] ?? headFilter}</>
            )}
          </span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {expenses.length === 0 ? (
          <div className="flex h-32 items-center justify-center px-4 text-center text-sm text-muted-foreground">
            {loading
              ? "Loading…"
              : search
                ? `Nothing matching "${search}" in this window.`
                : "Nothing logged in this window."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th
                    onClick={() => handleSort("date")}
                    className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center gap-1">
                      Date
                      <span className={sortKey === "date" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "date" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                  <th
                    onClick={() => handleSort("description")}
                    className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center gap-1">
                      Description
                      <span className={sortKey === "description" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "description" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                  <th
                    onClick={() => handleSort("categoryName")}
                    className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center gap-1">
                      Category
                      <span className={sortKey === "categoryName" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "categoryName" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                  <th
                    onClick={() => handleSort("head")}
                    className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center gap-1">
                      Head
                      <span className={sortKey === "head" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "head" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                  <th
                    onClick={() => handleSort("amount")}
                    className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center gap-1">
                      Amount
                      <span className={sortKey === "amount" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "amount" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                  <th className="px-4 py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">Chit</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map((e) => (
                  <tr key={e.id} className="hover:bg-muted/20">
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {fmtShortDate(e.date)}
                    </td>
                    <td className="max-w-[180px] px-4 py-3 font-medium truncate">
                      {e.vendorId ? (
                        <Link href={`/ledgers?type=vendor&id=${e.vendorId}`} className="hover:underline">
                          {e.description}
                        </Link>
                      ) : e.employeeId ? (
                        <Link href={`/ledgers?type=employee&id=${e.employeeId}`} className="hover:underline">
                          {e.description}
                        </Link>
                      ) : (
                        e.description
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium text-foreground ${CAT_COLORS[(catIndex[e.categoryName] ?? 0) % CAT_COLORS.length]}`}>
                        {e.categoryName}
                      </span>
                      {e.item && <span className="ml-1 text-xs text-foreground">· {e.item}</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{e.head}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold">Rs {fmt(e.amount)}</td>
                    <td className="px-4 py-3 text-center">
                      {e.kind === "salary" ? (
                        <span className="text-[10px] text-muted-foreground">—</span>
                      ) : (
                        // A chit can always be added later — receipts arrive after
                        // the money does — so the attach control is offered next to
                        // whatever the row already has.
                        <span className="inline-flex items-center justify-center gap-1">
                          {e.chitUrls.length > 0 ? (
                            <button
                              onClick={() => setViewUrls(e.chitUrls)}
                              className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-100"
                              title="View chit"
                            >
                              <Eye className="size-3" /> View{e.chitUrls.length > 1 ? ` (${e.chitUrls.length})` : ""}
                            </button>
                          ) : e.chitReceived ? (
                            <span title="Marked as received, no photo on file" className="inline-flex size-5 items-center justify-center rounded-full bg-emerald-50 text-[9px] font-bold text-emerald-700">✓</span>
                          ) : (
                            <span title="No chit yet" className="inline-flex size-5 items-center justify-center rounded-full bg-rose-50 text-[9px] font-bold text-rose-700">✗</span>
                          )}
                          <button
                            onClick={() => setChitFor(e)}
                            title={e.chitUrls.length > 0 ? "Attach another chit" : "Attach the chit now it has arrived"}
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            <Paperclip className="size-3" />
                          </button>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => onDelete(e)}
                        className="rounded p-1 text-muted-foreground hover:bg-rose-50 hover:text-rose-600 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
    {viewUrls && <ChitImageViewer urls={viewUrls} onClose={() => setViewUrls(null)} />}
    {chitFor && (
      <AddChitDialog
        entry={chitFor}
        onClose={() => setChitFor(null)}
        onDone={onChitAdded}
      />
    )}
    </>
  );
}

// ── Budget summary ────────────────────────────────────────────────────────────

function BudgetSummary({ rows }: { rows: BudgetRow[] }) {
  const [budgetSortKey, setBudgetSortKey] = useState<string | null>(null);
  const [budgetSortDir, setBudgetSortDir] = useState<"asc" | "desc">("asc");
  function handleBudgetSort(key: string) {
    if (budgetSortKey === key) setBudgetSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setBudgetSortKey(key); setBudgetSortDir("asc"); }
  }

  const budgetSorted = useMemo(() => {
    if (!budgetSortKey) return rows;
    return [...rows].sort((a, b) => {
      if (budgetSortKey === "remaining") {
        const av = a.budget - a.spent;
        const bv = b.budget - b.spent;
        return budgetSortDir === "asc" ? av - bv : bv - av;
      }
      const av = (a as Record<string, unknown>)[budgetSortKey];
      const bv = (b as Record<string, unknown>)[budgetSortKey];
      if (typeof av === "number" && typeof bv === "number")
        return budgetSortDir === "asc" ? av - bv : bv - av;
      const as_ = String(av ?? ""), bs_ = String(bv ?? "");
      return budgetSortDir === "asc" ? as_.localeCompare(bs_) : bs_.localeCompare(as_);
    });
  }, [rows, budgetSortKey, budgetSortDir]);

  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Budget Summary — This Month</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th
                  onClick={() => handleBudgetSort("categoryName")}
                  className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                >
                  <span className="inline-flex items-center gap-1">
                    Category
                    <span className={budgetSortKey === "categoryName" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                      {budgetSortKey === "categoryName" ? (budgetSortDir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </span>
                </th>
                <th
                  onClick={() => handleBudgetSort("budget")}
                  className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                >
                  <span className="inline-flex items-center gap-1">
                    Budget
                    <span className={budgetSortKey === "budget" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                      {budgetSortKey === "budget" ? (budgetSortDir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </span>
                </th>
                <th
                  onClick={() => handleBudgetSort("spent")}
                  className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                >
                  <span className="inline-flex items-center gap-1">
                    Spent
                    <span className={budgetSortKey === "spent" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                      {budgetSortKey === "spent" ? (budgetSortDir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </span>
                </th>
                <th
                  onClick={() => handleBudgetSort("remaining")}
                  className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                >
                  <span className="inline-flex items-center gap-1">
                    Remaining
                    <span className={budgetSortKey === "remaining" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                      {budgetSortKey === "remaining" ? (budgetSortDir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </span>
                </th>
                <th
                  onClick={() => handleBudgetSort("daysLeft")}
                  className="px-4 py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                >
                  <span className="inline-flex items-center gap-1">
                    Days left
                    <span className={budgetSortKey === "daysLeft" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                      {budgetSortKey === "daysLeft" ? (budgetSortDir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {budgetSorted.map((b) => {
                const remaining = b.budget - b.spent;
                const pct = Math.min(100, Math.round((b.spent / b.budget) * 100));
                const barColor = pct < 60 ? "bg-emerald-500" : pct < 85 ? "bg-amber-500" : "bg-rose-500";
                return (
                  <tr key={b.categoryId} className="hover:bg-muted/20">
                    <td className="px-4 py-3 font-medium">{b.categoryName}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">Rs {fmt(b.budget)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">Rs {fmt(b.spent)}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`tabular-nums font-medium ${remaining < 0 ? "text-rose-600" : "text-foreground"}`}>
                        {remaining < 0 ? "−" : ""}Rs {fmt(remaining)}
                      </span>
                      <div className="mt-1.5 h-1.5 rounded-full bg-muted">
                        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center text-xs text-muted-foreground">{b.daysLeft}d</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function ExpensesClient({
  initialData,
}: {
  initialData: {
    categories: CategoryOption[];
    headBalances: HeadBalance[];
    recentExpenses: ExpenseEntry[];
    budgetRows: BudgetRow[];
    employees: EmployeeOption[];
    vendors: VendorOption[];
    riders: RiderOption[];
    salaryCategoryId: string | null;
    vendorPaymentCategoryId: string | null;
    riderCategoryId: string | null;
    extraItems: Record<string, string[]>;
  };
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

  // Recent Expenses filters. The list is refetched from the server on every
  // change — see getRecentExpenses — so the window means what it says rather
  // than filtering whatever happened to be sent on page load.
  const [range, setRange] = useState<RecentRange | DateWindow>(DEFAULT_RECENT_RANGE);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [headFilter, setHeadFilter] = useState<string | null>(null);
  const [rows, setRows] = useState<ExpenseEntry[]>(initialData.recentExpenses);
  const [loadingRecent, startLoadRecent] = useTransition();

  // Every reload carries all four filters, so they compose instead of one
  // silently dropping another.
  const reloadRecent = useCallback((r: RecentRange | DateWindow, cat: string | null, q: string, h: string | null) => {
    startLoadRecent(async () => {
      setRows(await getRecentExpenses(r, cat, q, h));
    });
  }, []);

  function changeRange(r: RecentRange | DateWindow) { setRange(r); reloadRecent(r, categoryId, search, headFilter); }
  function changeCategory(id: string | null) { setCategoryId(id); reloadRecent(range, id, search, headFilter); }
  function changeHead(h: string | null) { setHeadFilter(h); reloadRecent(range, categoryId, search, h); }

  // Typing hits the database, so it is debounced — a request per keystroke would
  // both hammer the server and let a slow early reply land after a later one and
  // overwrite it. The timer is cleared on every change, so only the pause fires.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function changeSearch(q: string) {
    setSearch(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => reloadRecent(range, categoryId, q, headFilter), 350);
  }

  const visibleExpenses = rows.filter((e) => !deletedIds.has(e.id));

  function handleDelete(entry: ExpenseEntry) {
    // Deleting reverses a head balance (and any vendor-bill settlement) — confirm the
    // misclick-prone action first, like the other money-reversing deletes in the app.
    const label = entry.kind === "salary" ? "salary payment" : "expense";
    if (!window.confirm(`Delete this ${label}? This reverses the money from its account and can't be undone.`)) return;
    setDeletedIds((prev) => new Set([...prev, entry.id]));
    startTransition(async () => {
      const res = entry.kind === "salary"
        ? await deleteSalaryPayment(entry.id)
        : await deleteExpense(entry.id);
      if (res.ok) {
        toast.success(entry.kind === "salary" ? "Salary payment deleted." : "Expense deleted.");
        router.refresh();       // head balances and budgets
        reloadRecent(range, categoryId, search, headFilter); // the filtered list itself
      } else {
        toast.error(res.error);
        setDeletedIds((prev) => { const n = new Set(prev); n.delete(entry.id); return n; });
      }
    });
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Payment heads
        </p>
        <HeadCards balances={initialData.headBalances} />
      </div>

      <AddExpenseForm
        categories={initialData.categories}
        employees={initialData.employees}
        vendors={initialData.vendors}
        headBalances={initialData.headBalances}
        extraItems={initialData.extraItems}
        onSaved={() => { router.refresh(); reloadRecent(range, categoryId, search, headFilter); }}
      />

      <RecentExpenses
        expenses={visibleExpenses}
        categories={initialData.categories}
        onDelete={handleDelete}
        range={range}
        onRangeChange={changeRange}
        categoryId={categoryId}
        onCategoryChange={changeCategory}
        headFilter={headFilter}
        onHeadChange={changeHead}
        search={search}
        onSearchChange={changeSearch}
        loading={loadingRecent}
        onChitAdded={() => reloadRecent(range, categoryId, search, headFilter)}
      />

      <BudgetSummary rows={initialData.budgetRows} />
    </div>
  );
}


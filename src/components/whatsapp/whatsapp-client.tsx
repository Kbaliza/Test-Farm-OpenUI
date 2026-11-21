"use client";

import { useState, useEffect, useMemo, useTransition } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  MessageCircle, Plus, Pencil, Trash2, Send, Search, RefreshCw,
  CheckCircle2, XCircle, Clock, Loader2, Power, QrCode, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { renderTemplate, TEMPLATE_PLACEHOLDERS } from "@/lib/whatsapp";
import {
  getWhatsappStatus, getMessageLog, getTemplates, requestLogout,
  createTemplate, updateTemplate, deleteTemplate,
  enqueueTest, enqueueToCustomers,
  type WhatsappStatus, type TemplateRow, type LogRow, type Recipient,
} from "@/app/(dashboard)/whatsapp/actions";

function fmt(n: number) {
  return Math.round(n).toLocaleString("en-PK");
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Karachi", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

const SAMPLE_VARS = Object.fromEntries(TEMPLATE_PLACEHOLDERS.map((p) => [p.key, p.sample]));

const STATUS_BADGE: Record<string, { cls: string; label: string; icon: React.ElementType }> = {
  SENT:    { cls: "bg-emerald-100 text-emerald-700", label: "Sent",    icon: CheckCircle2 },
  FAILED:  { cls: "bg-rose-100 text-rose-700",       label: "Failed",  icon: XCircle },
  PENDING: { cls: "bg-amber-100 text-amber-700",     label: "Pending", icon: Clock },
  SENDING: { cls: "bg-sky-100 text-sky-700",         label: "Sending", icon: Loader2 },
};

// ── Connection tab ───────────────────────────────────────────────────────────────

function ConnectTab({ status, onChanged }: { status: WhatsappStatus; onChanged: () => void }) {
  const [pending, start] = useTransition();

  function disconnect() {
    start(async () => {
      const res = await requestLogout();
      if (res.ok) { toast.success("Disconnect requested."); onChanged(); }
      else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-4">
      {!status.workerOnline && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">WhatsApp worker is offline.</p>
            <p className="text-xs text-amber-700">
              Start it in a terminal with <code className="rounded bg-amber-100 px-1">npm run wa</code> (keep it running alongside the app).
            </p>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-6">
        {status.status === "CONNECTED" ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
              <CheckCircle2 className="size-6" />
            </div>
            <div>
              <p className="text-sm font-semibold">WhatsApp connected</p>
              <p className="text-xs text-muted-foreground">
                {status.connectedNumber ? `+${status.connectedNumber}` : "Linked"}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={disconnect} disabled={pending} className="text-rose-600 hover:bg-rose-50">
              <Power className="mr-1.5 size-4" /> Disconnect
            </Button>
          </div>
        ) : status.qr ? (
          <div className="flex flex-col items-center gap-3 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={status.qr} alt="WhatsApp QR code" className="size-60 rounded-lg border border-border" />
            <div>
              <p className="text-sm font-semibold">Scan to connect</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                On your phone: WhatsApp → Settings → Linked devices → Link a device → scan this code.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-6 text-center text-muted-foreground">
            <QrCode className="size-10 opacity-40" />
            <p className="text-sm">
              {status.workerOnline ? "Starting up — waiting for the QR code…" : "Waiting for the worker to start…"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Template editor dialog ──────────────────────────────────────────────────────

function TemplateDialog({
  open, initial, onClose, onSaved,
}: {
  open: boolean;
  initial: TemplateRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [active, setActive] = useState(initial?.active ?? true);
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      const res = initial
        ? await updateTemplate(initial.id, { name, body, active })
        : await createTemplate(name, body);
      if (res.ok) { toast.success(initial ? "Template updated." : "Template created."); onSaved(); }
      else toast.error(res.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">{initial ? "Edit template" : "New template"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div>
            <Label className="text-xs">Template name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pending bill reminder" className="mt-1 h-9" />
          </div>
          <div>
            <Label className="text-xs">Message</Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} className="mt-1 text-sm" placeholder="Dear {{name}}, your pending balance is Rs {{amount}}. Kindly clear by the {{dueDate}}." />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {TEMPLATE_PLACEHOLDERS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setBody((b) => `${b}{{${p.key}}}`)}
                  className="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted"
                >
                  {`{{${p.key}}}`}
                </button>
              ))}
            </div>
          </div>
          {body.trim() && (
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Preview</p>
              <p className="whitespace-pre-wrap text-xs">{renderTemplate(body, SAMPLE_VARS)}</p>
            </div>
          )}
          {initial && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              Active
            </label>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Templates tab ────────────────────────────────────────────────────────────────

function TemplatesTab({ templates, onChanged }: { templates: TemplateRow[]; onChanged: () => void }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [, start] = useTransition();

  function remove(id: string) {
    start(async () => {
      const res = await deleteTemplate(id);
      if (res.ok) { toast.success("Template deleted."); onChanged(); }
      else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => { setEditing(null); setDialogOpen(true); }}>
          <Plus className="mr-1 size-4" /> New template
        </Button>
      </div>
      {templates.length === 0 ? (
        <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-muted-foreground">
          <MessageCircle className="size-6 opacity-40" />
          <p className="text-sm">No templates yet. Create one to reuse when sending.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <div key={t.id} className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {t.name}
                    {!t.active && <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">inactive</span>}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground line-clamp-2">{t.body}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => { setEditing(t); setDialogOpen(true); }} className="rounded p-1.5 text-muted-foreground hover:bg-muted" title="Edit"><Pencil className="size-3.5" /></button>
                  <button onClick={() => remove(t.id)} className="rounded p-1.5 text-muted-foreground hover:bg-rose-50 hover:text-rose-600" title="Delete"><Trash2 className="size-3.5" /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {dialogOpen && (
        <TemplateDialog
          open={dialogOpen}
          initial={editing}
          onClose={() => setDialogOpen(false)}
          onSaved={() => { setDialogOpen(false); onChanged(); }}
        />
      )}
    </div>
  );
}

// ── Send tab ───────────────────────────────────────────────────────────────────────

function SendTab({
  templates, recipients, connected, onSent,
}: {
  templates: TemplateRow[];
  recipients: Recipient[];
  connected: boolean;
  onSent: () => void;
}) {
  const [pending, start] = useTransition();

  // Test message
  const [testPhone, setTestPhone] = useState("");
  const [testBody, setTestBody] = useState("");

  // Dues blast
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  const activeTemplates = templates.filter((t) => t.active);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recipients;
    return recipients.filter((r) => r.name.toLowerCase().includes(q) || r.customerCode.toLowerCase().includes(q) || r.phone.includes(q));
  }, [recipients, query]);

  function toggle(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleAll() {
    setSelected((prev) => prev.size === filtered.length ? new Set() : new Set(filtered.map((r) => r.id)));
  }

  function sendTest() {
    start(async () => {
      const res = await enqueueTest(testPhone, testBody);
      if (res.ok) { toast.success("Queued — it'll send via the worker shortly."); setTestBody(""); onSent(); }
      else toast.error(res.error);
    });
  }

  function sendDues() {
    if (!templateId) { toast.error("Pick a template."); return; }
    if (selected.size === 0) { toast.error("Select at least one customer."); return; }
    start(async () => {
      const res = await enqueueToCustomers(templateId, [...selected]);
      if (res.ok) {
        toast.success(`Queued ${res.queued} message${res.queued !== 1 ? "s" : ""}${res.skipped ? ` · ${res.skipped} skipped (bad number)` : ""}.`);
        setSelected(new Set());
        onSent();
      } else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-5">
      {!connected && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="size-4 shrink-0" /> WhatsApp isn't connected — messages will queue and send once you connect on the Connect tab.
        </div>
      )}

      {/* Test message */}
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="mb-3 text-sm font-semibold">Send a test message</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="Phone e.g. 0332-5862900" className="h-9 sm:col-span-1" />
          <div className="sm:col-span-2">
            <div className="flex flex-wrap gap-1">
              {activeTemplates.map((t) => (
                <button key={t.id} type="button" onClick={() => setTestBody(renderTemplate(t.body, SAMPLE_VARS))}
                  className="rounded border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted">
                  use "{t.name}"
                </button>
              ))}
            </div>
          </div>
        </div>
        <Textarea value={testBody} onChange={(e) => setTestBody(e.target.value)} rows={3} placeholder="Type a message, or click a template above to prefill…" className="mt-2 text-sm" />
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={sendTest} disabled={pending}>
            <Send className="mr-1.5 size-4" /> Send test
          </Button>
        </div>
      </div>

      {/* Dues blast */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">Send to customers with pending dues</p>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger className="h-8 w-full min-w-0 sm:w-48 text-xs"><SelectValue placeholder="Pick a template" /></SelectTrigger>
              <SelectContent>
                {activeTemplates.map((t) => <SelectItem key={t.id} value={t.id} className="text-xs">{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={sendDues} disabled={pending}>
              <Send className="mr-1.5 size-4" /> Send to {selected.size || ""} selected
            </Button>
          </div>
        </div>

        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, code or phone…" className="h-8 pl-8 text-xs sm:max-w-xs" />
        </div>

        {recipients.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No customers with pending payments 🎉</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
              <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleAll} />
              <span className="flex-1">Customer</span>
              <span className="w-28 text-right">Due</span>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {filtered.map((r) => (
                <label key={r.id} className="flex cursor-pointer items-center gap-2 border-b border-border/50 px-3 py-2 text-xs hover:bg-muted/20">
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate font-medium">{r.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{r.customerCode} · {r.phone}</span>
                  </span>
                  <span className="w-28 text-right font-semibold tabular-nums text-rose-600">₨ {fmt(r.amount)}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Log tab ──────────────────────────────────────────────────────────────────────

function LogTab({ logs }: { logs: LogRow[] }) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }
  const sorted = useMemo(() => {
    if (!sortKey) return logs;
    return [...logs].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (typeof av === "number" && typeof bv === "number")
        return sortDir === "asc" ? av - bv : bv - av;
      const as_ = String(av ?? ""), bs_ = String(bv ?? "");
      return sortDir === "asc" ? as_.localeCompare(bs_) : bs_.localeCompare(as_);
    });
  }, [logs, sortKey, sortDir]);

  if (logs.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No messages sent yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-xs">
        <thead className="bg-muted/40">
          <tr>
            <th
              onClick={() => handleSort("createdAt")}
              className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
            >
              <span className="inline-flex items-center gap-1">
                When
                <span className={sortKey === "createdAt" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                  {sortKey === "createdAt" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                </span>
              </span>
            </th>
            <th
              onClick={() => handleSort("customerName")}
              className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
            >
              <span className="inline-flex items-center gap-1">
                To
                <span className={sortKey === "customerName" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                  {sortKey === "customerName" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                </span>
              </span>
            </th>
            <th
              onClick={() => handleSort("body")}
              className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
            >
              <span className="inline-flex items-center gap-1">
                Message
                <span className={sortKey === "body" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                  {sortKey === "body" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                </span>
              </span>
            </th>
            <th
              onClick={() => handleSort("status")}
              className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
            >
              <span className="inline-flex items-center gap-1">
                Status
                <span className={sortKey === "status" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                  {sortKey === "status" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                </span>
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((l) => {
            const b = STATUS_BADGE[l.status] ?? STATUS_BADGE.PENDING;
            const Icon = b.icon;
            return (
              <tr key={l.id} className="border-b border-border/50 hover:bg-muted/20">
                <td className="whitespace-nowrap px-3 py-2 text-[11px] text-muted-foreground">{fmtTime(l.createdAt)}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className="font-medium">{l.customerName ?? "—"}</span>
                  <span className="block text-[10px] text-muted-foreground">{l.phone}</span>
                </td>
                <td className="max-w-[280px] truncate px-3 py-2 text-muted-foreground" title={l.body}>{l.body}</td>
                <td className="px-3 py-2">
                  <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold", b.cls)}>
                    <Icon className={cn("size-3", l.status === "SENDING" && "animate-spin")} /> {b.label}
                  </span>
                  {l.status === "FAILED" && l.error && (
                    <span className="mt-0.5 block max-w-[200px] truncate text-[10px] text-rose-500" title={l.error}>{l.error}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────────

export function WhatsappClient({
  initialStatus, initialTemplates, initialLogs, recipients,
}: {
  initialStatus: WhatsappStatus;
  initialTemplates: TemplateRow[];
  initialLogs: LogRow[];
  recipients: Recipient[];
}) {
  const [status, setStatus] = useState(initialStatus);
  const [templates, setTemplates] = useState(initialTemplates);
  const [logs, setLogs] = useState(initialLogs);

  // Poll connection status (~5s) and message log (~8s).
  useEffect(() => {
    const refreshStatus = () => getWhatsappStatus().then(setStatus).catch(() => {});
    const refreshLogs = () => getMessageLog().then((r) => setLogs(r.logs)).catch(() => {});
    refreshStatus(); refreshLogs();
    const s = setInterval(refreshStatus, 5_000);
    const l = setInterval(refreshLogs, 8_000);
    return () => { clearInterval(s); clearInterval(l); };
  }, []);

  // Re-pull templates from the server after a create/edit/delete.
  function refreshTemplates() {
    getTemplates().then((r) => setTemplates(r.templates)).catch(() => {});
  }
  function refreshLogsNow() {
    getMessageLog().then((r) => setLogs(r.logs)).catch(() => {});
  }

  const statusPill =
    status.status === "CONNECTED" ? { cls: "bg-emerald-100 text-emerald-700", label: "Connected" }
    : status.status === "QR" ? { cls: "bg-sky-100 text-sky-700", label: "Scan QR" }
    : status.status === "STARTING" ? { cls: "bg-amber-100 text-amber-700", label: "Starting" }
    : { cls: "bg-slate-100 text-slate-600", label: "Disconnected" };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold", statusPill.cls)}>
          <span className={cn("size-1.5 rounded-full", status.status === "CONNECTED" ? "bg-emerald-600" : "bg-current opacity-60")} />
          {statusPill.label}
        </span>
        {!status.workerOnline && (
          <span className="inline-flex items-center gap-1 text-[11px] text-amber-600">
            <RefreshCw className="size-3" /> worker offline
          </span>
        )}
      </div>

      <Tabs defaultValue="connect">
        <TabsList>
          <TabsTrigger value="connect">Connect</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="send">Send</TabsTrigger>
          <TabsTrigger value="log">Log</TabsTrigger>
        </TabsList>

        <TabsContent value="connect" className="mt-4">
          <ConnectTab status={status} onChanged={() => getWhatsappStatus().then(setStatus).catch(() => {})} />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <TemplatesTab templates={templates} onChanged={refreshTemplates} />
        </TabsContent>
        <TabsContent value="send" className="mt-4">
          <SendTab
            templates={templates}
            recipients={recipients}
            connected={status.status === "CONNECTED"}
            onSent={refreshLogsNow}
          />
        </TabsContent>
        <TabsContent value="log" className="mt-4">
          <LogTab logs={logs} />
        </TabsContent>
      </Tabs>
    </div>
  );
}


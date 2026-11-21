"use client";

import { Fragment, useState, type ReactNode } from "react";
import type {
  ReconciliationSummary,
  MilkInventorySnapshot,
  WasteReason,
} from "@/app/(dashboard)/inventory/reconciliation/actions";
import { WASTE_BUCKET_LABEL, type WasteBucket } from "@/lib/reconciliation-flow-math";
import { Lr, isZero } from "@/components/inventory/reconciliation-format";

// The Summary tab: the milk's way from the farm to the customer, top to bottom,
// in the approved design. Every figure on it is one total from getReconciliationSummary
// (src/lib/reconciliation-flow-math.ts says which record) — nothing is shared out,
// estimated or filled in here. Where the design asked for a reason breakdown, the
// reasons are the ones actually written on the wastage entries; a gap between two
// figures has no reason on record, and says so instead of inventing one.

type ChipKind = "waste" | "miss" | "info";
type Chip = { kind: ChipKind; label: string; amount: number; key: string };
type Step = {
  kind: "main" | "minus" | "equals";
  cls: string;
  lab: string;
  val: number;
  note: string;
  chips?: Chip[];
};

/** The waste chips that open a branch of real reasons, and the bucket behind each. */
const REASON_CHIPS: Record<string, WasteBucket> = {
  "w-farm": "farm",
  "w-pack": "packaging",
  "w-retail": "retail",
  "w-road": "road",
  "w-riderback": "riderReturn",
};

function pct(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function ChipView({ c, open, onToggle }: { c: Chip; open: boolean; onToggle: (k: string) => void }) {
  const zero = isZero(c.amount);
  const cls = zero ? "ok" : c.kind;
  const content = (
    <>
      <span className="ck">{c.label}</span>
      <span className="cv">{Lr(Math.abs(c.amount))}</span>
    </>
  );
  if (zero) return <div className={`chip ${cls}`}>{content}</div>;
  return (
    <button
      type="button"
      className={`chip ${cls} clickable`}
      aria-expanded={open}
      onClick={() => onToggle(c.key)}
    >
      {content}
    </button>
  );
}

function ReasonBranch({ title, reasons, total }: { title: string; reasons: WasteReason[]; total: number }) {
  return (
    <div className="branch">
      <div className="branch-h">Recorded reasons &middot; {title}</div>
      <table>
        <colgroup><col className="c-nm" /><col className="c-amt" /><col className="c-pct" /></colgroup>
        <thead>
          <tr><th>Reason</th><th className="n">Count</th><th className="n">Share</th></tr>
        </thead>
        <tbody>
          {reasons.map((r) => (
            <tr key={r.reason}>
              <td className="rs-nm">{r.reason}</td>
              <td className="rs-amt">{Lr(r.qty)}</td>
              <td className="rs-pct">{pct(r.qty, total)}%</td>
            </tr>
          ))}
          <tr className="rs-tot">
            <td>Total</td>
            <td className="rs-amt">{Lr(total)}</td>
            <td className="rs-pct">100%</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

type DrillRow = [name: string, how: string, amount: number];

function DrillTable({ header, rows }: { header: string; rows: DrillRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="drill">
      <table>
        <thead>
          <tr><th>{header}</th><th>How it is measured</th><th style={{ textAlign: "right" }}>Amount</th></tr>
        </thead>
        <tbody>
          {rows.map(([nm, how, amt], i) => (
            <tr key={i}>
              <td className="st-nm">{nm}</td>
              <td className="st-src">{how}</td>
              <td className="st-amt">{amt < -0.0005 ? `−${Lr(-amt)}` : Lr(amt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReconciliationFlow({
  s,
  inventory,
}: {
  s: ReconciliationSummary;
  inventory: MilkInventorySnapshot | null;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const f = s.flow;

  /** The inline breakdown behind a chip that has no reasons of its own. */
  function drill(key: string): { header: string; rows: DrillRow[] } | null {
    switch (key) {
      case "m-accept":
        return { header: "Source", rows: f.acceptParts.filter((p) => !isZero(p.amount)).map((p) => [p.label, p.how, p.amount]) };
      case "i-inv":
        return {
          header: "Inventory",
          rows: [
            ["Total milk packed", "received at packaging − packing wastage", f.packed],
            ...(f.yoghurtUse ? [["Used for yoghurt", "taken out of inventory to make yoghurt", -f.yoghurtUse] as DrillRow] : []),
            ...(f.counterSale ? [["Sold over the counter", "walk-in sales, out of inventory", -f.counterSale] as DrillRow] : []),
            ["Given to Retail", "what packaging sent to Retail", -f.toRetail],
            [
              f.inventoryDifference >= 0 ? "Kept in inventory" : "Drawn from stock already in inventory",
              f.inventoryDifference >= 0
                ? "packed but not sent on — still in stock, not a loss"
                : "sent from stock already there: earlier days, returns, Retail's leftovers",
              f.inventoryDifference,
            ],
          ],
        };
      case "i-retail":
      case "m-retail":
        return {
          header: "Retail",
          rows: [
            ["Given to Retail", "what packaging sent", f.toRetail],
            ...(f.waste.retail ? [["Wasted at Retail", "short on arrival, or written off at Retail", -f.waste.retail] as DrillRow] : []),
            ["Given to riders", "confirmed loads (the plan where no load was confirmed) + spare stock", -f.riderLoad],
            [
              f.retailLeftover >= 0 ? "Left at Retail" : "Riders took more than Retail had",
              f.retailLeftover >= 0
                ? "goes back to inventory at the end of the day — not a loss"
                : "more left Retail than reached it — check the loads and the Retail write-offs",
              f.retailLeftover,
            ],
          ],
        };
      case "m-rider":
      case "i-rider": {
        const rows: DrillRow[] = s.riders
          .filter((r) => !isZero(r.milk.missing))
          .map((r) => [
            r.riderName,
            `took ${Lr(r.milk.got)} − delivered ${Lr(r.milk.delivered)}${r.milk.customerReturns ? ` + customer returns ${Lr(r.milk.customerReturns)}` : ""}${r.milk.wasted ? ` − road wastage ${Lr(r.milk.wasted)}` : ""} − handed back ${Lr(r.milk.returned)}`,
            r.milk.missing,
          ]);
        return { header: "Rider", rows };
      }
      case "w-all":
        return {
          header: "Stage",
          rows: (Object.keys(WASTE_BUCKET_LABEL) as WasteBucket[])
            .filter((b) => !isZero(f.waste[b]))
            .map((b) => [WASTE_BUCKET_LABEL[b], WASTE_HOW[b], f.waste[b]]),
        };
      case "m-all":
        return { header: "Source", rows: f.missingParts.map((p) => [p.label, p.how, p.amount]) };
    }
    return null;
  }

  const days = s.days > 1 ? ` · ${s.days} days` : "";
  const steps: Step[] = [
    {
      kind: "main", cls: "t-produce", lab: "Total Milk Produced by Farm", val: f.produced,
      note: `gross output from the farm${days}`,
      chips: [{ kind: "waste", label: "Wasted at farm", amount: f.waste.farm, key: "w-farm" }],
    },
    { kind: "main", cls: "t-buy", lab: "Milk Outsourced", val: f.purchased, note: "milk purchased from outside (over-the-counter purchases)" },
    { kind: "equals", cls: "t-avail", lab: "Total Available", val: f.available, note: "produced + purchased" },
    { kind: "minus", cls: "t-calf", lab: "Given to Calves", val: f.calfUse, note: "fed to the calves" },
    { kind: "minus", cls: "t-kitchen", lab: "Given to Kitchen", val: f.kitchenUse, note: "kitchen of the farm workers" },
    ...(f.skimUse > 0.0005
      ? [{ kind: "minus", cls: "t-other", lab: "Other farm use", val: f.skimUse, note: "skim milk processing, from the farm's milk" } as Step]
      : []),
    {
      kind: "equals", cls: "t-net", lab: "Supposed to be Packed", val: f.supposedToPack,
      note: "what should reach packaging: available − farm use − farm wastage",
    },
    {
      kind: "main", cls: "t-recv", lab: "Received at Packaging", val: f.received,
      note: [
        `farm loads accepted ${Lr(f.farmAccepted)}`,
        f.packagingTransformUse ? `taken off the loads for mix/standardising ${Lr(f.packagingTransformUse)}` : null,
        f.purchased ? `bought in ${Lr(f.purchased)}` : null,
      ].filter(Boolean).join(" + "),
      chips: [
        f.acceptGap >= -0.0005
          ? { kind: "miss", label: "Missing while accepting", amount: f.acceptGap, key: "m-accept" }
          : { kind: "info", label: "More than expected arrived", amount: f.acceptGap, key: "m-accept" },
      ],
    },
    {
      kind: "main", cls: "t-pack", lab: "Total Milk Packed", val: f.packed, note: "received − packing wastage · into inventory",
      chips: [{ kind: "waste", label: "Wasted at packing", amount: f.waste.packaging, key: "w-pack" }],
    },
    ...(f.yoghurtUse > 0.0005
      ? [{ kind: "minus", cls: "t-other", lab: "Used for Yoghurt", val: f.yoghurtUse, note: "taken out of inventory to make yoghurt" } as Step]
      : []),
    ...(f.counterSale > 0.0005
      ? [{ kind: "minus", cls: "t-other", lab: "Sold over the Counter", val: f.counterSale, note: "walk-in sales, out of inventory" } as Step]
      : []),
    {
      kind: "main", cls: "t-disp", lab: "Given to Retail", val: f.toRetail, note: `packed ${Lr(f.packed)} → retail handover`,
      chips: [
        { kind: "waste", label: "Wasted at Retail", amount: f.waste.retail, key: "w-retail" },
        {
          kind: "info",
          label: f.inventoryDifference >= 0 ? "Kept in inventory" : "From inventory stock",
          amount: f.inventoryDifference, key: "i-inv",
        },
      ],
    },
    {
      kind: "main", cls: "t-rider", lab: "Given to Riders", val: f.riderLoad, note: `retail ${Lr(f.toRetail)} → rider dispatch`,
      chips: [
        f.retailLeftover >= -0.0005
          ? { kind: "info", label: "Back to inventory", amount: f.retailLeftover, key: "i-retail" }
          : { kind: "miss", label: "Over what Retail had", amount: f.retailLeftover, key: "m-retail" },
      ],
    },
    {
      kind: "main", cls: "t-deliv", lab: "Delivered to Customers", val: f.delivered,
      note: f.chargedBack > 0.0005
        ? `reached the customer · ${Lr(f.chargedBack)} charged on skipped stops stayed on the van`
        : "reached the customer",
      chips: [{ kind: "waste", label: "Wastage", amount: f.waste.road, key: "w-road" }],
    },
    {
      kind: "equals", cls: "t-net", lab: "Supposed to be Returned", val: f.supposedReturn,
      note: f.customerReturns > 0.0005
        ? `given to riders − delivered + ${Lr(f.customerReturns)} returned by customers − road wastage`
        : "given to riders − delivered − road wastage",
    },
    {
      kind: "main", cls: "t-return", lab: "Actually Returned", val: f.returned, note: "handed back at the farm",
      chips: [
        { kind: "waste", label: "Returned - wasted", amount: f.waste.riderReturn, key: "w-riderback" },
        f.riderGap >= -0.0005
          ? { kind: "miss", label: "Missing", amount: f.riderGap, key: "m-rider" }
          : { kind: "info", label: "More than due", amount: f.riderGap, key: "i-rider" },
      ],
    },
  ];

  const groups: Record<string, [string, string]> = {
    "t-produce": ["01", "Milk receiving & farm use"],
    "t-recv": ["02", "Packaging & dispatch"],
    "t-deliv": ["03", "Delivery & returns"],
  };
  const section = (n: string, label: string) => (
    <div className="flow-section" key={`sec-${n}`}>
      <span className="section-number">{n}</span><span>{label}</span><span className="section-line" />
    </div>
  );

  const out: ReactNode[] = [];
  for (const st of steps) {
    if (groups[st.cls]) out.push(section(...groups[st.cls]));
    const chips = st.chips ?? [];
    const branchChip = chips.find((c) => open[c.key] && REASON_CHIPS[c.key] && !isZero(c.amount));
    const drillChips = chips.filter((c) => open[c.key] && !REASON_CHIPS[c.key] && !isZero(c.amount));
    out.push(
      <div className={`fstep ${st.kind}`} key={st.lab}>
        <span className={`fdot ${st.kind === "equals" ? "eq" : ""} ${st.kind === "minus" ? "mn" : ""}`} />
        <div className="frow">
          <div className={`fmain ${st.cls} ${st.kind === "minus" ? "minus" : ""} ${st.kind === "equals" ? "equals" : ""}`}>
            {st.kind === "minus" ? <span className="op">&minus;</span> : st.kind === "equals" ? <span className="op">=</span> : null}
            <div className="finner">
              <div className="fl">{st.lab}</div>
              <div className="fv">{Lr(st.val)}</div>
              <div className="fn">{st.note}</div>
            </div>
          </div>
          {chips.length > 0 && (
            <div className="fside">
              {chips.map((c) => <ChipView key={c.key} c={c} open={!!open[c.key]} onToggle={toggle} />)}
            </div>
          )}
          {branchChip && (
            <div className="fbranch">
              <ReasonBranch
                title={WASTE_BUCKET_LABEL[REASON_CHIPS[branchChip.key]]}
                reasons={s.wasteReasons[REASON_CHIPS[branchChip.key]]}
                total={branchChip.amount}
              />
            </div>
          )}
        </div>
        {drillChips.map((c) => {
          const d = drill(c.key);
          return d ? <DrillTable key={c.key} header={d.header} rows={d.rows} /> : null;
        })}
      </div>,
    );
  }

  out.push(section("04", "Inventory & reconciliation"));
  const asOf = inventory
    ? new Date(inventory.asOf).toLocaleString("en-GB", { timeZone: "Asia/Karachi", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "";
  out.push(
    <div className="fstep ftotal inventory-step" key="inventory">
      <span className="fdot eq" />
      <div className="frow">
        <div className="fmain equals">
          <div className="finner">
            <div className="fl">Current Inventory <span className="auto-tag">Auto-fetched</span></div>
            <div className="fv">{inventory?.ok ? Lr(inventory.litres) : "— L"}</div>
            <div className="fn">
              {inventory?.ok
                ? `Updated ${asOf} PKT · ${inventory.perProduct.map((p) => `${p.name} ${Lr(p.litres)}`).join(" · ")}`
                : "Could not read the inventory just now — reload to try again."}
            </div>
          </div>
        </div>
        <div className="inventory-source">
          <strong>From inventory · Read-only</strong>
          Current stock, independent of date range — the Inventory page&apos;s &ldquo;In storage&rdquo;.
          {inventory?.ok && inventory.retailLitres > 0.0005 ? ` Plus ${Lr(inventory.retailLitres)} at Retail today.` : ""}
        </div>
      </div>
    </div>,
  );

  out.push(
    <div className="fstep balance" key="balance">
      <span className="fdot bal" />
      <div className="frow">
        <div className="fmain balcard bad">
          <div className="finner">
            <div className="fl">Collective Loss</div>
            <div className="fv">{Lr(f.collectiveLoss)}</div>
            <div className="fn">{f.lossPct}% of all milk available ({Lr(f.available)})</div>
          </div>
        </div>
        <div className="fside">
          <ChipView c={{ kind: "waste", label: "Wastage", amount: f.wasteTotal, key: "w-all" }} open={!!open["w-all"]} onToggle={toggle} />
          <ChipView c={{ kind: "miss", label: "Missing", amount: f.missingTotal, key: "m-all" }} open={!!open["m-all"]} onToggle={toggle} />
        </div>
      </div>
      {open["w-all"] && !isZero(f.wasteTotal) && (() => { const d = drill("w-all")!; return <DrillTable header={d.header} rows={d.rows} />; })()}
      {open["m-all"] && !isZero(f.missingTotal) && (() => { const d = drill("m-all")!; return <DrillTable header={d.header} rows={d.rows} />; })()}
    </div>,
  );

  return <div className="flowlist">{out}</div>;
}

const WASTE_HOW: Record<WasteBucket, string> = {
  farm: "written off at the farm, before anything was sent",
  packaging: "written off at packaging",
  retail: "short on arrival at Retail, or written off there",
  road: "reported by the rider from the round",
  riderReturn: "spoiled part of what riders brought back",
  other: "written off at another stage",
};

// ── Reasons & loss breakdown ────────────────────────────────────────────────

type SortKey = "stage" | "name" | "count" | "share";

export function ReasonSummary({ s }: { s: ReconciliationSummary }) {
  const [sortKey, setSortKey] = useState<SortKey>("stage");
  const [dir, setDir] = useState<1 | -1>(1);
  const f = s.flow;

  function sortBy(k: SortKey) {
    if (sortKey === k) setDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setDir(k === "count" || k === "share" ? -1 : 1); }
  }
  const arrow = (k: SortKey) =>
    sortKey !== k ? <span className="sarr dim">&#8645;</span> : dir > 0 ? <span className="sarr">&#9650;</span> : <span className="sarr">&#9660;</span>;

  // Every wastage stage with the reasons written on its entries, then every
  // missing gap — which has no reason on record, and is shown as exactly that.
  type Group = { key: string; label: string; tag: "w" | "m"; total: number; rows: { name: string; amt: number; share: number }[] };
  const groups: Group[] = [];
  for (const b of Object.keys(WASTE_BUCKET_LABEL) as WasteBucket[]) {
    const total = f.waste[b];
    if (isZero(total)) continue;
    groups.push({
      key: b, label: WASTE_BUCKET_LABEL[b], tag: "w", total,
      rows: s.wasteReasons[b].map((r) => ({ name: r.reason, amt: r.qty, share: pct(r.qty, total) })),
    });
  }
  for (const p of f.missingParts) {
    groups.push({
      key: p.key, label: p.label, tag: "m", total: p.amount,
      rows: [{ name: "No reason on record — the gap between two recorded figures", amt: p.amount, share: 100 }],
    });
  }

  if (!groups.length) {
    return <div className="rsum"><div className="rsum-empty">No wastage or missing milk in this date range.</div></div>;
  }
  const grand = groups.reduce((t, g) => t + g.total, 0);
  const ordered = groups.slice();
  if (sortKey === "count" || sortKey === "share") ordered.sort((a, b) => dir * (a.total - b.total));

  return (
    <div className="rsum">
      <table>
        <thead>
          <tr>
            <th className={`sortable ${sortKey === "name" ? "act" : ""}`} onClick={() => sortBy("name")}>Stage / reason {arrow("name")}</th>
            <th className={`n sortable ${sortKey === "count" ? "act" : ""}`} onClick={() => sortBy("count")}>{arrow("count")} Count</th>
            <th className={`n sortable ${sortKey === "share" ? "act" : ""}`} onClick={() => sortBy("share")}>{arrow("share")} Share of stage</th>
            <th className="n" />
          </tr>
        </thead>
        <tbody>
          {ordered.map((g) => {
            const rows = g.rows.slice();
            if (sortKey === "name") rows.sort((a, b) => dir * a.name.localeCompare(b.name));
            else if (sortKey === "count") rows.sort((a, b) => dir * (a.amt - b.amt));
            else if (sortKey === "share") rows.sort((a, b) => dir * (a.share - b.share));
            return (
              <Fragment key={g.key}>
                <tr className="stage-row">
                  <td>
                    <span className="stage-lab">
                      <span className={`tag ${g.tag}`}>{g.tag === "w" ? "Wastage" : "Missing"}</span>{g.label}
                    </span>
                  </td>
                  <td className="stage-tot">{Lr(g.total)}</td>
                  <td />
                  <td className="rrs-bar" />
                </tr>
                {rows.map((r) => (
                  <tr key={g.key + r.name}>
                    <td className="rrs-nm">{r.name}</td>
                    <td className="rrs-amt">{Lr(r.amt)}</td>
                    <td className="rrs-pct">{r.share}%</td>
                    <td className="rrs-bar"><span className="barwrap" style={{ display: "block" }}><span style={{ width: `${r.share}%` }} /></span></td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
          <tr className="grand">
            <td>Total loss (all stages)</td>
            <td className="rrs-amt">{Lr(grand)}</td>
            <td className="rrs-pct">100%</td>
            <td className="rrs-bar" />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

"use client";

import { Fragment, useState, type ReactNode } from "react";
import type { ReconciliationSummary, RiderFlow } from "@/app/(dashboard)/inventory/reconciliation/actions";
import { isEggName } from "@/lib/product-names";
import { Lr, PC, qtyOrNull, isZero } from "@/components/inventory/reconciliation-format";

// The Detailed tab: one day, every product and every rider, in the approved design.
// The same summary the Summary tab reads, for a single day — so a card here and a
// step there can never disagree about the same litre.

const WarnIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <path d="M12 9v4M12 17h.01" />
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  </svg>
);

function Card({ cls, lab, val, note }: { cls: string; lab: string; val: string; note: string }) {
  return (
    <div className={`c ${cls}`}>
      <div className="lab">{lab}</div>
      <div className="val">{val}</div>
      <div className="note">{note}</div>
    </div>
  );
}

export function ReconciliationDetail({
  s,
  day,
}: {
  /** The summary for exactly this one day. */
  s: ReconciliationSummary;
  day: string;
}) {
  const [rider, setRider] = useState<RiderFlow | null>(null);
  const f = s.flow;
  const m = s.milk;
  const e = s.eggs;

  const milkCards: [string, string, string, string][] = [
    ["cl-green", "Farm production", Lr(f.produced), "gross output"],
    ["cl-amber", "Calfs + kitchen", Lr(f.farmUse), `calfs ${Lr(f.calfUse)} · kitchen ${Lr(f.kitchenUse)} · skim ${Lr(f.skimUse)}`],
    ["cl-green", "Net production", Lr(f.produced - f.farmUse), "left to sell"],
    ["cl-blue", "Accepted at packaging", Lr(f.farmAccepted), "into inventory"],
    ["cl-red", "Farm wasted", Lr(m.farmWasted), "up to the retail point"],
    [
      "cl-teal", "Sent to Retail", Lr(f.toRetail),
      m.retailShort > 0.0005 ? `${Lr(m.retailShort)} short on arrival` : m.retailReceived > 0.0005 ? "all received" : f.toRetail > 0.0005 ? "awaiting confirmation" : "nothing sent",
    ],
    ["cl-ink", "Riders took", Lr(f.riderLoad), "confirmed load + extras"],
    ["cl-green", "Delivered", Lr(f.delivered), "to customers"],
    ["cl-red", "Rider wasted", Lr(f.waste.road), "spilled on the road"],
    ["cl-ink", "Expected return", Lr(f.supposedReturn), "load − delivered − road wastage"],
    ["cl-blue", "Actual return", Lr(f.returned), "handed in at the farm"],
    ["cl-red", "Missing", Lr(f.riderGap), "expected − actual return"],
  ];
  const eggCards: [string, string, string, string][] = [
    ["cl-egg", "Collected", PC(e.collected), "entered at packaging"],
    ["cl-teal", "Sent to Retail", PC(e.toRetail), "to load the shifts"],
    ["cl-ink", "Riders took", PC(e.riderLoad), "confirmed load + extras"],
    ["cl-green", "Delivered", PC(e.delivered), "to customers"],
    ["cl-red", "Rider wasted", PC(e.wasted), "broken / spoiled"],
    ["cl-blue", "Actual return", PC(e.returned), "handed in"],
    ["cl-red", "Missing", PC(e.missing), "shortfall"],
  ];

  // Worth a look — each line names the two recorded figures that disagree.
  const bits: ReactNode[] = [];
  if (f.acceptGap > 0.0005) bits.push(<><b>{Lr(f.acceptGap)}</b> left the farm&apos;s figures and never reached packaging</>);
  if (f.acceptGap < -0.0005) bits.push(<>packaging received <b>{Lr(-f.acceptGap)}</b> more than the farm&apos;s figures say it had</>);
  if (m.retailShort > 0.0005) bits.push(<>Retail received <b>{Lr(m.retailShort)}</b> less than was sent</>);
  if (f.retailLeftover < -0.0005) bits.push(<>riders took <b>{Lr(-f.retailLeftover)}</b> more than Retail had</>);
  if (f.riderGap > 0.0005) bits.push(<><b>{Lr(f.riderGap)}</b> not accounted for by the riders</>);
  if (e.missing > 0.5) bits.push(<><b>{PC(e.missing)}</b> of eggs not accounted for</>);
  if (f.waste.road > 0.0005) bits.push(<><b>{Lr(f.waste.road)}</b> spilled on the road</>);

  return (
    <>
      <p className="detail-date">
        Daily detail · <strong>{day}</strong> · For range totals, use Summary.
      </p>
      <div className="sec-lab">Farm production &amp; distribution (milk, L)</div>
      <div className="cards">{milkCards.map(([c, l, v, n]) => <Card key={l} cls={c} lab={l} val={v} note={n} />)}</div>

      <div className="sec-lab" style={{ marginTop: 26 }}>
        Eggs
        <span className="hint">Collected at packaging, out with the riders, and back again (pieces)</span>
      </div>
      <div className="cards">{eggCards.map(([c, l, v, n]) => <Card key={l} cls={c} lab={l} val={v} note={n} />)}</div>

      <div className={`flag ${bits.length ? "" : "good"}`}>
        <WarnIcon />
        {bits.length
          ? <div><b>Worth a look:</b> {bits.map((b, i) => <Fragment key={i}>{i > 0 ? " · " : ""}{b}</Fragment>)}</div>
          : <div>Everything reconciles for this day.</div>}
      </div>

      <div className="sec-lab" style={{ marginTop: 28 }}>Stage by stage</div>
      <StageTable s={s} />

      <div className="sec-lab" style={{ marginTop: 28 }}>Rider breakdown</div>
      <RiderTable s={s} onCheck={setRider} />

      <div className={`ov ${rider ? "show" : ""}`} onClick={(ev) => { if (ev.target === ev.currentTarget) setRider(null); }}>
        {rider && <RiderOverlay r={rider} onClose={() => setRider(null)} />}
      </div>
    </>
  );
}

// ── Stage by stage ─────────────────────────────────────────────────────────

function StageTable({ s }: { s: ReconciliationSummary }) {
  const st = s.stages;
  const cols = s.products.filter(
    (p) => p.kind !== "other" && Object.values(st).some((map) => Math.abs((map as Record<string, number>)[p.id] ?? 0) > 0.0005),
  );
  const milkIds = s.products.filter((p) => p.kind === "milk").map((p) => p.id);

  const net: Record<string, number> = {};
  for (const p of s.products) {
    net[p.id] = (st.produced[p.id] ?? 0) - (st.calfUse[p.id] ?? 0) - (st.kitchenUse[p.id] ?? 0) - (st.skimUse[p.id] ?? 0);
  }

  const rows: [label: string, map: Record<string, number>, derived?: boolean][] = [
    ["Farm production", st.produced],
    ["Bought in", st.purchased],
    ["Calfs", st.calfUse],
    ["Kitchen use", st.kitchenUse],
    ["Skim milk", st.skimUse],
    ["Net production", net, true],
    ["Accepted at packaging", st.acceptedAtPackaging],
    ["Wasted at packing", st.packWaste],
    ["Made here", st.madeHere],
    ["Used for mix milk", st.mixUse],
    ["Cow milk given to buffalo", st.dilutionOut],
    ["Added to buffalo", st.dilutionIn],
    ["Yogurt use", st.yoghurtUse],
    ["Sold over the counter", st.counterSale],
    ["Sent to Retail", st.toRetail],
    ["Retail received", st.retailReceived],
    ["Short at Retail", st.retailShort, true],
    ["Wasted at Retail", st.retailWaste],
    ["Dispatched to riders", st.riderLoad],
    ["Delivered to customers", st.delivered],
    ["Charged, came back", st.riderChargedBack],
    ["Returned by customers", st.customerReturns],
    ["Rider wasted", st.riderWasted],
    ["Took less than the sheet", st.loadShort],
    ["Rider returns - came back", st.returnedToFarm],
    ["Rider returns - into inventory", st.riderReturnStock],
    ["Rider returns - wasted", st.riderReturnWaste],
    ["Retail leftover", st.retailLeftover],
    ["Retail return - into inventory", st.retailReturnStock],
    ["Retail return - wasted", st.retailReturnWaste],
    ["Farm wasted", st.farmWaste],
    ["Other wastage", st.otherWaste],
  ];
  const vcls = (name: string) => (isEggName(name) ? "v-egg" : /mix/i.test(name) ? "v-mix" : /buffalo/i.test(name) ? "v-buf" : "v-cow");

  return (
    <div className="tcard">
      <div className="tcard-h">
        <div className="t">Every stage of the chain, by product</div>
        <div className="s">Litres (yogurt in kg); eggs in pieces. A stage with nothing in it shows a dash.</div>
      </div>
      <div className="tscroll">
        <table>
          <thead>
            <tr>
              <th>Stage</th>
              {cols.map((p) => <th key={p.id} className="r">{p.name}</th>)}
              <th className="r">Total milk</th>
            </tr>
          </thead>
          <tbody>
            {cols.length === 0 ? (
              <tr><td colSpan={2} className="dash">Nothing was produced, sent or delivered on this day.</td></tr>
            ) : rows.map(([label, map, derived]) => {
              const total = milkIds.reduce((t, id) => t + (map[id] ?? 0), 0);
              return (
                <tr key={label} className={derived ? "derived" : ""}>
                  <td className="stage-name">{label}</td>
                  {cols.map((p) => {
                    const v = qtyOrNull(map[p.id], p.unit);
                    return <td key={p.id} className={`r ${vcls(p.name)}`}>{v ?? <span className="dash">-</span>}</td>;
                  })}
                  <td className="r v-tot">{qtyOrNull(total, "LITER") ?? <span className="dash">-</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Riders ─────────────────────────────────────────────────────────────────

const r1 = (v: number) => Math.round(v * 10) / 10;

function RiderTable({ s, onCheck }: { s: ReconciliationSummary; onCheck: (r: RiderFlow) => void }) {
  if (!s.riders.length) {
    return (
      <div className="tcard">
        <div className="empty-flow" style={{ border: 0 }}>No shift went out on this day, so there is nothing to account for.</div>
      </div>
    );
  }
  // What should come back is what went out, less what was delivered and what the
  // rider himself reported spilled — the same sum as the Summary tab's
  // "Supposed to be Returned", rider by rider.
  const due = (l: RiderFlow["milk"]) => l.expected - l.wasted;
  const T = s.riders.reduce(
    (t, r) => ({
      mt: t.mt + r.milk.got, md: t.md + r.milk.delivered, mw: t.mw + r.milk.wasted, mx: t.mx + due(r.milk), mr: t.mr + r.milk.returned, mm: t.mm + r.milk.missing,
      et: t.et + r.eggs.got, ed: t.ed + r.eggs.delivered, ex: t.ex + due(r.eggs), er: t.er + r.eggs.returned, em: t.em + r.eggs.missing,
    }),
    { mt: 0, md: 0, mw: 0, mx: 0, mr: 0, mm: 0, et: 0, ed: 0, ex: 0, er: 0, em: 0 },
  );
  const miss = (v: number, unit: "L" | "pcs") => (
    <td className={`r miss-v ${v <= 0.0005 ? "zero" : ""}`}>{unit === "L" ? r1(v) : Math.round(v)} {unit}</td>
  );
  return (
    <div className="tcard">
      <div className="tcard-h">
        <div className="t">What each rider took, delivered, spilled, and brought back</div>
        <div className="s">Expected return = load − delivered − road wastage (+ anything a customer handed back). Missing is expected minus actual return.</div>
      </div>
      <div className="tscroll">
        <table>
          <thead>
            <tr>
              <th>Rider</th><th className="r">Milk took</th><th className="r">Delivered</th><th className="r">Wasted</th>
              <th className="r">Expected / actual</th><th className="r">Missing</th>
              <th className="r">Eggs took</th><th className="r">Delivered</th><th className="r">Exp / actual</th><th className="r">Missing</th><th />
            </tr>
          </thead>
          <tbody>
            {s.riders.map((r) => (
              <tr key={r.riderId}>
                <td className="rider-cell">{r.riderName}</td>
                <td className="r">{Lr(r.milk.got)}</td>
                <td className="r">{Lr(r.milk.delivered)}</td>
                <td className="r">{isZero(r.milk.wasted) ? <span className="dash">-</span> : Lr(r.milk.wasted)}</td>
                <td className="r">{r1(due(r.milk))} / {r1(r.milk.returned)} L</td>
                {miss(r.milk.missing, "L")}
                <td className="r">{PC(r.eggs.got)}</td>
                <td className="r">{PC(r.eggs.delivered)}</td>
                <td className="r">{Math.round(due(r.eggs))} / {Math.round(r.eggs.returned)}</td>
                {miss(r.eggs.missing, "pcs")}
                <td className="r"><button type="button" className="ck-btn" onClick={() => onCheck(r)}>Check</button></td>
              </tr>
            ))}
            <tr className="rtot">
              <td className="rider-cell">All riders</td>
              <td className="r">{Lr(T.mt)}</td><td className="r">{Lr(T.md)}</td>
              <td className="r">{isZero(T.mw) ? <span className="dash">-</span> : Lr(T.mw)}</td>
              <td className="r">{r1(T.mx)} / {r1(T.mr)} L</td>
              {miss(T.mm, "L")}
              <td className="r">{PC(T.et)}</td><td className="r">{PC(T.ed)}</td>
              <td className="r">{Math.round(T.ex)} / {Math.round(T.er)}</td>
              {miss(T.em, "pcs")}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RiderOverlay({ r, onClose }: { r: RiderFlow; onClose: () => void }) {
  const row = (k: string, v: string, bad?: boolean) => (
    <div className={`ov-row ${bad ? "bad" : ""}`} key={k}><span className="k">{k}</span><span className="v">{v}</span></div>
  );
  const head = (t: string, top: number) => (
    <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".4px", color: "var(--muted)", margin: `${top}px 0 2px` }}>{t}</div>
  );
  return (
    <div className="ov-box" role="dialog" aria-label={r.riderName}>
      <div className="ov-top">
        <div className="ov-name">{r.riderName}</div>
        <button type="button" className="ov-x" onClick={onClose} aria-label="Close">&times;</button>
      </div>
      {head("Milk (L)", 6)}
      {row("Took (load + extras)", Lr(r.milk.got))}
      {row("Delivered to customers", Lr(r.milk.delivered))}
      {!isZero(r.milk.chargedBack) && row("Charged on skipped stops (still on the van)", Lr(r.milk.chargedBack))}
      {!isZero(r.milk.customerReturns) && row("Handed back by customers", Lr(r.milk.customerReturns))}
      {row("Wasted on the road", Lr(r.milk.wasted))}
      {row("Expected return", Lr(r.milk.expected - r.milk.wasted))}
      {row("Actual return", Lr(r.milk.returned))}
      {row("Missing", `${r1(r.milk.missing)} L`, r.milk.missing > 0.0005)}
      {head("Eggs (pcs)", 16)}
      {row("Took", PC(r.eggs.got))}
      {row("Delivered", PC(r.eggs.delivered))}
      {!isZero(r.eggs.wasted) && row("Broken / spoiled", PC(r.eggs.wasted))}
      {row("Expected return", PC(r.eggs.expected - r.eggs.wasted))}
      {row("Actual return", PC(r.eggs.returned))}
      {row("Missing", `${Math.round(r.eggs.missing)} pcs`, r.eggs.missing > 0.5)}
    </div>
  );
}

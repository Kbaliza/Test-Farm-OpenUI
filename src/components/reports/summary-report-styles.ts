// The Summary Report's stylesheet, kept out of the component for readability.
//
// EVERY selector is nested under `.sr-root`, so none of it can leak into the rest
// of the app — this page looks like a printed report while every other screen
// keeps the app's own styling. Fonts come from next/font variables set on the
// page wrapper (--sr-serif / --sr-sans / --sr-mono).
export const SUMMARY_REPORT_CSS = `
.sr-root{
  --ink:#14211A; --forest:#1A4D2E; --forest-d:#0F3520; --sage:#8FAF98; --sage-l:#C3D4C7;
  --cream:#F4F1E9; --card:#FFFFFF; --mute:#6E6A60; --line:#E6E1D6; --line-s:#F0EDE4;
  --amber:#B45309; --navy:#1E3A5F; --pos:#166534; --neg:#991B1B; --warn:#C2410C; --track:#EDE9DF;
  /* Calibri, with Carlito as the metric-compatible stand-in where Calibri is
     not installed. One family for headings, body and figures alike. */
  --sr-font:Calibri,Carlito,"Segoe UI",system-ui,sans-serif;
  font-family:var(--sr-font);
  background:var(--cream); color:var(--ink);
  padding:26px 22px 60px; -webkit-font-smoothing:antialiased;
  min-height:100%;
}
.sr-root *{box-sizing:border-box}
.sr-root .wrap{max-width:1240px;margin:0 auto}

.sr-root .mast{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;flex-wrap:wrap;margin-bottom:22px}
.sr-root .mast-l{display:flex;align-items:center;gap:14px}
.sr-root .seal{width:46px;height:46px;flex:none}
.sr-root .eyebrow{font-size:10px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:var(--forest);opacity:.8}
.sr-root .mast-t{font-family:var(--sr-font);font-size:30px;font-weight:600;letter-spacing:-.02em;line-height:1.05;margin-top:2px}
.sr-root .mast-s{font-size:12.5px;color:var(--mute);margin-top:4px;font-weight:500}
.sr-root .mast-r{display:flex;align-items:center;gap:10px;flex-wrap:wrap}

.sr-root .seg{display:flex;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:3px;gap:2px}
.sr-root .seg button{padding:7px 18px;border:none;background:transparent;border-radius:999px;font:inherit;font-size:12px;font-weight:700;color:var(--mute);cursor:pointer;transition:.16s}
.sr-root .seg button:hover{color:var(--ink)}
.sr-root .seg button.on{background:var(--forest);color:#fff}
.sr-root .btn-cal{display:flex;align-items:center;gap:8px;padding:8px 15px;border:1px solid var(--line);background:var(--card);border-radius:999px;font:inherit;font-size:12px;font-weight:700;color:var(--ink);cursor:pointer;white-space:nowrap}
.sr-root .btn-cal:hover{border-color:var(--sage)}
.sr-root .btn-cal svg{width:14px;height:14px;flex:none;color:var(--forest)}
.sr-root .btn-pdf{display:flex;align-items:center;gap:7px;padding:8px 16px;border:1px solid var(--forest);background:var(--forest);color:#fff;border-radius:999px;font:inherit;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}
.sr-root .btn-pdf:hover{background:var(--forest-d)}
.sr-root .btn-pdf svg{width:13px;height:13px;flex:none}
.sr-root .date-input{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:8px 14px;font:inherit;font-size:12px;font-weight:700;color:var(--ink);cursor:pointer}
.sr-root .date-input:hover{border-color:var(--sage)}

.sr-root .sec{display:grid;grid-template-columns:34px 1fr;background:var(--card);border:1px solid var(--line);border-radius:20px;margin-bottom:16px;box-shadow:0 1px 2px rgba(20,33,26,.04),0 14px 30px -24px rgba(20,33,26,.35)}
.sr-root .rail{background:var(--sage);display:flex;align-items:center;justify-content:center;border-radius:19px 0 0 19px}
.sr-root .rail span{writing-mode:vertical-rl;transform:rotate(180deg);font-size:9.5px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#fff}
.sr-root .sec-b{padding:22px 24px;min-width:0}
.sr-root .sec-h{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:18px;flex-wrap:wrap}
.sr-root .sec-t{font-family:var(--sr-font);font-size:17px;font-weight:600}
.sr-root .sec-s{font-size:11.5px;color:var(--mute);margin-top:3px;font-weight:500}
.sr-root .row{display:grid;grid-template-columns:1fr 300px;gap:16px;align-items:start}
@media(max-width:940px){.sr-root .row{grid-template-columns:1fr}}

.sr-root .mets{display:grid;grid-template-columns:repeat(3,1fr);gap:26px}
@media(max-width:760px){.sr-root .mets{grid-template-columns:1fr;gap:22px}}
.sr-root .met-l{font-size:12px;font-weight:600;color:var(--mute);display:flex;align-items:center}
.sr-root .met-v{font-family:var(--sr-font);font-size:33px;font-weight:600;letter-spacing:-.025em;line-height:1;margin:9px 0 7px;font-variant-numeric:tabular-nums}
@media(max-width:520px){.sr-root .met-v{font-size:29px}}
.sr-root .dlt{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;font-family:var(--sr-font)}
.sr-root .dlt em{font-style:normal;color:var(--mute);font-family:var(--sr-font);font-weight:600}
.sr-root .up{color:var(--pos)}.sr-root .down{color:var(--neg)}.sr-root .flat{color:var(--mute)}

.sr-root .spark{display:flex;align-items:flex-end;gap:3px;height:58px;margin-top:14px}
.sr-root .spark i{flex:1;border-radius:2px 2px 0 0;min-height:2px;display:block}
.sr-root .spark-x{display:flex;gap:3px;margin-top:6px}
.sr-root .spark-x span{flex:1;text-align:center;font-size:8.5px;font-weight:600;color:#A8A296;font-family:var(--sr-font);letter-spacing:-.03em;overflow:hidden;white-space:nowrap}

.sr-root .rings{display:flex;flex-direction:column;gap:20px;background:#FAF9F5;border:1px solid var(--line);border-radius:16px;padding:20px}
@media(max-width:940px){.sr-root .rings{flex-direction:row;justify-content:space-around}}
@media(max-width:520px){.sr-root .rings{flex-direction:column}}
.sr-root .ring{display:flex;align-items:center;gap:14px}
.sr-root .ring svg{width:78px;height:78px;flex:none;transform:rotate(-90deg)}
.sr-root .ring-v{font-family:var(--sr-font);font-size:26px;font-weight:700;line-height:1}
.sr-root .ring-l{font-size:11.5px;font-weight:700;color:var(--ink);margin-top:5px}
.sr-root .ring-s{font-size:10.5px;color:var(--mute);margin-top:2px;line-height:1.45;font-weight:500}

.sr-root .kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
@media(max-width:1020px){.sr-root .kpis{grid-template-columns:repeat(3,1fr)}}
@media(max-width:680px){.sr-root .kpis{grid-template-columns:repeat(2,1fr)}}
@media(max-width:400px){.sr-root .kpis{grid-template-columns:1fr}}
.sr-root .kpi{background:#FAF9F5;border:1px solid var(--line);border-radius:14px;padding:14px 15px}
.sr-root .kpi-l{font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--mute);display:flex;align-items:center;line-height:1.4}
.sr-root .kpi-v{font-family:var(--sr-font);font-size:23px;font-weight:700;line-height:1.1;margin-top:8px;font-variant-numeric:tabular-nums}
.sr-root .kpi-s{font-size:10.5px;color:var(--mute);margin-top:4px;font-weight:500;line-height:1.4}

.sr-root .prow{padding:11px 0;border-bottom:1px solid var(--line-s)}
.sr-root .prow:last-child{border-bottom:none}
.sr-root .prow-top{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:7px}
.sr-root .prow-name{font-size:13.5px;font-weight:700}
.sr-root .prow-qty{font-size:10.5px;color:var(--mute);margin-left:7px;font-weight:600;font-family:var(--sr-font)}
.sr-root .prow-val{font-size:15px;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}
.sr-root .bar{height:7px;background:var(--track);border-radius:4px;overflow:hidden}
.sr-root .bar-fill{height:100%;border-radius:4px}
.sr-root .panel{background:#FAF9F5;border:1px solid var(--line);border-radius:16px;padding:16px 18px;min-width:0}
.sr-root .panel-t{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.sr-root .two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:820px){.sr-root .two{grid-template-columns:1fr}}

.sr-root .cycs{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:820px){.sr-root .cycs{grid-template-columns:1fr}}
.sr-root .cyc{background:#FAF9F5;border:1px solid var(--line);border-radius:16px;padding:16px 18px;min-width:0}
.sr-root .cyc-top{display:flex;gap:15px;align-items:center}
.sr-root .cyc svg{width:74px;height:74px;flex:none;transform:rotate(-90deg)}
.sr-root .cyc-name{font-size:13px;font-weight:800}
.sr-root .cyc-grid{display:flex;gap:14px;margin-top:9px;flex-wrap:wrap}
.sr-root .cyc-l{font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}
.sr-root .cyc-v{font-size:14.5px;font-weight:800;font-variant-numeric:tabular-nums;margin-top:2px;font-family:var(--sr-font)}
.sr-root .cyc-sub{margin-top:14px;padding-top:13px;border-top:1px solid var(--line)}
.sr-root .cyc-sub-t{font-size:9.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);display:flex;align-items:center;justify-content:space-between;gap:8px}
.sr-root .cyc-sub-t b{font-family:var(--sr-font);font-size:10.5px;color:var(--ink);letter-spacing:0}
.sr-root .prow-sm{padding:7px 0}
.sr-root .prow-sm .prow-top{margin-bottom:5px}
.sr-root .prow-sm .prow-name{font-size:12px}
.sr-root .prow-sm .prow-val{font-size:12px}
.sr-root .prow-sm .bar{height:5px}

.sr-root .tl-axis{position:relative;height:16px;margin:0 0 4px 92px}
.sr-root .tl-axis span{position:absolute;transform:translateX(-50%);font-size:9px;font-weight:700;color:#A8A296;font-family:var(--sr-font);white-space:nowrap}
.sr-root .tl-row{display:grid;grid-template-columns:92px 1fr;align-items:center;padding:7px 0}
.sr-root .tl-name{font-size:12.5px;font-weight:700;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.sr-root .tl-name small{font-size:10px;color:var(--mute);font-weight:600;font-family:var(--sr-font)}
.sr-root .tl-track{position:relative;height:26px;background:linear-gradient(to bottom,transparent 46%,var(--line-s) 46%,var(--line-s) 54%,transparent 54%)}
.sr-root .tl-span{position:absolute;top:5px;height:16px;border-radius:8px;background:var(--forest);display:flex;align-items:center;justify-content:space-between;padding:0 8px;min-width:24px}
.sr-root .tl-span b{font-size:9px;color:#fff;font-weight:700;font-family:var(--sr-font);white-space:nowrap;opacity:.92}
.sr-root .tl-mark{position:absolute;top:0;bottom:0;width:2px;border-radius:1px}
.sr-root .tl-legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;padding-top:12px;border-top:1px solid var(--line-s)}
.sr-root .tl-lg{display:flex;align-items:center;gap:7px;font-size:10.5px;color:var(--mute);font-weight:600}
.sr-root .tl-dot{width:9px;height:9px;border-radius:3px}
@media(max-width:600px){.sr-root .tl-row{grid-template-columns:1fr;gap:2px}.sr-root .tl-axis{margin-left:0}}

.sr-root .split{display:flex;height:28px;border-radius:8px;overflow:hidden;margin:9px 0 7px;background:var(--track)}
.sr-root .split div{display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;font-family:var(--sr-font);min-width:0;overflow:hidden}
.sr-root .split-l{display:flex;justify-content:space-between;gap:10px;font-size:10.5px;color:var(--mute);font-weight:600;flex-wrap:wrap}
.sr-root .split-l b{color:var(--ink);font-family:var(--sr-font);font-weight:700}

.sr-root .emp{padding:12px 0;border-bottom:1px solid var(--line-s);cursor:pointer;width:100%;text-align:left;background:none;border-left:none;border-right:none;border-top:none;font:inherit}
.sr-root .emp:last-child{border-bottom:none}
.sr-root .emp:hover{background:#FAF9F5}
.sr-root .emp-top{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:7px}
.sr-root .emp-l{display:flex;align-items:center;gap:11px}
.sr-root .emp-av{width:34px;height:34px;border-radius:11px;background:var(--forest);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:800;flex:none}
.sr-root .emp-name{font-size:13px;font-weight:700}
.sr-root .emp-role{font-size:10.5px;color:var(--mute);font-weight:600}
.sr-root .emp-pct{font-size:14px;font-weight:800;font-variant-numeric:tabular-nums}
.sr-root .emp-meta{font-size:10.5px;color:var(--mute);margin-top:5px;font-weight:500}

.sr-root table{width:100%;border-collapse:collapse;font-size:12.5px}
.sr-root th{text-align:left;padding:9px 0;font-size:9.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--mute);font-weight:800;border-bottom:1px solid var(--line);white-space:nowrap}
.sr-root td{padding:11px 0;border-bottom:1px solid var(--line-s);white-space:nowrap;vertical-align:middle}
.sr-root tr:last-child td{border-bottom:none}
.sr-root .right{text-align:right}
.sr-root .mono{font-variant-numeric:tabular-nums;font-family:var(--sr-font)}
.sr-root .swatch{width:9px;height:9px;border-radius:3px;display:inline-block;margin-right:9px;vertical-align:middle}
.sr-root .donut{width:150px;height:150px;border-radius:50%;position:relative;flex:none;margin:0 auto}
.sr-root .donut::after{content:"";position:absolute;inset:31px;background:#FAF9F5;border-radius:50%}
.sr-root .donut-c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:2}
.sr-root .donut-v{font-family:var(--sr-font);font-size:17px;font-weight:600}
.sr-root .donut-l{font-size:8.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);margin-top:2px}

.sr-root .tag{font-size:10px;font-weight:800;padding:4px 11px;border-radius:999px;white-space:nowrap}
.sr-root .t-ok{background:#E4F2E7;color:var(--pos)}
.sr-root .t-warn{background:#FBEEDC;color:#92400E}
.sr-root .t-bad{background:#FBE6E6;color:var(--neg)}
.sr-root .t-neutral{background:var(--track);color:var(--mute)}
.sr-root .empty{font-size:11.5px;color:var(--mute);font-weight:500;padding:14px 0;text-align:center}

.sr-root .info-i{display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;background:#CFCABD;color:#fff;font-size:9px;font-weight:800;cursor:help;margin-left:5px;position:relative;font-style:normal;vertical-align:middle;flex:none}
.sr-root .info-i:hover,.sr-root .info-i:focus{background:var(--forest);outline:none}
.sr-root .info-i:hover .tip,.sr-root .info-i:focus .tip{opacity:1;visibility:visible}
.sr-root .tip{position:absolute;bottom:calc(100% + 9px);left:50%;transform:translateX(-50%);width:min(196px,70vw);background:var(--ink);color:#fff;font-size:11px;font-weight:400;line-height:1.5;padding:10px 12px;border-radius:9px;opacity:0;visibility:hidden;transition:.15s;z-index:60;text-align:left;text-transform:none;letter-spacing:0;pointer-events:none}
.sr-root .tip::after{content:"";position:absolute;top:100%;left:50%;transform:translateX(-50%);border:5px solid transparent;border-top-color:var(--ink)}

.sr-root .ov{position:fixed;inset:0;background:rgba(20,33,26,.5);z-index:100;display:flex;align-items:center;justify-content:center;padding:20px}
.sr-root .ov-card{background:#fff;border-radius:20px;width:460px;max-width:100%;max-height:86vh;overflow-y:auto;padding:24px}
.sr-root .foot{text-align:center;font-size:10.5px;color:#A8A296;margin-top:22px;font-weight:600}

@media (prefers-reduced-motion:reduce){.sr-root *{transition:none!important;animation:none!important}}
@media print{
  .sr-root{background:#fff;padding:0;font-size:11px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sr-root .wrap{max-width:100%}
  .sr-root .mast-r,.sr-root .info-i,.sr-root .ov{display:none!important}
  .sr-root .mast{margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--line)}
  .sr-root .sec{break-inside:avoid;page-break-inside:avoid;box-shadow:none;margin-bottom:10px}
  .sr-root .sec-b{padding:16px 18px}
  .sr-root .met-v{font-size:26px}
  .sr-root .spark{height:44px}
  .sr-root .emp{cursor:default}
  .sr-root .foot{margin-top:12px}
}

/* ── Phones ─────────────────────────────────────────────────────────────────
 *
 * The section rail is a 34px vertical strip of decoration. On a 360px screen
 * that plus 48px of padding leaves the content barely half the width, which is
 * why the figures looked cramped. It becomes a 6px bar along the top: the
 * colour coding survives, the width comes back. The section's own heading
 * already says what the rail said.
 */
@media(max-width:640px){
  .sr-root{padding:14px 12px 40px}
  .sr-root .sec{grid-template-columns:1fr;border-radius:14px;margin-bottom:12px}
  .sr-root .rail{height:5px;border-radius:13px 13px 0 0}
  .sr-root .rail span{display:none}
  .sr-root .sec-b{padding:16px 14px}
  .sr-root .sec-h{margin-bottom:14px;gap:8px}
  .sr-root .mast{margin-bottom:16px}
  .sr-root .mast-t{font-size:24px}
  .sr-root .kpi{padding:12px 13px}
  .sr-root .kpi-v{font-size:21px}
  .sr-root .panel,.sr-root .cyc{padding:14px 14px}
  /* Both controls on one line each, rather than a cramped row of three. */
  .sr-root .mast-r{width:100%;gap:8px}
  .sr-root .seg{flex:1}
  .sr-root .seg button{flex:1;padding:7px 10px}
}
`;

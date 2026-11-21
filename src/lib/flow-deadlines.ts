import "server-only";
import { db } from "@/lib/db";

// The time each step of the day is supposed to be done by.
//
// The same schedule every day, so the Flow Log can say whether a step was on time
// rather than only when it happened. Held as one setting because the page, the
// per-step chips and the performance figures all have to agree about it — and
// because a target nobody can see is a target nobody meets.
//
// Edited from the Flow Log page and kept in AppSetting, so a change holds for
// every day — past days included, since the page judges them against it — until
// someone changes it again. Until it is first saved, the defaults below apply.

/** "HH:MM" on a 24-hour clock, PKT. */
export type Clock = string;

export type FlowDeadlines = {
  /** Milkings, in the order they are recorded through the day. */
  production: Clock[];
  /** Packaging accepting each milking into its stock, in order. */
  accepted: Clock[];
  /** Sends to Retail, in order. */
  packaging: Clock[];
  /** Retail accepting each send, in order. */
  retailAccepted: Clock[];
  /** Eggs collected and packed — one step, one person, one deadline. */
  eggs: Clock;
  /** The first rider load of the day leaving. */
  dispatch: Clock;
  /** Each rider's four stamps. */
  rider: { recv: Clock; start: Clock; end: Clock; ret: Clock };
  /** The leftover from every rider accepted back into stock. */
  returnsAccepted: Clock;
};

export const DEFAULT_FLOW_DEADLINES: FlowDeadlines = {
  production: ["05:00", "12:30", "17:30"],
  accepted: ["05:30", "13:00", "18:00"],
  packaging: ["06:30", "12:45", "18:45"],
  retailAccepted: ["07:00", "13:15", "19:15"],
  eggs: "08:00",
  dispatch: "07:15",
  rider: { recv: "07:10", start: "07:45", end: "11:00", ret: "19:00" },
  returnsAccepted: "19:00",
};

export const FLOW_DEADLINES_KEY = "flow.deadlines";

const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const clock = (v: unknown, fallback: Clock): Clock => (typeof v === "string" && CLOCK_RE.test(v) ? v : fallback);

/**
 * Anything that is not a well-formed schedule falls back, field by field, to the
 * default — a half-saved or hand-edited setting must never break the page.
 */
export function normaliseDeadlines(raw: unknown): FlowDeadlines {
  const d = DEFAULT_FLOW_DEADLINES;
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof FlowDeadlines, unknown>>;
  const list = (v: unknown, def: Clock[]) =>
    Array.isArray(v) && v.length > 0 ? v.slice(0, 6).map((x, i) => clock(x, def[i] ?? def[def.length - 1])) : def;
  const obj = <T extends Record<string, Clock>>(v: unknown, def: T): T => {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(def).map(([k, dv]) => [k, clock(o[k], dv)])) as T;
  };
  return {
    production: list(r.production, d.production),
    accepted: list(r.accepted, d.accepted),
    packaging: list(r.packaging, d.packaging),
    retailAccepted: list(r.retailAccepted, d.retailAccepted),
    // Saved before eggs became one step, as { collected, packed }: the packed time
    // is the one that still means "done".
    eggs: clock(typeof r.eggs === "object" && r.eggs ? (r.eggs as { packed?: unknown }).packed : r.eggs, d.eggs),
    dispatch: clock(r.dispatch, d.dispatch),
    rider: obj(r.rider, d.rider),
    returnsAccepted: clock(r.returnsAccepted, d.returnsAccepted),
  };
}

/** True when every time in the schedule is a real "HH:MM" — nothing left blank. */
export function deadlinesComplete(d: FlowDeadlines): boolean {
  const all = [...d.production, ...d.accepted, ...d.packaging, ...d.retailAccepted, d.eggs, d.dispatch, ...Object.values(d.rider), d.returnsAccepted];
  return all.length > 0 && all.every((c) => typeof c === "string" && CLOCK_RE.test(c));
}

export async function getFlowDeadlines(): Promise<FlowDeadlines> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: FLOW_DEADLINES_KEY } });
    return row ? normaliseDeadlines(JSON.parse(row.value)) : DEFAULT_FLOW_DEADLINES;
  } catch {
    return DEFAULT_FLOW_DEADLINES;
  }
}

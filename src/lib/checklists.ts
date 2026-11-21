import "server-only";
import { db } from "@/lib/db";
import { pktNoonToUTC, todayPKTString } from "@/lib/pkt";
import { parseHHMM } from "@/lib/checklist-time";

// The canonical PKT "day key" a completion is stamped with — timezone-independent
// (same instant on a UTC server and a PKT machine), so a tick made today always
// lands on today and a new PKT day starts with zero completion rows. Mirrors how
// Route.date is keyed. No reset job is needed: absence of a row = "not done".
export function checklistDayKey(dateStr?: string): Date {
  return pktNoonToUTC(dateStr ?? todayPKTString());
}

// Minutes-since-midnight of the current PKT wall clock (PKT = UTC+5).
export function pktNowMinutes(): number {
  const p = new Date(Date.now() + 5 * 60 * 60 * 1000);
  return p.getUTCHours() * 60 + p.getUTCMinutes();
}

// Re-exported so existing callers keep one import site; the definition lives in
// the pure module the rider API and the tests share.
export { parseHHMM };

// Active checklists that are PAST their due time today AND not fully ticked.
// Pure read, no auth — an internal helper shared by the alerts feed and the page.
export async function getOverdueChecklists(): Promise<
  { id: string; title: string; assigneeName: string; dueTime: string }[]
> {
  const date = checklistDayKey();
  const nowMins = pktNowMinutes();
  const checklists = await db.checklist.findMany({
    where: { active: true },
    select: {
      id: true,
      title: true,
      dueTime: true,
      assignee: { select: { name: true } },
      items: { select: { id: true, completions: { where: { date }, select: { id: true } } } },
    },
  });

  const out: { id: string; title: string; assigneeName: string; dueTime: string }[] = [];
  for (const c of checklists) {
    if (c.items.length === 0) continue; // an empty checklist can't be "overdue"
    const done = c.items.filter((i) => i.completions.length > 0).length;
    if (done >= c.items.length) continue; // already complete today
    const due = parseHHMM(c.dueTime);
    if (due === null) continue;
    if (nowMins > due) out.push({ id: c.id, title: c.title, assigneeName: c.assignee.name, dueTime: c.dueTime });
  }
  return out;
}

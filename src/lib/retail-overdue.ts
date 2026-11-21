import "server-only";
import { db } from "@/lib/db";
import { todayPKTString, toDateStrPKT } from "@/lib/pkt";
import { dueDateFor, bucketFor } from "@/lib/retail-followup";
import { openQty } from "@/lib/retail-math";

// Drops whose check-back date has passed while product is still unaccounted for.
// Pure read, no auth — an internal helper shared by the retail page and the
// alerts feed, mirroring getOverdueChecklists() in src/lib/checklists.ts.
export async function getOverdueRetailFollowups(): Promise<
  { id: string; placementNo: string; martName: string; dueDate: string; daysLate: number }[]
> {
  const today = todayPKTString();
  const placements = await db.retailPlacement.findMany({
    where: { voidedAt: null },
    select: {
      id: true,
      placementNo: true,
      date: true,
      followUpAt: true,
      retailVendor: { select: { name: true, followUpDays: true } },
      lines: { select: { quantity: true, soldQty: true, wastedQty: true } },
    },
  });

  const out: { id: string; placementNo: string; martName: string; dueDate: string; daysLate: number }[] = [];
  for (const p of placements) {
    // Nothing left to ask about once every line is accounted for.
    const stillOut = p.lines.some(
      (l) =>
        openQty({
          quantity: Number(l.quantity),
          soldQty: Number(l.soldQty),
          wastedQty: Number(l.wastedQty),
        }) > 0.000001
    );
    if (!stillOut) continue;

    const dropDay = toDateStrPKT(p.date);
    const dueDate = p.followUpAt
      ? toDateStrPKT(p.followUpAt)
      : dueDateFor(dropDay, p.retailVendor.followUpDays);
    if (bucketFor(dueDate, today) !== "overdue") continue;

    const [dy, dm, dd] = dueDate.split("-").map(Number);
    const [ty, tm, td] = today.split("-").map(Number);
    out.push({
      id: p.id,
      placementNo: p.placementNo,
      martName: p.retailVendor.name,
      dueDate,
      daysLate: Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(dy, dm - 1, dd)) / 86_400_000),
    });
  }
  return out.sort((a, b) => b.daysLate - a.daysLate);
}

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { PaymentHead } from "@prisma/client";
import { PAYMENT_HEADS, PAYMENT_HEAD_LABELS, RECEIVE_HEADS, OWNERS_HEAD, canReceiveInto, isHeldHead } from "@/lib/payment-heads";

// The heads are listed in more places than one — colour maps, dropdowns, label
// maps. These tests make a head that is missing from any of them a failing build
// rather than an account that quietly does not show up on one screen.

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const count = (text: string, token: string) => (text.match(new RegExp(`\b${token}\b`, "g")) ?? []).length;

describe("payment heads", () => {
  it("are exactly the database's PaymentHead values, in order", () => {
    expect([...PAYMENT_HEADS]).toEqual(Object.values(PaymentHead));
  });

  it("each have a name to show", () => {
    for (const h of PAYMENT_HEADS) expect(PAYMENT_HEAD_LABELS[h]?.trim()).toBeTruthy();
  });

  it("money is received into every head but Rider Cash and Meezan", () => {
    // Rider Cash fills only from a confirmed handover; Meezan only by a repayment
    // transfer. A head added later is receivable unless it is one of those two.
    expect([...RECEIVE_HEADS].sort()).toEqual(PAYMENT_HEADS.filter((h) => h !== "RIDER_CASH" && h !== OWNERS_HEAD).sort());
    expect(canReceiveInto("MEEZAN")).toBe(false);
    expect(canReceiveInto("RIDER_CASH")).toBe(false);
    expect(canReceiveInto("HBL")).toBe(true);
  });

  it("Meezan is the one head that is not money the farm holds", () => {
    expect(OWNERS_HEAD).toBe("MEEZAN");
    expect(PAYMENT_HEADS.filter((h) => !isHeldHead(h))).toEqual(["MEEZAN"]);
  });

  it("are all listed wherever the screens list them by hand", () => {
    // A file that names JazzCash or Easypaisa in code is listing the heads; it must
    // name Meezan as often. (HBL, Cash and Rider Cash are also used on their own —
    // owner funding, the rider box — so they are not a sign of a list.)
    const missing: string[] = [];
    for (const file of sourceFiles(path.resolve(__dirname, "../../src"))) {
      if (file.endsWith(path.join("lib", "payment-heads.ts"))) continue;
      const text = readFileSync(file, "utf8");
      const listed = Math.max(count(text, "JAZZCASH"), count(text, "EASYPAISA"));
      if (listed > 0 && count(text, "MEEZAN") < listed) missing.push(path.relative(process.cwd(), file));
    }
    expect(missing).toEqual([]);
  });
});

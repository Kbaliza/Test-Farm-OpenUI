// Customer Recovery (win-back) — the rules, in one place.
//
// Pure and framework-free so the page, the server actions and the tests all use
// the same statuses, the same reading of why someone left, and the same
// three-call no-answer sequence.

import { AUTO_DEACTIVATION_REASON } from "@/lib/deactivation-reasons";

/** The recovery workflow, in the order a case usually moves through it. */
export const RECOVERY_STATUSES = [
  "Not Contacted",
  "No Answer - 1st Call",
  "No Answer - 2nd Call",
  "No Answer - 3rd Call",
  "Call Back Later",
  "Interested",
  "Delivery Pending",
  "Follow-up Scheduled",
  "Recovered",
  "Not Interested",
] as const;
export type RecoveryStatus = (typeof RECOVERY_STATUSES)[number];

export const DEFAULT_STATUS: RecoveryStatus = "Not Contacted";

export function isRecoveryStatus(s: string): s is RecoveryStatus {
  return (RECOVERY_STATUSES as readonly string[]).includes(s);
}

/** Colour per status — for the tabs, the status selector and the timeline. */
export const STATUS_COLOR: Record<RecoveryStatus, string> = {
  "Not Contacted": "#4A4842",
  "No Answer - 1st Call": "#B5651D",
  "No Answer - 2nd Call": "#B23408",
  "No Answer - 3rd Call": "#8A1414",
  "Call Back Later": "#8A5008",
  Interested: "#0F5028",
  "Delivery Pending": "#1A3A9E",
  "Follow-up Scheduled": "#6321C7",
  Recovered: "#0F5028",
  "Not Interested": "#8A1414",
};

/** Being actively won back: reached and interested, asked to call back, or delivery pending. */
export const IN_PROGRESS: RecoveryStatus[] = ["Interested", "Call Back Later", "Delivery Pending"];

export const NO_ANSWER: RecoveryStatus[] = ["No Answer - 1st Call", "No Answer - 2nd Call", "No Answer - 3rd Call"];

/**
 * Where a "no answer" call moves the case: the 1st attempt from anything else,
 * then the 2nd, then the 3rd — and it stays at the 3rd however many more calls go
 * unanswered. `attempt` is the number to log against the call (1, 2 or 3).
 */
export function nextNoAnswer(current: string): { status: RecoveryStatus; attempt: 1 | 2 | 3 } {
  const i = NO_ANSWER.indexOf(current as RecoveryStatus);
  const next = i === -1 ? 0 : Math.min(i + 1, 2);
  return { status: NO_ANSWER[next], attempt: (next + 1) as 1 | 2 | 3 };
}

export type Potential = "high" | "medium" | "low";

/** Where the customer came onto the list. */
export type RecoverySource = "auto" | "manual" | "added";

export const SOURCE_LABEL: Record<RecoverySource, string> = {
  auto: "Auto-lapsed",
  manual: "Marked left",
  added: "Added for follow-up",
};

/**
 * Why someone left, read as how likely they are to come back.
 *
 *   high   — left for a while and said so, or simply stopped ordering: the
 *            likeliest to return
 *   medium — a complaint, a payment problem, or no reason at all: worth a call
 *   low    — moved away: unlikely, but not impossible
 *
 * A reason typed by hand that is not one of the fixed ones is "Other", medium.
 */
export function readReason(
  reason: string | null | undefined,
  source: RecoverySource,
): { category: string; potential: Potential } {
  if (source === "added") return { category: "Added for follow-up", potential: "medium" };
  const r = (reason ?? "").trim();
  if (r === AUTO_DEACTIVATION_REASON) return { category: "Auto-Lapsed", potential: "high" };
  switch (r) {
    case "Away Temporarily - Return Date Given":
    case "Stock Full - Short Break":
      return { category: "Temporarily Away", potential: "high" };
    case "Stopped - Poor Service":
    case "Stopped - Poor Milk Quality":
      return { category: "Service / Quality Issue", potential: "medium" };
    case "Defaulter":
    case "Recovery":
      return { category: "Payment / Rate Issue", potential: "medium" };
    case "Moving Out of City":
    case "Going Abroad - Return Unknown":
      return { category: "Likely Lost", potential: "low" };
    case "":
    case "No Reason Given":
      return { category: "No Reason Given", potential: "medium" };
  }
  return { category: "Other", potential: "medium" };
}

/** "1y 2m", "3mo", "12d" — how long since the last delivery. */
export function fmtInactive(days: number | null): string {
  if (days == null) return "—";
  if (days >= 365) return `${Math.floor(days / 365)}y ${Math.round((days % 365) / 30)}m`;
  if (days >= 30) return `${Math.floor(days / 30)}mo`;
  return `${days}d`;
}

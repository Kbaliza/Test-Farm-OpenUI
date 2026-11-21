// Every account money can sit in — the PaymentHead enum in prisma/schema.prisma,
// with the name each one goes by on screen. test/unit/payment-heads.test.ts keeps
// this list equal to the enum, and fails when a screen lists the heads without one
// of them, so a head added here cannot be missed anywhere.
//
// Plain data with no server imports, so client screens and server actions read
// the same list (lib/head-balances is server-only).

export const PAYMENT_HEADS = ["RIDER_CASH", "HBL", "MEEZAN", "JAZZCASH", "EASYPAISA", "CASH"] as const;

export type PaymentHeadName = (typeof PAYMENT_HEADS)[number];

export const PAYMENT_HEAD_LABELS: Record<PaymentHeadName, string> = {
  RIDER_CASH: "Rider Cash",
  HBL: "HBL",
  MEEZAN: "Meezan",
  JAZZCASH: "JazzCash",
  EASYPAISA: "Easypaisa",
  CASH: "Cash",
};

/**
 * Meezan is not money the farm holds. It is what Sajjad and Moiz have paid for
 * the farm out of their own pocket, as one shared account, so its balance runs in
 * minus: the amount the farm owes them back. It goes further into minus when
 * something is paid through it and when an owner puts money into HBL (an owner
 * contribution); it comes back up only when the farm repays them, by a transfer
 * into Meezan. Nothing is ever refused for want of funds in it, and it is never
 * added into the money the farm holds.
 */
export const OWNERS_HEAD: PaymentHeadName = "MEEZAN";

/** Money the farm actually holds — every head but Meezan. */
export const isHeldHead = (head: string) => head !== OWNERS_HEAD;

/**
 * Heads money may be received into from a desk screen (a customer, a counter
 * sale, a vendor refund, a sample). Not Rider Cash — it fills only from a rider's
 * confirmed handover — and not Meezan, which money enters only as a repayment to
 * the owners, by transfer.
 */
export const RECEIVE_HEADS = ["CASH", "HBL", "JAZZCASH", "EASYPAISA"] as const satisfies readonly PaymentHeadName[];

export type ReceiveHeadName = (typeof RECEIVE_HEADS)[number];

export const canReceiveInto = (head: string) => (RECEIVE_HEADS as readonly string[]).includes(head);

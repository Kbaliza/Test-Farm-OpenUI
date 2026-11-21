import "server-only";
import { db } from "@/lib/db";

// Best-effort per-customer notification for the customer app's feed. Never throws
// so it can't break the action that triggers it.
export async function createCustomerNotification(
  customerId: string,
  type: string,
  title: string,
  body: string
): Promise<void> {
  try {
    await db.customerNotification.create({ data: { customerId, type, title, body } });
  } catch (e) {
    console.error("[createCustomerNotification]", e);
  }
}

// Turning a database row into something a person can read.
//
// The log records `RouteStopItem.plannedQty 20 -> 25`. What the owner wants to
// read is "Route load — Planned qty 20 → 25". These maps do that for the tables
// and fields that come up; anything unmapped falls back to its own name, spaced
// out, so a table added next year still reads sensibly on the day it appears.
//
// Deliberately NOT a sentence generator for 77 tables. That is a great deal of
// code with a long tail of awkward phrasings, and "Route load — Ch Waqas —
// Planned qty 20 → 25" already answers the question.

/**
 * The actor filter's value for everything written without a signed-in user:
 * scripts, database triggers, the WhatsApp worker.
 *
 * It lives here rather than beside the query because a "use server" file may
 * only export async functions — a plain const in there fails the build.
 */
export const SYSTEM_ACTOR = "__system__";

/**
 * Rows the software writes by itself in bulk — a bill's lines are thrown away
 * and rebuilt every time the bill is opened, a round's stops every time the
 * sheet is saved. Hidden unless "routine" is asked for: thousands a week, and
 * every one of them hides a change a person actually made.
 */
export const ROUTINE_TABLES = ["InvoiceLine", "RouteStop", "RouteStopItem", "AppSetting", "WhatsappMessageLog", "CustomerNotification"] as const;

/** A bill edit that touches one of these was a person's doing; anything else on
 *  a bill is its totals being recomputed. */
export const INVOICE_REAL_FIELDS = ["discount", "status", "dueDate", "billSentAt", "callCount", "callNotes", "callNotesAt"] as const;

export const TABLE_LABELS: Record<string, string> = {
  AppSetting: "Setting",
  Area: "Area",
  AuditLog: "Audit entry",
  BottleAdjustment: "Bottle correction",
  BottleReturn: "Bottle return",
  BuffaloDilutionBatch: "Buffalo batch",
  Checklist: "Checklist",
  ChecklistItem: "Checklist item",
  ChecklistPenalty: "Checklist penalty",
  ExpenseCategory: "Expense category",
  ExpenseChit: "Expense chit",
  FarmDispatch: "Load to packaging",
  MixMilkBatch: "Mix milk batch",
  MonthlyBudget: "Budget",
  OtcPurchaseLine: "Counter purchase line",
  OtcSaleLine: "Counter sale line",
  OwnerContribution: "Owner's personal payment",
  RecoveryCase: "Recovery case",
  RetailReturnReview: "Retail handback",
  RetailReturnLine: "Retail handback line",
  RiderReturnLine: "Rider return line",
  RoutePlan: "Round plan",
  SampleFollowup: "Sample follow-up",
  SampleItem: "Sample item",
  WinbackActivity: "Recovery note",
  WinbackCase: "Recovery customer",
  YoghurtBatch: "Yoghurt batch",
  Attendance: "Attendance",
  Bonus: "Bonus",
  Customer: "Customer",
  CustomerComplaint: "Complaint",
  CustomerOrder: "Customer order",
  CustomerProduct: "Customer product",
  Deduction: "Deduction",
  DeliveryEntry: "Delivery",
  Employee: "Staff member",
  Expense: "Expense",
  FarmSale: "Farm sale",
  HeadTransfer: "Transfer between accounts",
  InventoryMovement: "Stock movement",
  Invoice: "Bill",
  InvoiceLine: "Bill line",
  LedgerEntry: "Ledger entry",
  OtcPurchase: "Counter purchase",
  OtcSale: "Counter sale",
  Payment: "Payment",
  Product: "Product",
  ProductionLog: "Production entry",
  RetailDispatch: "Send to Retail",
  RetailPlacement: "Mart drop",
  RetailStockEntry: "Retail stock entry",
  Rider: "Rider",
  RiderExtraItem: "Spare stock",
  RiderReturnReview: "Rider return",
  Route: "Round",
  RouteStop: "Round stop",
  RouteStopItem: "Round load",
  SalaryPayment: "Salary payment",
  SampleLead: "Sample",
  Shift: "Shift",
  User: "Login",
  Vendor: "Vendor",
  VendorBill: "Vendor bill",
  VendorReceivable: "Vendor receivable",
};

export const FIELD_LABELS: Record<string, string> = {
  acceptedAt: "Accepted at",
  areaId: "Area",
  assigneeId: "Assigned to",
  autoClosedAt: "Closed by the day-end",
  billSentAt: "Bill sent",
  bottlesSince: "On bottles since",
  categoryId: "Category",
  checklistId: "Checklist",
  chitReceived: "Chit received",
  confirmedAt: "Accepted at",
  confirmedById: "Accepted by",
  customerCode: "Code",
  customerId: "Customer",
  deactivationReason: "Why deactivated",
  declaredItems: "Sent",
  deliveriesAmt: "Deliveries",
  deliveryCharge: "Delivery charge",
  deliverySequence: "Delivery order",
  description: "Description",
  employeeId: "Staff member",
  enteredById: "Entered by",
  fromHead: "From account",
  invoiceId: "Bill",
  invoiceNo: "Invoice no.",
  isReplacement: "Free replacement",
  isReturn: "Return",
  item: "Item",
  joinedAt: "Joined",
  leftAt: "Left",
  missingQty: "Missing",
  narration: "Note",
  notes: "Note",
  paymentsAmt: "Payments",
  prevBalance: "Previous balance",
  productId: "Product",
  ratePerUnit: "Rate",
  reason: "Reason",
  receivedItems: "Received",
  resolution: "What we gave",
  reviewedById: "Reviewed by",
  riderId: "Rider",
  routeId: "Round",
  routeStopId: "Round stop",
  sampleLeadId: "Sample",
  shiftId: "Shift",
  startedAt: "Started",
  completedAt: "Completed",
  stopNumber: "Stop no.",
  toHead: "To account",
  totalDue: "Total due",
  userId: "Login",
  vendorId: "Vendor",
  waivedAt: "Waived",
  weekdays: "Days",
  actualQty: "Actual qty",
  amount: "Amount",
  baseSalary: "Salary",
  cashCollected: "Cash collected",
  defaultRate: "Rate",
  deliveredAt: "Delivered at",
  dailyWage: "Daily wage",
  givenQty: "Given",
  handedOverAt: "Handed over",
  head: "Account",
  notDeliveredReason: "Reason",
  openingBalance: "Opening balance",
  paidAmount: "Paid",
  paymentMethod: "Paid by",
  plannedQty: "Planned qty",
  quantity: "Quantity",
  receivedAt: "Received",
  returnedQty: "Returned",
  riderOutcome: "Rider said",
  skipReason: "Reason",
  status: "Status",
  stockQty: "To stock",
  totalAmount: "Total",
  unitRate: "Rate",
  wasteQty: "Wasted",
  wasteReason: "Waste reason",
};

const OPERATION_LABELS: Record<string, string> = {
  INSERT: "Added",
  UPDATE: "Edited",
  DELETE: "Deleted",
};

/** "plannedQty" → "Planned qty"; an unmapped name still reads as words. */
export function fieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function tableLabel(table: string): string {
  if (TABLE_LABELS[table]) return TABLE_LABELS[table];
  const spaced = table.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function operationLabel(op: string): string {
  return OPERATION_LABELS[op] ?? op;
}

/** How a stored value reads on the page. Dates shorten, nothing shows as "null". */
export function valueText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    // An ISO timestamp is noise at full length; the day and time are the point.
    const m = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    if (m) return `${m[1]} ${m[2]}`;
    return v;
  }
  return JSON.stringify(v);
}

import {
  LayoutDashboard,
  Users,
  Boxes,
  ReceiptText,
  Wallet,
  BookOpen,
  Bell,
  StickyNote,
  MessageSquareWarning,
  CalendarCheck,
  CalendarDays,
  IdCard,
  ListChecks,
  ClipboardCheck,
  ShieldCheck,
  ScrollText,
  Store,
  ShoppingBag,
  BarChart3,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  title: string;
  href?: string;
  icon?: LucideIcon;
  children?: NavItem[];
};

export const navItems: NavItem[] = [
  {
    title: "Dashboard",
    href: "/",
    icon: LayoutDashboard,
  },
  {
    title: "Reports",
    icon: BarChart3,
    children: [
      { title: "Reports Overview", href: "/reports" },
      { title: "Summary Report", href: "/reports/summary" },
    ],
  },
  {
    title: "Customers",
    icon: Users,
    children: [
      { title: "Add Customer", href: "/customers/new" },
      { title: "View Customers", href: "/customers" },
      { title: "Areas / Shifts", href: "/customers/areas" },
      { title: "Riders", href: "/customers/riders" },
      { title: "Rider Report", href: "/customers/rider-report" },
      { title: "Rider Sale Summary", href: "/customers/rider-sale-summary" },
      { title: "Customer Recovery", href: "/customers/recovery" },
      { title: "Bottles", href: "/customers/bottles" },
      { title: "Riders live", href: "/customers/riders-live" },
      { title: "Samples", href: "/samples" },
    ],
  },
  {
    title: "Over the Counter",
    icon: Store,
    children: [
      { title: "Sale", href: "/over-the-counter/sale" },
      { title: "Purchase", href: "/over-the-counter/purchase" },
      { title: "Farm Sales", href: "/over-the-counter/farm-sales" },
    ],
  },
  // Shops that take product on consignment. Deliberately its own top-level entry,
  // not a child of Inventory: /inventory/retail already exists and means the
  // packaging-to-retail dispatch leg, which is a different thing entirely.
  {
    title: "Retail Marts",
    icon: ShoppingBag,
    children: [
      { title: "Marts & Drops", href: "/retail" },
      { title: "Retail Inventory", href: "/retail/inventory" },
    ],
  },
  {
    title: "Shift Editor",
    href: "/customers/pre-delivery",
    icon: CalendarDays,
  },
  {
    title: "Inventory",
    icon: Boxes,
    children: [
      { title: "Inventory Summary", href: "/inventory" },
      { title: "Flow Log", href: "/inventory/flow-log" },
      { title: "Production Reconciliation", href: "/inventory/reconciliation" },
      { title: "Production / Milk Entry", href: "/inventory/production" },
      { title: "Packaging", href: "/inventory/farm-arrival" },
      { title: "Retail", href: "/inventory/retail" },
      { title: "Rider Item Returns", href: "/inventory/rider-returns" },
      { title: "Wastage log", href: "/inventory/wastage" },
      { title: "Missing log", href: "/inventory/missing" },
      { title: "Yogurt", href: "/inventory/yoghurt" },
      { title: "Products", href: "/inventory/products" },
      { title: "Waste entry", href: "/inventory/waste-entry" },
    ],
  },
  {
    title: "Billing",
    icon: ReceiptText,
    children: [
      { title: "Customer Bills", href: "/billing/invoices" },
      { title: "Payment Receiving", href: "/billing/payment-receiving" },
    ],
  },
  {
    title: "Payments",
    icon: Wallet,
    children: [
      { title: "Daily Expenses", href: "/payments/expenses" },
      { title: "Monthly Expenses", href: "/payments/monthly-expenses" },
      { title: "Budgets", href: "/payments/budgets" },
      { title: "Vendors", href: "/payments/vendors" },
      { title: "Move Funds Between Heads", href: "/payments/transfers" },
      { title: "Rider Cash", href: "/payments/rider-cash" },
      { title: "Payment Proofs", href: "/payments/payment-proofs" },
      { title: "Recovery / Milk Stop", href: "/payments/recovery" },
      { title: "Salaries", href: "/payments/salaries" },
    ],
  },
  {
    title: "Attendance",
    href: "/attendance",
    icon: CalendarCheck,
  },
  {
    title: "Task Management",
    href: "/tasks",
    icon: ListChecks,
  },
  {
    title: "Daily Checklists",
    href: "/checklists",
    icon: ClipboardCheck,
  },
  {
    title: "Ledgers",
    href: "/ledgers",
    icon: BookOpen,
  },
  {
    title: "Alerts",
    href: "/alerts",
    icon: Bell,
  },
  {
    title: "Daily Notes",
    href: "/daily-notes",
    icon: StickyNote,
  },
  {
    title: "Complaints",
    href: "/complaints",
    icon: MessageSquareWarning,
  },
  {
    // Admin/Manager only — enforced by canAccess() + the requireRole() guards
    // in the users and staff actions, not by hiding these items.
    title: "Users",
    icon: ShieldCheck,
    children: [
      { title: "Logins", href: "/users" },
      { title: "Staff", href: "/staff", icon: IdCard },
    ],
  },
  {
    // Admins and managers. The sidebar hides it from everyone else because
    // visibleFor() asks canAccess(), which holds /audit-log in RESTRICTED_ROUTES
    // — and the page and its action ask again, because a server action is
    // reachable whether or not a menu item was ever drawn.
    title: "Audit Log",
    href: "/audit-log",
    icon: ScrollText,
  },
];

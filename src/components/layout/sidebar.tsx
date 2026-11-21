"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { navItems, type NavItem } from "@/lib/nav";
import { canAccess } from "@/lib/access";
import { Input } from "@/components/ui/input";
import type { Role } from "@prisma/client";

// Keep only what this role can actually open. A parent (e.g. "Inventory") survives
// only if at least one of its children does. This is cosmetic — the real gate is
// the dashboard layout + the requireRole() guards inside each server action.
function visibleFor(role: Role): NavItem[] {
  return navItems
    .map((item) => {
      if (item.children) {
        const kids = item.children.filter((c) => c.href && canAccess(role, c.href));
        return kids.length ? { ...item, children: kids } : null;
      }
      return item.href && canAccess(role, item.href) ? item : null;
    })
    .filter(Boolean) as NavItem[];
}

function isActive(pathname: string, item: NavItem, exact = false): boolean {
  if (item.href) {
    if (item.href === "/") return pathname === "/";
    if (exact) return pathname === item.href;
    return pathname === item.href || pathname.startsWith(item.href + "/");
  }
  return item.children?.some((c) => isActive(pathname, c)) ?? false;
}

function SidebarItem({
  item,
  onNavigate,
}: {
  item: NavItem;
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  const active = isActive(pathname, item);
  const [open, setOpen] = useState(active);

  const Icon = item.icon;

  if (item.children) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors",
            active
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
          )}
        >
          <span className="flex items-center gap-3">
            {Icon ? <Icon className="size-4" /> : null}
            {item.title}
          </span>
          <ChevronDown
            className={cn("size-4 transition-transform", open && "rotate-180")}
          />
        </button>
        {open ? (
          <div className="mt-1 space-y-0.5 pl-9">
            {item.children.map((child) => (
              <Link
                key={child.title}
                href={child.href ?? "#"}
                onClick={onNavigate}
                className={cn(
                  "block rounded-lg px-3 py-1.5 text-sm transition-colors",
                  isActive(pathname, child, true)
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground"
                )}
              >
                {child.title}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Link
      href={item.href ?? "#"}
      onClick={onNavigate}
      className={cn(
        "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-sidebar-primary text-sidebar-primary-foreground before:absolute before:top-1/2 before:left-0 before:h-5 before:w-1 before:-translate-y-1/2 before:rounded-r-full before:bg-brand"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
      )}
    >
      {Icon ? <Icon className="size-4" /> : null}
      {item.title}
    </Link>
  );
}

export function Sidebar({
  className,
  role,
  mobileOpen = false,
  collapsed = false,
  onClose,
}: {
  className?: string;
  role: Role;
  mobileOpen?: boolean;
  /** Folded away on a computer. The drawer on a phone ignores it. */
  collapsed?: boolean;
  onClose?: () => void;
}) {
  const [query, setQuery] = useState("");

  const allowed = useMemo(() => visibleFor(role), [role]);

  const filtered = useMemo(() => {
    if (!query.trim()) return allowed;
    const q = query.toLowerCase();
    return allowed
      .map((item) => {
        if (item.title.toLowerCase().includes(q)) return item;
        if (item.children) {
          const kids = item.children.filter((c) =>
            c.title.toLowerCase().includes(q)
          );
          if (kids.length) return { ...item, children: kids };
        }
        return null;
      })
      .filter(Boolean) as NavItem[];
  }, [query, allowed]);

  return (
    <aside
      className={cn(
        // Phone: a drawer that slides in from the left.
        "fixed inset-y-0 left-0 z-50 flex app-height w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground",
        "border-r border-sidebar-border transition-transform duration-300",
        // Computer: part of the layout, and it folds to nothing when hidden. Only
        // the width animates, and the panel inside keeps its own width, so the
        // menu slides away instead of the text reflowing on the way.
        "lg:relative lg:translate-x-0 lg:overflow-hidden lg:transition-[width] lg:duration-300 lg:motion-reduce:transition-none",
        collapsed ? "lg:w-0 lg:border-r-0" : "lg:w-64",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
        className
      )}
      // Nothing inside is reachable by keyboard or a screen reader while it is
      // folded. The phone's drawer is exempt: it carries the same cookie, and a
      // menu you have just opened must never be dead to the touch.
      inert={collapsed && !mobileOpen ? true : undefined}
    >
      <div className="flex h-full w-64 shrink-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-sidebar-border px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="size-9 shrink-0 overflow-hidden rounded-full ring-1 ring-white/15">
            <Image
              src="/banoori%20dairy%20logo.png"
              alt="Banoori Dairy"
              width={36}
              height={36}
              priority
              className="size-full object-cover"
            />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-tight">Dairy Suite</p>
            <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] font-medium tracking-[0.12em] text-sidebar-foreground/60 uppercase">
              <span className="size-1.5 rounded-full bg-brand" />
              Online
            </p>
          </div>
        </div>
        {/* Close button — mobile only */}
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground lg:hidden"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="px-3 pt-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-sidebar-foreground/50" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search menu..."
            className="border-sidebar-border bg-sidebar-accent/40 pl-8 text-sidebar-foreground placeholder:text-sidebar-foreground/50 focus-visible:border-sidebar-ring focus-visible:ring-sidebar-ring/40"
          />
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
        {filtered.map((item) => (
          <SidebarItem
            key={item.title}
            item={item}
            onNavigate={() => onClose?.()}
          />
        ))}
      </nav>

      <div className="border-t border-sidebar-border px-4 py-3 font-mono text-[10px] tracking-[0.1em] text-sidebar-foreground/50">
        v0.1 · Phase 1
      </div>
      </div>
    </aside>
  );
}

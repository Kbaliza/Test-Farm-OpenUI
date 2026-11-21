"use client";

import { useState } from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import type { SessionUser } from "@/lib/auth";

/** How long the menu stays hidden for: a year, on this browser. */
const COLLAPSE_COOKIE = "sb_collapsed";

export function DashboardShell({
  children,
  user,
  initialCollapsed = false,
}: {
  children: React.ReactNode;
  user: SessionUser;
  /** Read from the cookie on the server, so the first paint is already right —
   *  the menu never flashes open and then shuts. */
  initialCollapsed?: boolean;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  // On a phone the button opens the drawer; on a computer it hides the menu.
  function toggleMenu() {
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      setSidebarOpen((o) => !o);
      return;
    }
    setCollapsed((c) => {
      const next = !c;
      if (typeof document !== "undefined") {
        document.cookie = `${COLLAPSE_COOKIE}=${next ? "1" : "0"}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
      }
      return next;
    });
  }

  return (
    <div className="flex app-height overflow-hidden bg-background">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar role={user.role} mobileOpen={sidebarOpen} collapsed={collapsed} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar user={user} onMenuToggle={toggleMenu} menuHidden={collapsed} />
        {/* min-h-0 lets this flex child actually shrink so its own scrollbar works;
            overscroll-contain stops the scroll from chaining to the body (rubber-band);
            the safe-area pad keeps the last row clear of the phone's home indicator. */}
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
          {children}
        </main>
      </div>
    </div>
  );
}

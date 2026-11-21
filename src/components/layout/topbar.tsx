"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Bell, CalendarDays, ChevronDown, Menu, PanelLeftClose, PanelLeftOpen, ClipboardCheck, RefreshCw, LogOut,
  Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudDrizzle, Cloudy, AlertTriangle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { canAccess, ROLE_LABELS } from "@/lib/access";
import { signOut } from "@/app/login/actions";
import type { SessionUser } from "@/lib/auth";
import { getTodayAttendanceSummary } from "@/app/(dashboard)/attendance/actions";
import { getOverdueTaskCount } from "@/app/(dashboard)/tasks/actions";
import { getAlertCount } from "@/app/(dashboard)/alerts/actions";

// ── Clock ─────────────────────────────────────────────────────────────────────

function pktParts() {
  const now = new Date();
  const tz = { timeZone: "Asia/Karachi" };
  return {
    date: now.toLocaleDateString("en-GB", { ...tz, weekday: "short", day: "2-digit", month: "short" }),
    time: now.toLocaleTimeString("en-GB", { ...tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
  };
}

// ── Weather helpers ───────────────────────────────────────────────────────────

// WMO weather code → Lucide icon
function WeatherIcon({ code, className }: { code: number; className?: string }) {
  const cls = cn("shrink-0", className);
  if (code === 0)         return <Sun className={cn(cls, "text-amber-500")} />;
  if (code <= 2)          return <Sun className={cn(cls, "text-amber-400")} />;
  if (code <= 3)          return <Cloudy className={cn(cls, "text-slate-400")} />;
  if (code <= 48)         return <Cloud className={cn(cls, "text-slate-400")} />;
  if (code <= 55)         return <CloudDrizzle className={cn(cls, "text-blue-400")} />;
  if (code <= 67)         return <CloudRain className={cn(cls, "text-blue-500")} />;
  if (code <= 77)         return <CloudSnow className={cn(cls, "text-sky-300")} />;
  if (code <= 82)         return <CloudRain className={cn(cls, "text-blue-500")} />;
  if (code <= 99)         return <CloudLightning className={cn(cls, "text-amber-600")} />;
  return <Sun className={cn(cls, "text-amber-500")} />;
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type WeatherDay  = { date: string; max: number; min: number; code: number };
type WeatherData = { currentTemp: number; currentCode: number; days: WeatherDay[] };

// Rawalpindi — matches the shift/area geography in this app
const ISB_LAT = 33.5651;
const ISB_LON = 73.0169;

async function fetchWeather(): Promise<WeatherData | null> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${ISB_LAT}&longitude=${ISB_LON}` +
      `&current=temperature_2m,weather_code` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
      `&timezone=Asia%2FKarachi&forecast_days=7`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const d = await res.json();
    return {
      currentTemp: Math.round(d.current.temperature_2m),
      currentCode: d.current.weather_code,
      days: (d.daily.time as string[]).map((date, i) => ({
        date,
        max:  Math.round(d.daily.temperature_2m_max[i]),
        min:  Math.round(d.daily.temperature_2m_min[i]),
        code: d.daily.weather_code[i],
      })),
    };
  } catch {
    return null;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function Topbar({
  user,
  onMenuToggle,
  menuHidden = false,
}: {
  user: SessionUser;
  onMenuToggle?: () => void;
  /** True while the menu is folded away (computer only) — flips the icon. */
  menuHidden?: boolean;
}) {
  // A limited role (Doctor / Packaging / Van Driver) can't open these screens, so
  // don't show the widgets — and don't call their (now role-guarded) actions.
  const showAttendance = canAccess(user.role, "/attendance");
  const showAlerts     = canAccess(user.role, "/alerts");
  const showTasks      = canAccess(user.role, "/tasks");

  const [clock,   setClock]   = useState<{ date: string; time: string }>({ date: "", time: "" });
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [attendance, setAttendance] = useState<{ present: number; marked: number; total: number } | null>(null);
  const [tasks, setTasks] = useState<{ overdue: number; dueToday: number } | null>(null);
  const [alertCount, setAlertCount] = useState(0);
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  // Re-fetch the current page's server data + the topbar widgets.
  function handleRefresh() {
    setRefreshing(true);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("attendance:changed"));
      window.dispatchEvent(new Event("tasks:changed"));
      // Re-fetch data held in client components that don't come from Server
      // Components (OTC history, the open ledger, …) — router.refresh() alone
      // only re-runs Server Components and leaves that client state stale.
      window.dispatchEvent(new Event("app:refresh"));
    }
    router.refresh();
    setTimeout(() => setRefreshing(false), 700);
  }

  // Live clock — ticks every second
  useEffect(() => {
    function tick() { setClock(pktParts()); }
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, []);

  // Weather — fetch on mount, refresh every 30 min
  useEffect(() => {
    fetchWeather().then(setWeather);
    const id = setInterval(() => fetchWeather().then(setWeather), 30 * 60_000);
    return () => clearInterval(id);
  }, []);

  // Today's attendance summary — fetch on mount, on "attendance:changed"
  // events (fired when marks are saved), and refreshed every 5 min.
  useEffect(() => {
    if (!showAttendance) return;
    const refresh = () => getTodayAttendanceSummary().then(setAttendance).catch(() => {});
    refresh();
    const id = setInterval(refresh, 5 * 60_000);
    window.addEventListener("attendance:changed", refresh);
    return () => {
      clearInterval(id);
      window.removeEventListener("attendance:changed", refresh);
    };
  }, [showAttendance]);

  // Overdue tasks — drives the bell badge. Refresh on mount, every 5 min, and
  // when a task changes elsewhere ("tasks:changed").
  useEffect(() => {
    if (!showTasks) return;
    const refresh = () => getOverdueTaskCount().then(setTasks).catch(() => {});
    refresh();
    const id = setInterval(refresh, 5 * 60_000);
    window.addEventListener("tasks:changed", refresh);
    return () => {
      clearInterval(id);
      window.removeEventListener("tasks:changed", refresh);
    };
  }, [showTasks]);

  // Alert count — refresh on mount and every 5 min.
  useEffect(() => {
    if (!showAlerts) return;
    const refresh = () => getAlertCount().then(setAlertCount).catch(() => {});
    refresh();
    const id = setInterval(refresh, 5 * 60_000);
    return () => clearInterval(id);
  }, [showAlerts]);

  // Today's index so we can label today as "Today"
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" }); // YYYY-MM-DD

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur sm:h-16 sm:px-6">

      {/* The menu button: opens the drawer on a phone, folds the menu away on a
          computer. One button, so there is only ever one thing to press. */}
      <button
        onClick={onMenuToggle}
        className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={menuHidden ? "Show menu" : "Hide menu"}
        aria-expanded={!menuHidden}
        title={menuHidden ? "Show menu" : "Hide menu"}
      >
        <Menu className="size-5 lg:hidden" />
        {menuHidden
          ? <PanelLeftOpen className="hidden size-5 lg:block" />
          : <PanelLeftClose className="hidden size-5 lg:block" />}
      </button>

      {/* ── Date + live clock ── */}
      <div className="hidden sm:flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm">
        <CalendarDays className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground">{clock.date}</span>
        {clock.time && (
          <span className="border-l border-border pl-2 font-mono font-medium tabular-nums tracking-tight">
            {clock.time}
          </span>
        )}
      </div>

      {/* ── Weather widget ── */}
      {weather && (
        <div className="hidden md:flex items-stretch gap-0 rounded-md border border-border bg-card text-sm overflow-hidden">

          {/* Current conditions */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-r border-border">
            <WeatherIcon code={weather.currentCode} className="size-4" />
            <span className="font-semibold tabular-nums">{weather.currentTemp}°C</span>
            <span className="text-[10px] text-muted-foreground font-medium">RWP</span>
          </div>

          {/* 7-day forecast strip */}
          <div className="flex items-center gap-0.5 px-2">
            {weather.days.slice(0, 7).map((d) => {
              const dow   = new Date(d.date + "T12:00:00").getDay();
              const label = d.date === todayStr ? "Now" : DAY_SHORT[dow];
              const isToday = d.date === todayStr;
              return (
                <div
                  key={d.date}
                  title={`${label}: ${d.max}°/${d.min}°C`}
                  className={cn(
                    "flex flex-col items-center gap-0.5 px-1.5 py-1 rounded-md transition-colors",
                    isToday && "bg-primary/8"
                  )}
                >
                  <span className={cn(
                    "text-[9px] leading-none font-medium",
                    isToday ? "text-primary" : "text-muted-foreground"
                  )}>
                    {label}
                  </span>
                  <WeatherIcon code={d.code} className="size-3.5" />
                  <span className={cn(
                    "text-[9px] leading-none tabular-nums font-medium",
                    isToday ? "text-foreground" : "text-muted-foreground"
                  )}>
                    {d.max}°
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* ── Right side ── */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Refresh — reloads page data and the topbar widgets */}
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh data"
          aria-label="Refresh data"
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm transition-colors hover:bg-muted disabled:opacity-60"
        >
          <RefreshCw className={cn("size-4 shrink-0 text-primary", refreshing && "animate-spin")} />
          <span className="hidden text-muted-foreground sm:inline">Refresh</span>
        </button>

        {/* Attendance quick-access */}
        {showAttendance && (
        <Link
          href="/attendance"
          title={
            attendance
              ? `${attendance.present} present · ${attendance.marked}/${attendance.total} marked today`
              : "Mark attendance"
          }
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm transition-colors hover:bg-muted"
        >
          <ClipboardCheck className="size-4 shrink-0 text-primary" />
          <span className="hidden text-muted-foreground sm:inline">Attendance</span>
          {attendance ? (
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
                attendance.marked >= attendance.total && attendance.total > 0
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-primary/10 text-primary"
              )}
            >
              {attendance.present}/{attendance.total}
            </span>
          ) : null}
        </Link>
        )}

        {/* Alerts — links to /alerts, shows active alert count */}
        {showAlerts && (
        <Link
          href="/alerts"
          title={alertCount > 0 ? `${alertCount} active alert${alertCount !== 1 ? "s" : ""}` : "Alerts"}
          className="relative inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <AlertTriangle className="size-5" />
          {alertCount > 0 ? (
            <Badge className="absolute -right-1 -top-1 size-4 rounded-full bg-amber-500 p-0 text-[10px]">
              {alertCount > 9 ? "9+" : alertCount}
            </Badge>
          ) : null}
        </Link>
        )}

        {showTasks && (
        <Link
          href="/tasks"
          title={
            tasks
              ? `${tasks.overdue} missed · ${tasks.dueToday} due today`
              : "Tasks"
          }
          className="relative inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Bell className="size-5" />
          {tasks && tasks.overdue > 0 ? (
            <Badge className="absolute -right-1 -top-1 size-4 rounded-full bg-rose-600 p-0 text-[10px]">
              {tasks.overdue > 9 ? "9+" : tasks.overdue}
            </Badge>
          ) : null}
        </Link>
        )}

        {/* Signed-in user + sign out */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 text-left transition-colors hover:bg-muted sm:gap-2"
            >
              <div className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold uppercase text-primary-foreground">
                {user.name.trim().charAt(0) || "?"}
              </div>
              <div className="hidden text-sm leading-tight sm:block">
                <p className="max-w-[9rem] truncate font-medium">{user.name}</p>
                <p className="text-xs text-muted-foreground">{ROLE_LABELS[user.role] ?? user.role}</p>
              </div>
              <ChevronDown className="size-4 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-0">
            <div className="border-b border-border px-3 py-2.5">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              <p className="mt-1 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                {ROLE_LABELS[user.role] ?? user.role}
              </p>
            </div>
            <form action={signOut}>
              <button
                type="submit"
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-rose-600 transition-colors hover:bg-rose-50"
              >
                <LogOut className="size-4" /> Sign out
              </button>
            </form>
          </PopoverContent>
        </Popover>
      </div>

    </header>
  );
}

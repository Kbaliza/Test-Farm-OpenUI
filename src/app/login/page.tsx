"use client";

import { Suspense, useActionState, useEffect } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn, type LoginState } from "./actions";

export const dynamic = "force-dynamic";

function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next") ?? "";

  const initial: LoginState = {
    error: params.get("error") === "no_access"
      ? "This account cannot access the admin app."
      : null,
  };

  const [state, formAction, pending] = useActionState(signIn, initial);

  // Signed in — the session cookie is already set by the action. Do a FULL
  // document navigation rather than a client-side transition: a soft transition
  // keeps this page (and its spinner) mounted while the heavy dashboard's RSC
  // payload and client chunks load, which reads as a hang. A real page load paints
  // the server-rendered dashboard straight away — what a manual refresh does.
  const leaving = !!state.redirectTo;

  useEffect(() => {
    if (state.redirectTo) window.location.replace(state.redirectTo);
  }, [state.redirectTo]);

  const busy = pending || leaving;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="grid size-14 place-items-center overflow-hidden rounded-xl ring-1 ring-border">
            <Image
              src="/login-logo.png"
              alt="Banoori Dairy"
              width={56}
              height={56}
              priority
              className="size-full object-cover"
            />
          </span>
          <h1 className="mt-3 text-lg font-semibold">Banoori Dairy</h1>
          <p className="text-sm text-muted-foreground">Sign in to continue</p>
        </div>

        {state.error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{state.error}</span>
          </div>
        )}

        <form action={formAction} className="space-y-3">
          <input type="hidden" name="next" value={next} />
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              placeholder="you@example.com"
              required
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              required
              className="mt-1"
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                {leaving ? "Loading your dashboard…" : "Signing in…"}
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </form>

        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          Trouble signing in? Ask an admin to reset your password.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

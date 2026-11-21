"use client";

import { useEffect } from "react";

// iOS Safari sizes 100vh — and, in practice, even 100dvh — to the *tall* viewport
// that sits behind the address/tool bars, which pushed the bottom of the app's
// internal scroll area off-screen (a hard scroll revealed a sliver, then it
// rubber-banded back). window.innerHeight is the one value iOS reports as the
// real visible height, so we pin it into --app-height and the shell reads that.
// An inline script in the root layout sets it before first paint (no flash); this
// keeps it in sync as the toolbars/orientation change.
export function AppHeight() {
  useEffect(() => {
    const root = document.documentElement;
    // Read innerHeight (stable when the keyboard opens on iOS), not visualViewport,
    // so a focused input doesn't squash the whole app.
    const set = () => root.style.setProperty("--app-height", `${window.innerHeight}px`);
    set();
    window.addEventListener("resize", set);
    window.addEventListener("orientationchange", set);
    window.visualViewport?.addEventListener("resize", set);
    return () => {
      window.removeEventListener("resize", set);
      window.removeEventListener("orientationchange", set);
      window.visualViewport?.removeEventListener("resize", set);
    };
  }, []);
  return null;
}

"use client";

import { useEffect } from "react";

// Opens the browser print dialog once the document (and its logo) have settled.
// Used by the chrome-free print route so the full invoice paginates cleanly.
export function AutoPrint() {
  useEffect(() => {
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, []);
  return null;
}

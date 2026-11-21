// Pure WhatsApp helpers — NO whatsapp-web.js / puppeteer imports here.
// Safe to import from both the Next app (server actions) and the worker.

// Normalize a Pakistani phone number to bare international digits.
//   "0332-5862900"   -> "923325862900"
//   "+92 332 5862900" -> "923325862900"
//   "3325862900"      -> "923325862900"
// Returns null if there aren't enough digits to be a real number.
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, ""); // keep digits only

  if (!d) return null;
  if (d.startsWith("0092")) d = d.slice(4);
  else if (d.startsWith("92")) d = d.slice(2);
  else if (d.startsWith("0")) d = d.slice(1);

  // Pakistani mobile/landline national numbers are ~10 digits (e.g. 3325862900).
  if (d.length < 9 || d.length > 11) return null;
  return "92" + d;
}

// whatsapp-web.js individual chat id format.
export function toChatId(normalized: string): string {
  return `${normalized}@c.us`;
}

// Fill {{placeholders}} in a template body. Unknown placeholders are left as-is.
export function renderTemplate(body: string, vars: Record<string, string | number>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) =>
    key in vars ? String(vars[key]) : m
  );
}

// Placeholders advertised in the UI; used for the preview and docs.
export const TEMPLATE_PLACEHOLDERS = [
  { key: "name", sample: "Ali Siraj" },
  { key: "amount", sample: "4,970" },
  { key: "dueDate", sample: "5th" },
  { key: "customerCode", sample: "C-0001" },
];

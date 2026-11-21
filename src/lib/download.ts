// Saving a file the server has already named.
//
// The name is taken from the response rather than rebuilt in the browser: the
// server decided it, and a second copy of that logic here would be free to
// disagree with what the zip's own entries are called.

/**
 * Pull the filename out of a Content-Disposition header.
 *
 * `filename*=UTF-8''...` wins when present — that is the one that survives the
 * spaces, brackets and dashes in "Raja Asim Shahzad (C-1892) — 16–30 Sep 2026.pdf".
 * The quoted `filename` is the ASCII fallback for anything that cannot read it.
 */
export function fileNameFrom(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // A malformed header should not cost the download.
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
  return plain ? plain[1].trim() : null;
}

/** Hand a blob to the browser as a download, then let go of the object URL. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  // Firefox needs the anchor in the document for a programmatic click to count.
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next turn: Safari reads the URL after click() returns, and
  // revoking immediately gives an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * What went wrong, in words, whatever the server managed to send.
 *
 * A route handler that throws before it can build a response gives a 500 with an
 * HTML or empty body. Reading it as JSON fails, and the caller is left showing a
 * generic sentence — which is how a missing browser on the server and an expired
 * session look identical to the person clicking the button. This reads the body
 * whichever way it comes and falls back to naming the status, so a failure can be
 * reported rather than guessed at.
 */
export async function describeFailure(res: Response): Promise<string | null> {
  const body = await res.text().catch(() => "");
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
    } catch {
      // Not JSON. An HTML error page is noise, but a short plain-text body is not.
      const text = body.trim();
      if (text && text.length < 200 && !text.startsWith("<")) return text;
    }
  }
  return res.status === 504 || res.status === 502
    ? `The server took too long (${res.status}). Try one shift at a time.`
    : `The server refused the download (${res.status} ${res.statusText || "error"}).`;
}

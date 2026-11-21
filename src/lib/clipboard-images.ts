// Getting chit photos off the clipboard, so a screenshot or an image copied from
// WhatsApp Web can go straight onto an expense without saving it to a file first.
//
// Two ways in, because browsers differ:
//   • Ctrl+V / ⌘V — the paste event carries the image. Works in every browser.
//   • A "Paste" button — reads the clipboard through navigator.clipboard.read().
//     Chrome and Edge allow it (they may ask once); Safari and older Firefox may
//     not, and then we say to press Ctrl+V instead.
//
// Only images are taken; the caller still checks the type and the 10 MB cap the
// same as for a picked file.

import { useEffect, useRef } from "react";

/** A pasted image arrives as "image.png" every time; give each its own name. */
function named(blob: Blob, n: number): File {
  const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return new File([blob], `pasted-${stamp}${n ? `-${n + 1}` : ""}.${ext}`, { type: blob.type });
}

/** The images in a paste event, or [] when it is ordinary text. */
export function imagesFromPaste(e: ClipboardEvent): File[] {
  const items = Array.from(e.clipboardData?.items ?? []);
  const blobs = items
    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f);
  return blobs.map((b, i) => named(b, i));
}

/** Reads images from the clipboard on a button press. Throws a message fit to show. */
export async function readClipboardImages(): Promise<File[]> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.read) {
    throw new Error("This browser can't paste from a button — click the page and press Ctrl+V instead.");
  }
  let items: ClipboardItems;
  try {
    items = await navigator.clipboard.read();
  } catch {
    throw new Error("The browser didn't allow reading the clipboard — press Ctrl+V instead.");
  }
  const blobs: Blob[] = [];
  for (const it of items) {
    const type = it.types.find((t) => t.startsWith("image/"));
    if (type) blobs.push(await it.getType(type));
  }
  if (!blobs.length) throw new Error("There's no image on the clipboard. Copy the chit photo first.");
  return blobs.map((b, i) => named(b, i));
}

/**
 * While `enabled`, any Ctrl+V of an image on the page hands the images to
 * `onImages`. A paste of plain text is left alone, so typing into the form still
 * works. With `skipWhenDialogOpen`, a paste is left to the open dialog instead.
 */
export function usePastedImages(enabled: boolean, onImages: (files: File[]) => void, skipWhenDialogOpen = false) {
  const cb = useRef(onImages);
  useEffect(() => { cb.current = onImages; });
  useEffect(() => {
    if (!enabled) return;
    const onPaste = (e: ClipboardEvent) => {
      if (skipWhenDialogOpen && document.querySelector('[role="dialog"]')) return;
      const files = imagesFromPaste(e);
      if (!files.length) return;
      e.preventDefault();
      cb.current(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [enabled, skipWhenDialogOpen]);
}

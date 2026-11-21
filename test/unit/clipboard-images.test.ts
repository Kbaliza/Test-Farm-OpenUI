import { describe, expect, it } from "vitest";
import { imagesFromPaste } from "@/lib/clipboard-images";

const item = (kind: string, type: string, file: File | null) => ({ kind, type, getAsFile: () => file });
const paste = (items: ReturnType<typeof item>[]) => ({ clipboardData: { items } }) as unknown as ClipboardEvent;

describe("pasting a chit", () => {
  it("takes the images and gives each its own name", () => {
    const a = new File(["a"], "image.png", { type: "image/png" });
    const b = new File(["bb"], "image.jpeg", { type: "image/jpeg" });
    const files = imagesFromPaste(paste([item("file", "image/png", a), item("file", "image/jpeg", b)]));
    expect(files.map((f) => f.type)).toEqual(["image/png", "image/jpeg"]);
    expect(files[0].name).toMatch(/^pasted-\d{14}\.png$/);
    expect(files[1].name).toMatch(/^pasted-\d{14}-2\.jpg$/);
    expect(files[1].size).toBe(2);
  });

  it("leaves ordinary text alone", () => {
    expect(imagesFromPaste(paste([item("string", "text/plain", null)]))).toEqual([]);
    expect(imagesFromPaste({ clipboardData: null } as unknown as ClipboardEvent)).toEqual([]);
  });

  it("ignores a file that is not an image", () => {
    const pdf = new File(["%PDF"], "x.pdf", { type: "application/pdf" });
    expect(imagesFromPaste(paste([item("file", "application/pdf", pdf)]))).toEqual([]);
  });
});

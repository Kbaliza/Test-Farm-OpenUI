import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeZip } from "@/lib/zip";
import { billFileName, uniqueNames } from "@/lib/invoice-pdf";
import { fileNameFrom } from "@/lib/download";

// The bill a customer receives is saved under their own name, and a shift comes
// down as a zip of those files. Both are the kind of thing that works on the
// machine it was written on and falls over on somebody else's: a name with a
// bracket or an en dash in it, or a zip a real unzip refuses.

describe("what a downloaded bill is called", () => {
  it("carries the customer, the code and the period", () => {
    expect(
      billFileName({ customerName: "Raja Asim Shahzad", customerCode: "C-1892", periodLabel: "16–30 Sep 2026" }),
    ).toBe("Raja Asim Shahzad (C-1892) — 16–30 Sep 2026.pdf");
  });

  it("drops the characters a filesystem will not take", () => {
    const name = billFileName({
      customerName: 'Shop "A/B" <main>: 40%\\50',
      customerCode: "C-1",
      periodLabel: "1–15 Sep 2026",
    });
    // None of the Windows-reserved set survives, and no run of spaces either.
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name).not.toMatch(/ {2}/);
    expect(name.endsWith(".pdf")).toBe(true);
  });

  it("still produces a usable name when the customer has none", () => {
    expect(billFileName({ customerName: "   ", customerCode: "", periodLabel: "" })).toBe("Customer.pdf");
  });

  it("stays short enough for a filesystem even in UTF-8", () => {
    const name = billFileName({
      customerName: "نور ".repeat(80),
      customerCode: "C-9",
      periodLabel: "16–30 Sep 2026",
    });
    expect(Buffer.byteLength(name, "utf8")).toBeLessThan(255);
  });

  it("two customers with one name do not overwrite each other", () => {
    expect(uniqueNames(["Ali.pdf", "Ali.pdf", "Bilal.pdf", "Ali.pdf"])).toEqual([
      "Ali.pdf",
      "Ali (2).pdf",
      "Bilal.pdf",
      "Ali (3).pdf",
    ]);
  });

  it("matches names case-insensitively, the way Windows does", () => {
    expect(uniqueNames(["Ali.pdf", "ALI.pdf"])).toEqual(["Ali.pdf", "ALI (2).pdf"]);
  });
});

describe("the name travels back from the server intact", () => {
  it("is read from the encoded header, dashes and brackets and all", () => {
    const name = "Raja Asim Shahzad (C-1892) — 16–30 Sep 2026.pdf";
    const header = `attachment; filename="Raja Asim Shahzad (C-1892) _ 16_30 Sep 2026.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`;
    expect(fileNameFrom(header)).toBe(name);
  });

  it("falls back to the plain name when there is no encoded one", () => {
    expect(fileNameFrom('attachment; filename="Bills.zip"')).toBe("Bills.zip");
  });

  it("gives nothing rather than guessing when the header is absent", () => {
    expect(fileNameFrom(null)).toBeNull();
  });
});

describe("the zip a whole shift comes down as", () => {
  const entries = [
    { name: "Raja Asim Shahzad (C-1892) — 16–30 Sep 2026.pdf", data: Buffer.from("%PDF-1.4 first\n") },
    { name: "Nūr Fatima (C-2106) — 16–30 Sep 2026.pdf", data: Buffer.from("%PDF-1.4 second, longer\n") },
  ];

  it("a real unzip reads it back, names and contents unchanged", () => {
    const zip = makeZip(entries);
    const dir = mkdtempSync(join(tmpdir(), "bills-zip-"));
    const path = join(dir, "bills.zip");
    writeFileSync(path, zip);

    // PowerShell's Expand-Archive is the .NET zip reader: an implementation with
    // no knowledge of how this file was written, which is the only kind of witness
    // worth having for a container format.
    execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath '${path}' -DestinationPath '${join(dir, "out")}' -Force`,
    ], { stdio: "pipe" });

    const out = join(dir, "out");
    const found = readdirSync(out).sort();
    expect(found).toEqual(entries.map((e) => e.name).sort());
    for (const e of entries) {
      expect(readFileSync(join(out, e.name)).toString()).toBe(e.data.toString());
    }
  }, 60_000);

  it("is a zip by its magic number, and ends with the central directory", () => {
    const zip = makeZip(entries);
    expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304"); // local file header
    // End-of-central-directory signature, and it claims both entries.
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(2);
  });

  it("an empty zip is still a valid one", () => {
    const zip = makeZip([]);
    expect(zip.length).toBe(22);
    expect(zip.readUInt32LE(0)).toBe(0x06054b50);
    expect(zip.readUInt16LE(10)).toBe(0);
  });

  it("stores rather than compresses, so a PDF is not squeezed twice", () => {
    const data = Buffer.from("A".repeat(5000)); // trivially compressible
    const zip = makeZip([{ name: "a.pdf", data }]);
    expect(zip.readUInt16LE(8)).toBe(0);                    // method 0 = stored
    expect(zip.readUInt32LE(18)).toBe(data.length);          // compressed size
    expect(zip.readUInt32LE(22)).toBe(data.length);          // and uncompressed
    expect(zip.length).toBeGreaterThan(data.length);
  });

  it("flags the names as UTF-8, or the dashes come back as rubbish", () => {
    const zip = makeZip(entries);
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800);
  });
});

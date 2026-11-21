// A zip file, stored not compressed.
//
// Written out here rather than pulled in as a dependency for two reasons. A PDF is
// already compressed, so deflating one again costs real CPU for a percent or two —
// "store" is the right method, and it is the simplest half of the format. And the
// published types for the obvious library do not describe its callable export, so
// using it means fighting the compiler over a container format that is sixty lines
// of well-specified structure.
//
// Store-only, no ZIP64: entries are single bills of tens of kilobytes and the
// archive is one shift, so nothing here approaches the 4GB fields. Names are
// written UTF-8 with the language-encoding flag set, which is what lets a customer
// called "Raja Asim Shahzad — 16–30 Sep 2026.pdf" survive the round trip.

import { crc32 } from "node:zlib";

export type ZipEntry = { name: string; data: Buffer };

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
/** Bit 11: the name and comment are UTF-8. */
const UTF8_FLAG = 0x0800;
/** 2.0 — the floor for a plain stored entry. */
const VERSION = 20;

/** MS-DOS packed date and time, which is what the format stores. */
function dosStamp(d: Date): { time: number; date: number } {
  // Pre-1980 cannot be represented; clamp rather than write a negative year.
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Build a zip holding each entry verbatim.
 *
 * Everything is buffered, which is fine at this size and keeps the whole thing a
 * pure function: the same entries always give byte-identical output for a given
 * timestamp, which is what makes it testable.
 */
export function makeZip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosStamp(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const sum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);           // method 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18); // compressed size == the data itself
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // no extra field
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION, 4);    // version made by
    central.writeUInt16LE(VERSION, 6);    // version needed
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk number
    central.writeUInt16LE(0, 36);         // internal attributes
    central.writeUInt32LE(0, 38);         // external attributes
    central.writeUInt32LE(offset, 42);    // where this entry's local header is
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(0, 4);                       // this disk
  end.writeUInt16LE(0, 6);                       // disk holding the directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);                 // directory starts after the data
  end.writeUInt16LE(0, 20);                      // no archive comment

  return Buffer.concat([...locals, directory, end]);
}

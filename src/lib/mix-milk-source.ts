// Where the milk for a mix batch came from.
//
// Mix milk is made at packaging, and until now it could only draw on milk
// dispatched there that same day. Milk already sitting in inventory was invisible
// to the form even though it is just as mixable, so a batch had to wait for a
// dispatch. Both sources are now offered — but they are NOT interchangeable
// downstream, so each portion is written with its own reason:
//
//   • the packaging portion reduces what that load can forward on (it never
//     reaches storage), and is what the arrival screen docks a load for — so it
//     is drawn on LAST, only once inventory is exhausted;
//   • the storage portion comes out of on-hand stock, so it has to be subtracted
//     from the inventory figure instead — otherwise the same 44 L could be mixed
//     again tomorrow, and every day after that.
//
// Pure, so the form, the save path and the tests all split it identically.

/** Milk taken from today's dispatch to packaging. */
export const MIX_REASON_PACKAGING = "Mix milk processing";
/** Milk taken from inventory on-hand stock. */
export const MIX_REASON_STORAGE = "Mix milk processing (storage)";

/** Both, for the queries that need to exclude every mix-milk movement. */
export const MIX_REASONS = [MIX_REASON_PACKAGING, MIX_REASON_STORAGE] as const;

export type MixSourceSplit = { fromPackaging: number; fromStorage: number };

/**
 * Split a requested quantity across the two pools, STORAGE first.
 *
 * Stock already in inventory is the older milk, so mixing consumes that before it
 * touches anything dispatched today — and today's milk carries on to distribution
 * fresh instead of being mixed away. This was the other way round at first, on the
 * argument that the freshest milk should be mixed; using the oldest first is the
 * ordinary way to run a perishable, and it is what the farm asked for.
 *
 * Two things follow, both intended. The packaging figure no longer moves when a
 * batch is mixed against a healthy inventory, and a load is docked less at
 * arrival, because mixing is no longer eating milk that was on its way out.
 *
 * Anything beyond both pools is left unallocated — the caller rejects that case
 * rather than quietly mixing milk that does not exist.
 */
export function splitMixSource(
  requested: number,
  packagingAvailable: number,
  storageAvailable: number
): MixSourceSplit {
  const want = Math.max(0, requested);
  const fromStorage = Math.min(want, Math.max(0, storageAvailable));
  const fromPackaging = Math.min(want - fromStorage, Math.max(0, packagingAvailable));
  return {
    fromPackaging: Math.round(fromPackaging * 1000) / 1000,
    fromStorage: Math.round(fromStorage * 1000) / 1000,
  };
}

/** Everything mixable right now: today's dispatch plus what is in inventory. */
export function totalMixable(packagingAvailable: number, storageAvailable: number): number {
  return Math.max(0, packagingAvailable) + Math.max(0, storageAvailable);
}

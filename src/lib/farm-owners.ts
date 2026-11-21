// The farm's owners, and where the money they put in lands.
//
// Sajjad and Moiz sometimes pay farm costs out of their own personal accounts.
// That money is recorded as an OwnerContribution: it credits a payment head, and
// the farm owes them it back. It is a LIABILITY, never income — the farm did not
// earn it, so nothing in reports or profit may read it.
//
// A plain list rather than a Prisma enum on purpose: adding a third partner is a
// one-line change here with no migration, and both the browser and the server can
// import it (this file has no "server-only" and no database import).

export type FarmOwner = { id: string; name: string };

export const FARM_OWNERS: FarmOwner[] = [
  { id: "SAJJAD", name: "Sajjad" },
  { id: "MOIZ", name: "Moiz" },
];

export const FARM_OWNER_IDS: string[] = FARM_OWNERS.map((o) => o.id);

/** The head owner funding always lands in. Fixed by the owners' own instruction:
 *  it is never selectable, so there is one place to change it and one to read it. */
export const OWNER_FUNDING_HEAD = "HBL";

export function isFarmOwner(id: string): boolean {
  return FARM_OWNER_IDS.includes(id);
}

export function ownerName(id: string): string {
  return FARM_OWNERS.find((o) => o.id === id)?.name ?? id;
}

/** How a contribution reads wherever it is listed — one wording, used by the
 *  transfers list, the HBL head ledger and the owner's own ledger. */
export function ownerFundingLabel(id: string): string {
  return `${ownerName(id)} — personal account`;
}

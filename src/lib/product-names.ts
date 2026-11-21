// Product-name matching helpers.
//
// The catalog spells the product "Yogurt", while the code was written against
// "Yoghurt". Several places matched on the substring "yogh", which never matches
// "Yogurt" — so the Yoghurt page could not find its own product, yoghurt leaked
// into the packaging dispatch chain, and the reconciliation Balance columns split
// on the wrong set. One helper here so that mismatch can only ever be fixed once.

/** True for either spelling: "Yogurt" (catalog) or "Yoghurt" (code/UI copy). */
export function isYoghurtName(name: string): boolean {
  return /yogh?urt/i.test(name);
}

/**
 * Prisma `where` fragment for "the active product whose name contains `term`".
 *
 * Catalog names do not match the labels the code grew up with — the buffalo
 * product is called "Pure Buffalo", not "Buffalo Milk". Matching on a substring
 * is what the mix-milk and skim-milk flows already do and why they kept working;
 * the yoghurt page used an exact `equals` and broke. Use this everywhere a milk
 * product is looked up by name so a rename cannot silently take a page down.
 */
export function activeProductNameContains(term: string) {
  // retailOnly products are bought-in goods with no stock behind them. They must
  // never satisfy a milk lookup, or naming one "Cow Pack" would quietly hand the
  // packaging pipeline a product it cannot draw on.
  return { active: true, retailOnly: false, name: { contains: term, mode: "insensitive" as const } };
}

/** True for any ghee product — the catalog calls it "Desi Ghee" while the code
 *  was written against a bare "Ghee". Ghee is always bought in over the counter,
 *  never produced at the farm, so it must not appear on the production page. */
export function isEggName(name: string): boolean {
  return /egg/i.test(name);
}

/** True for any ghee product — the catalog calls it "Desi Ghee" while the code
 *  was written against a bare "Ghee". Ghee is always bought in over the counter,
 *  never produced at the farm, so it must not appear on the production page. */
export function isGheeName(name: string): boolean {
  return /ghee/i.test(name);
}

/**
 * Where a product sits in the rider's loading order: cow milk first, then mix,
 * then buffalo, then everything else.
 *
 * That is the order the milk is actually loaded in, so the shift load summary
 * reads the way the van is packed rather than in whatever order the customers
 * happened to be entered. Anything that is not one of the three — eggs, yoghurt,
 * ghee, cream — sorts after them and keeps its existing unit order.
 *
 * Matched on a substring for the same reason as activeProductNameContains: the
 * buffalo product is called "Pure Buffalo", with no "milk" in the name at all.
 * "Skim Milk" is deliberately not one of the three and falls to the end.
 */
export function milkLoadOrder(name: string): number {
  if (/cow/i.test(name)) return 0;
  if (/mix/i.test(name)) return 1;
  if (/buffalo/i.test(name)) return 2;
  return 3;
}

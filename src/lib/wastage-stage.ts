/**
 * Which wastage is charged against the FARM's production for a day.
 *
 * Milk that goes to packaging on a FarmDispatch has left the farm, and the day's
 * arithmetic already counts that dispatch as used. So whatever is then spilled,
 * sealed wrong, written off at Retail or brought back damaged by a rider is milk
 * that has ALREADY been accounted for — counting it a second time as "used" takes
 * the same litres off the farm's day twice.
 *
 * That is what it was doing. On 5 October, Cow Milk showed 574.5 L produced and
 * 753.2 L used, so the farm's own day was 178.7 L in deficit and the calf-use form
 * refused a 16 L entry it should never have been asked about: the whole 574.5 L had
 * been dispatched, and the 178.7 L on top was wastage recorded at Packaging, Retail
 * and on a rider's van.
 *
 * getDayProductionUsage already reasons this way about mix milk and buffalo
 * standardising — "consumed at packaging out of what was already dispatched, so it
 * is counted there". Wastage was simply missed.
 *
 * Stated as what DOES count rather than what does not, so a stage nobody has
 * thought of yet stays strict instead of quietly becoming free:
 *
 *   stage "Production"  the farm's own loss, before anything was dispatched
 *   stage null          the farm's wastage form writes no stage at all
 *
 * Everything else — Packaging, Retail, Yoghurt, Riders, Rider return, Retail
 * return — happens downstream of a dispatch.
 */
export const FARM_WASTE_STAGE = "Production";

export function isFarmWastage(stage: string | null | undefined): boolean {
  return stage == null || stage === FARM_WASTE_STAGE;
}

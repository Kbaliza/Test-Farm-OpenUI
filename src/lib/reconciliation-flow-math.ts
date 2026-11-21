// The milk flow on the Production Reconciliation page, farm to customer, as one
// piece of arithmetic.
//
// Pure and framework-free so the page and the tests run the SAME sums. Every
// input is a litre total read from a record (see getReconciliationSummary); every
// output is one of those, or a difference between two of them. Nothing here is
// estimated, shared out or filled in.
//
// The chain, and where each figure comes from:
//
//   produced + bought in                       = total available
//   − calves − kitchen − skim − farm wastage   = supposed to reach packaging
//   received at packaging (farm loads accepted + bought in)
//     the gap to "supposed" is milk that left the farm's figures and never
//     arrived: not sent, sent but never accepted, or short on a disputed load
//   − packing wastage                          = packed
//   − yoghurt (drawn from inventory) − counter sales
//   given to Retail — the rest is inventory movement, NOT a loss: packaging
//     keeps stock, so a day can send less than it packed (kept) or more
//     (drawn from stock already there)
//   − Retail wastage − riders' loads           = Retail's leftover, which goes
//     back to inventory at the end of the day (below zero: the riders took
//     more than Retail had — flagged, never counted as a loss)
//   riders' loads − delivered + customer returns − road wastage
//                                              = supposed to come back
//   supposed − handed back                     = missing on the round
//
// Collective loss = every litre written off + every litre missing. A gap that
// runs the other way (more arrived than was expected) is shown, but never
// subtracted from the loss: a surplus in one place does not find milk that went
// missing in another.

export type WasteBucket = "farm" | "packaging" | "retail" | "road" | "riderReturn" | "other";

export const WASTE_BUCKET_LABEL: Record<WasteBucket, string> = {
  farm: "Wasted at farm",
  packaging: "Wasted at packing",
  retail: "Wasted at Retail",
  road: "Wasted on the round",
  riderReturn: "Rider returns — wasted",
  other: "Other wastage",
};

/** Litre totals for the range, already added up across the milk products. */
export type FlowInputs = {
  produced: number;
  purchased: number;
  calfUse: number;
  kitchenUse: number;
  skimUse: number;
  /** Milk taken out of INVENTORY to make yoghurt — after packaging, not at the farm. */
  yoghurtUse: number;
  /** Sold over the counter, out of inventory. */
  counterSale: number;
  /** What the farm's loads put into inventory (ARRIVED, accepted at packaging). */
  farmAccepted: number;
  /**
   * Milk taken off a load at packaging for mix / standardising before it was
   * accepted. It reached inventory as the product it was made into, so it is
   * part of what packaging received.
   */
  packagingTransformUse: number;
  /** Declared on the loads whose acceptance is counted in farmAccepted. */
  farmDeclaredAccepted: number;
  /** Declared on loads sent in the range and never accepted. */
  farmPending: number;
  toRetail: number;
  riderLoad: number;
  delivered: number;
  /** Charged on a stop the rider marked skipped — the milk stayed on the van. */
  chargedBack: number;
  customerReturns: number;
  returned: number;
  waste: Record<WasteBucket, number>;
};

export type MissingPart = { key: string; label: string; how: string; amount: number };

export type MilkFlow = {
  produced: number;
  purchased: number;
  available: number;
  calfUse: number;
  kitchenUse: number;
  skimUse: number;
  farmUse: number;
  supposedToPack: number;
  received: number;
  farmAccepted: number;
  packagingTransformUse: number;
  /** supposedToPack − received. Signed: below zero, more arrived than expected. */
  acceptGap: number;
  acceptParts: MissingPart[];
  packed: number;
  yoghurtUse: number;
  counterSale: number;
  toRetail: number;
  /** packed − yoghurt − counter sales − toRetail. Signed. Inventory, not a loss. */
  inventoryDifference: number;
  riderLoad: number;
  /** toRetail − Retail wastage − riderLoad. Signed. Back to inventory, not a loss. */
  retailLeftover: number;
  delivered: number;
  chargedBack: number;
  customerReturns: number;
  supposedReturn: number;
  returned: number;
  /** supposedReturn − returned. Signed: below zero, more came back than was due. */
  riderGap: number;
  waste: Record<WasteBucket, number>;
  wasteTotal: number;
  /** Positive gaps only — the litres nobody can account for. */
  missingParts: MissingPart[];
  missingTotal: number;
  collectiveLoss: number;
  /** Collective loss as a share of everything available, 0–100, one decimal. */
  lossPct: number;
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const BUCKETS: WasteBucket[] = ["farm", "packaging", "retail", "road", "riderReturn", "other"];

export function milkFlow(i: FlowInputs): MilkFlow {
  const waste = Object.fromEntries(BUCKETS.map((b) => [b, r3(i.waste[b] ?? 0)])) as Record<WasteBucket, number>;
  const wasteTotal = r3(BUCKETS.reduce((t, b) => t + waste[b], 0));

  const available = r3(i.produced + i.purchased);
  const farmUse = r3(i.calfUse + i.kitchenUse + i.skimUse);
  const supposedToPack = r3(available - farmUse - waste.farm);
  const received = r3(i.farmAccepted + i.packagingTransformUse + i.purchased);
  const acceptGap = r3(supposedToPack - received);

  // The same gap, taken apart along the farm's loads. The three parts add up to
  // acceptGap exactly: (produced − farm use − farm waste − declared − pending)
  // + pending + (declared − accepted) = what the farm had − what arrived.
  const farmHad = r3(i.produced - farmUse - waste.farm);
  const acceptedIn = r3(i.farmAccepted + i.packagingTransformUse);
  const acceptParts: MissingPart[] = [
    {
      key: "not-sent", label: "Not sent to packaging",
      how: "produced − calves, kitchen, skim and farm wastage − what the farm's loads declared",
      amount: r3(farmHad - i.farmDeclaredAccepted - i.farmPending),
    },
    {
      key: "pending", label: "Sent, never accepted",
      how: "loads the farm sent in these dates that packaging has not accepted",
      amount: r3(i.farmPending),
    },
    {
      key: "short-load", label: "Short when packaging accepted",
      how: "declared on the farm's loads − what packaging accepted from them",
      amount: r3(i.farmDeclaredAccepted - acceptedIn),
    },
  ];

  const packed = r3(received - waste.packaging);
  const inventoryDifference = r3(packed - i.yoghurtUse - i.counterSale - i.toRetail);
  const retailLeftover = r3(i.toRetail - waste.retail - i.riderLoad);
  const supposedReturn = r3(i.riderLoad - i.delivered + i.customerReturns - waste.road);
  const riderGap = r3(supposedReturn - i.returned);

  const missingParts: MissingPart[] = [];
  if (acceptGap > 0.0005) {
    missingParts.push({ key: "accept", label: "Missing before packaging", how: "supposed to be packed − received at packaging", amount: acceptGap });
  }
  if (riderGap > 0.0005) {
    missingParts.push({ key: "rider", label: "Missing on the rounds", how: "riders' loads − delivered + customer returns − road wastage − handed back", amount: riderGap });
  }
  const missingTotal = r3(missingParts.reduce((t, p) => t + p.amount, 0));
  const collectiveLoss = r3(wasteTotal + missingTotal);

  return {
    produced: r3(i.produced), purchased: r3(i.purchased), available,
    calfUse: r3(i.calfUse), kitchenUse: r3(i.kitchenUse), skimUse: r3(i.skimUse), farmUse,
    supposedToPack, received, farmAccepted: r3(i.farmAccepted), packagingTransformUse: r3(i.packagingTransformUse),
    acceptGap, acceptParts,
    packed, yoghurtUse: r3(i.yoghurtUse), counterSale: r3(i.counterSale), toRetail: r3(i.toRetail),
    inventoryDifference, riderLoad: r3(i.riderLoad), retailLeftover,
    delivered: r3(i.delivered), chargedBack: r3(i.chargedBack), customerReturns: r3(i.customerReturns),
    supposedReturn, returned: r3(i.returned), riderGap,
    waste, wasteTotal, missingParts, missingTotal, collectiveLoss,
    lossPct: available > 0 ? Math.round((collectiveLoss / available) * 1000) / 10 : 0,
  };
}

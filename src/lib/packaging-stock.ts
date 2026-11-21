// How packaging moves stock (browser- and server-safe constants).
//
//   1. Packaging ACCEPTS a load from production → the accepted quantities go into
//      inventory at once: an ARRIVED movement per product, reason
//      ACCEPTED_AT_PACKAGING, reference = the production load.
//   2. Buffalo standardising and mix milk work on inventory: what they use comes
//      out of it (the "(storage)" reasons), and what they make goes back in
//      (PRODUCED rows counted by getOnHandComponents from the day packaging first
//      accepted a load this way — older rows belong to the old flow).
//   3. SEND TO RETAIL reads inventory and is capped at it. It records the send
//      (a RetailDispatch plus a DISPATCHED movement per product, reason
//      SENT_TO_RETAIL); the milk is already counted in inventory, so the send
//      does not add it again. Retail only confirms receipt, and a shortfall is
//      written off (WASTAGE, stage "Retail").

export const ACCEPTED_AT_PACKAGING = "Accepted at packaging";
/** ARRIVED reason for eggs added at packaging — into inventory, like an accepted load. */
export const EGGS_COLLECTED = "Eggs collected at packaging";
export const SENT_TO_RETAIL = "Packaging to Retail";
